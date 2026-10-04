import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  deleteCachedImage,
  isUsefulImageUrl,
  readCachedImage,
  writeCachedImage,
} from "@shared/storage/sqlite-cache";

type CacheImageResult = {
  local_path: string;
};

type CachedImageProps = {
  src: string;
  alt?: string;
  className?: string;
  loading?: "eager" | "lazy";
};

const inFlightImageCache = new Map<string, Promise<string>>();
// 页面切换会卸载列表行；保留本次进程已经解析过的本地路径，避免每次重新查 SQLite。
const resolvedImagePathCache = new Map<string, string>();

function getResolvedImage(remoteUrl: string) {
  const localPath = resolvedImagePathCache.get(remoteUrl);
  return localPath
    ? { remoteUrl, displayUrl: convertFileSrc(localPath) }
    : null;
}

function cacheImageOnce(remoteUrl: string) {
  const resolved = resolvedImagePathCache.get(remoteUrl);
  if (resolved) return Promise.resolve(resolved);

  const existing = inFlightImageCache.get(remoteUrl);
  if (existing) return existing;

  const request = invoke<CacheImageResult>("cache_image", { remoteUrl })
    .then((result) => {
      resolvedImagePathCache.set(remoteUrl, result.local_path);
      // 本地路径已经可用，SQLite 持久化放到后台，避免拖慢图片显示。
      void writeCachedImage({
        remoteUrl,
        localPath: result.local_path,
        updatedAt: Date.now(),
      });
      return result.local_path;
    })
    .finally(() => {
      inFlightImageCache.delete(remoteUrl);
    });

  inFlightImageCache.set(remoteUrl, request);
  return request;
}

export default function CachedImage({
  src,
  alt = "",
  className,
  loading = "lazy",
}: CachedImageProps) {
  const [cachedSrc, setCachedSrc] = useState<{
    remoteUrl: string;
    displayUrl: string;
  } | null>(() => getResolvedImage(src));
  const remoteLoadedRef = useRef(false);
  const cacheCheckedRef = useRef(false);
  const cacheWarmStartedRef = useRef(false);
  const memoryResolved = getResolvedImage(src);
  const displaySrc =
    cachedSrc?.remoteUrl === src
      ? cachedSrc.displayUrl
      : memoryResolved?.displayUrl ?? src;

  useEffect(() => {
    remoteLoadedRef.current = false;
    cacheCheckedRef.current = false;
    cacheWarmStartedRef.current = false;

    if (!src) return;

    let cancelled = false;

    const warmLocalCache = (showCachedImage: boolean) => {
      if (cacheWarmStartedRef.current) return;
      cacheWarmStartedRef.current = true;

      void cacheImageOnce(src)
        .then((localPath) => {
          if (cancelled) return;
          if (showCachedImage && !remoteLoadedRef.current) {
            setCachedSrc({
              remoteUrl: src,
              displayUrl: convertFileSrc(localPath),
            });
          }
        })
        .catch(() => {
          // 远程图片仍是可用的 fallback，不阻塞列表渲染。
        });
    };

    async function loadCachedImage() {
      if (!isUsefulImageUrl(src)) {
        setCachedSrc(null);
        return;
      }

      const memoryCached = getResolvedImage(src);
      if (memoryCached) {
        cacheCheckedRef.current = true;
        setCachedSrc(memoryCached);
        return;
      }

      const cached = await readCachedImage(src);
      if (cancelled) return;
      cacheCheckedRef.current = true;

      if (cached?.localPath) {
        resolvedImagePathCache.set(src, cached.localPath);
        // 若远程图已经显示出来，不再切换 src，避免解码抖动。
        if (!remoteLoadedRef.current) {
          setCachedSrc({
            remoteUrl: src,
            displayUrl: convertFileSrc(cached.localPath),
          });
        }
        return;
      }

      // 冷缓存时先让远程图片承担首屏显示，避免缓存下载阻塞用户；
      // 等远程图完成后再在后台落盘，避免两个请求同时抢带宽。
      if (remoteLoadedRef.current) warmLocalCache(false);
    }

    void loadCachedImage();

    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <img
      src={displaySrc}
      alt={alt}
      loading={loading}
      decoding="async"
      className={className}
      onLoad={() => {
        if (displaySrc === src && isUsefulImageUrl(src)) {
          remoteLoadedRef.current = true;
          if (cacheCheckedRef.current && !cacheWarmStartedRef.current) {
            const localPath = cacheImageOnce(src);
            cacheWarmStartedRef.current = true;
            void localPath.catch(() => {});
          }
        }
      }}
      onError={() => {
        if (!isUsefulImageUrl(src)) return;
        if (displaySrc !== src) {
          // 本地文件可能已被清理；删除失效记录，重新走一次代理下载。
          resolvedImagePathCache.delete(src);
          setCachedSrc(null);
        }
        remoteLoadedRef.current = false;
        cacheCheckedRef.current = true;
        cacheWarmStartedRef.current = true;
        const retry =
          displaySrc !== src
            ? deleteCachedImage(src).then(() => cacheImageOnce(src))
            : cacheImageOnce(src);
        void retry
          .then((localPath) => {
            setCachedSrc({
              remoteUrl: src,
              displayUrl: convertFileSrc(localPath),
            });
          })
          .catch(() => {
            // 远程和本地缓存都失败时保留占位背景，避免 broken image 图标闪烁。
          });
      }}
    />
  );
}
