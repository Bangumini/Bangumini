import { invoke } from "@tauri-apps/api/core";
import { normalizeOffsetSyncConfig, type OffsetSyncConfig } from "../../shared/offset-sync-config";

export type SecureConfigDeps = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  hash(value: string): Promise<string>;
  randomId(): string;
};
type Manifest = { version: 1; generation: string; count: number };

/** 配置与凭证全部进入安全存储；分块并最后切换索引，避免超长值或半次保存破坏旧配置。 */
export function createOffsetSyncConfigStore(deps: SecureConfigDeps) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const prefix = async (account: string) => {
    if (typeof account !== "string" || !account || account.length > 128) throw new Error("同步账号标识无效");
    return `bangumini_offset_sync.${await deps.hash(account)}`;
  };
  const parseManifest = (raw: string | null): Manifest | null => {
    if (raw === null) return null;
    const value = JSON.parse(raw) as Manifest;
    if (value?.version !== 1 || typeof value.generation !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.generation) || !Number.isInteger(value.count) || value.count < 1 || value.count > 64) {
      throw new Error("无效的安全配置索引");
    }
    return value;
  };
  const removeChunks = async (key: string, manifest: Manifest) => {
    await Promise.allSettled(Array.from({ length: manifest.count }, (_, index) => deps.deleteItem(`${key}.${manifest.generation}.${index}`)));
  };
  return {
    get(account: string): Promise<OffsetSyncConfig | null> {
      return serial(async () => {
        try {
          const key = await prefix(account);
          const manifest = parseManifest(await deps.getItem(`${key}.head`));
          if (!manifest) return null;
          const chunks = await Promise.all(Array.from({ length: manifest.count }, (_, index) => deps.getItem(`${key}.${manifest.generation}.${index}`)));
          if (chunks.some(chunk => chunk === null)) throw new Error("安全配置不完整");
          const parsed = JSON.parse(chunks.join("")) as { version: number; config: OffsetSyncConfig };
          if (parsed?.version !== 1) throw new Error("不支持的安全配置版本");
          return normalizeOffsetSyncConfig(parsed.config);
        } catch { throw new Error("无法读取安全存储中的同步配置，请重新保存配置或断开同步"); }
      });
    },
    set(account: string, input: OffsetSyncConfig): Promise<void> {
      return serial(async () => {
        const config = normalizeOffsetSyncConfig(input);
        const text = JSON.stringify({ version: 1, config });
        const characters = Array.from(text);
        if (characters.length > 384 * 64) throw new Error("同步配置过长，请缩短地址、目录或凭证");
        // 每块最多 384 Unicode 字符 / 1536 UTF-8 bytes，低于原生 2000B 安全上限。
        const chunks = Array.from({ length: Math.ceil(characters.length / 384) }, (_, index) => characters.slice(index * 384, (index + 1) * 384).join(""));
        let key: string | undefined;
        let old: Manifest | null = null;
        const manifest: Manifest = { version: 1, generation: deps.randomId(), count: chunks.length };
        try {
          key = await prefix(account);
          try { old = parseManifest(await deps.getItem(`${key}.head`)); } catch { /* 允许显式保存修复损坏的索引。 */ }
          for (let index = 0; index < chunks.length; index++) await deps.setItem(`${key}.${manifest.generation}.${index}`, chunks[index]);
          await deps.setItem(`${key}.head`, JSON.stringify(manifest));
        } catch {
          // 旧索引保持不变；尽力清理不可见的新块，清理失败也不能发布半份配置。
          if (key) await removeChunks(key, manifest);
          throw new Error("同步配置保存失败，原配置未改变；请检查 Windows 安全凭证存储后重试");
        }
        if (old && key) await removeChunks(key, old);
      });
    },
    delete(account: string): Promise<void> {
      return serial(async () => {
        try {
          const key = await prefix(account);
          let old: Manifest | null = null;
          try { old = parseManifest(await deps.getItem(`${key}.head`)); } catch { /* 损坏的索引也能断开。 */ }
          await deps.deleteItem(`${key}.head`);
          if (old) await removeChunks(key, old);
        } catch { throw new Error("无法删除安全存储中的同步配置，请重试"); }
      });
    },
  };
}

/** 浏览器 / 非 Windows 由原生命令明确拒绝；不提供明文降级存储。 */
export const offsetSyncConfigStore = createOffsetSyncConfigStore({
  getItem: key => invoke<string | null>("offset_sync_credential_get", { key }),
  setItem: (key, value) => invoke("offset_sync_credential_set", { key, value }),
  deleteItem: key => invoke("offset_sync_credential_delete", { key }),
  hash: async value => {
    if (!value) throw new Error("同步账号不能为空");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  },
  randomId: () => crypto.randomUUID(),
});
