import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
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

export default function CachedImage({
  src,
  alt = "",
  className,
  loading = "lazy",
}: CachedImageProps) {
  const [cachedSrc, setCachedSrc] = useState<{ remoteUrl: string; displayUrl: string } | null>(null);
  const displaySrc = cachedSrc?.remoteUrl === src ? cachedSrc.displayUrl : src;

  useEffect(() => {
    if (!src) return;

    let cancelled = false;

    async function loadCachedImage() {
      const cached = await readCachedImage(src);
      if (cancelled) return;

      if (cached?.localPath) {
        setCachedSrc({ remoteUrl: src, displayUrl: convertFileSrc(cached.localPath) });
        return;
      }

      try {
        const result = await invoke<CacheImageResult>("cache_image", { remoteUrl: src });
        if (cancelled) return;

        await writeCachedImage({
          remoteUrl: src,
          localPath: result.local_path,
          updatedAt: Date.now(),
        });
        setCachedSrc({ remoteUrl: src, displayUrl: convertFileSrc(result.local_path) });
      } catch {
        if (!cancelled) setCachedSrc(null);
      }
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
      className={className}
      onError={() => {
        if (displaySrc !== src) setCachedSrc(null);
      }}
    />
  );
}
