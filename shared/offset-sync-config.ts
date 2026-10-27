export type WebDavOffsetSyncConfig = {
  provider: "webdav";
  autoSync: boolean;
  prefix: string;
  url: string;
  username: string;
  password: string;
};

export type S3OffsetSyncConfig = {
  provider: "s3";
  autoSync: boolean;
  prefix: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
};

export type OffsetSyncConfig = WebDavOffsetSyncConfig | S3OffsetSyncConfig;

export const DEFAULT_OFFSET_SYNC_PREFIX = "bangumini";

/** 远端路径统一供手机、桌面与不同存储协议使用。 */
export function offsetSyncObjectKey(prefix: string, account: string): string {
  // eslint-disable-next-line no-control-regex -- 协议要求拒绝 ASCII 控制字符，不能放宽路径校验。
  if (!account || account.length > 128 || /[\u0000-\u001f/\\]/.test(account)) {
    throw new Error("Bangumi 账号标识无效");
  }
  return `${normalizeOffsetSyncPrefix(prefix)}/accounts/${encodeURIComponent(account)}/airing-offsets.v1.json`;
}

export function normalizeOffsetSyncPrefix(prefix: string): string {
  if (typeof prefix !== "string") throw new Error("存储目录配置无效");
  const value = prefix.trim().replace(/^\/+|\/+$/g, "");
  // eslint-disable-next-line no-control-regex -- 目录不得包含路径跳转或 ASCII 控制字符。
  if (!value || value.length > 512 || value.split("/").some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\\?#%]/.test(part))) {
    throw new Error("存储目录不能为空，也不能包含路径跳转、百分号或查询参数");
  }
  return value;
}

function secureEndpoint(raw: string): string {
  if (typeof raw !== "string") throw new Error("存储地址配置无效");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("请输入完整的 HTTPS 存储地址"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("存储地址必须使用 HTTPS，且不能包含凭证、查询参数或片段");
  }
  return url.toString().replace(/\/+$/, "");
}

export function normalizeOffsetSyncConfig(input: OffsetSyncConfig): OffsetSyncConfig {
  if (!input || typeof input !== "object") throw new Error("同步配置无效");
  const prefix = normalizeOffsetSyncPrefix(input.prefix);
  if (typeof input.autoSync !== "boolean") throw new Error("自动同步配置无效");
  if (input.provider === "webdav") {
    if (typeof input.username !== "string" || !input.username.trim() || typeof input.password !== "string" || !input.password) throw new Error("请填写 WebDAV 用户名和密码");
    return { provider: "webdav", autoSync: input.autoSync, prefix, url: secureEndpoint(input.url), username: input.username.trim(), password: input.password };
  }
  if (input.provider !== "s3") throw new Error("不支持的存储类型");
  if (typeof input.bucket !== "string" || typeof input.region !== "string" || typeof input.accessKeyId !== "string" || typeof input.secretAccessKey !== "string" || (input.sessionToken !== undefined && typeof input.sessionToken !== "string") || typeof input.forcePathStyle !== "boolean") throw new Error("S3 配置无效");
  const bucket = input.bucket.trim();
  // eslint-disable-next-line no-control-regex -- Bucket 名称中的 ASCII 控制字符必须被拒绝。
  if (!bucket || bucket.length > 255 || /[\s/\\?#\u0000-\u001f]/.test(bucket)) throw new Error("请填写有效的 S3 Bucket 名称");
  if (!input.region.trim() || !input.accessKeyId.trim() || !input.secretAccessKey) throw new Error("请填写 S3 Region、Access Key ID 和 Secret Access Key");
  return {
    provider: "s3", autoSync: input.autoSync, prefix, endpoint: secureEndpoint(input.endpoint), region: input.region.trim(), bucket,
    accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey,
    ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}), forcePathStyle: Boolean(input.forcePathStyle),
  };
}

/** 密钥轮换不改变基线；不同账号、存储位置与 WebDAV 登录身份不能共用同步基线。 */
export function offsetSyncTargetKey(input: OffsetSyncConfig, account: string): string {
  const config = normalizeOffsetSyncConfig(input);
  return JSON.stringify(config.provider === "webdav"
    ? ["webdav", config.url, config.username, offsetSyncObjectKey(config.prefix, account)]
    : ["s3", config.endpoint, config.region, config.bucket, config.forcePathStyle, offsetSyncObjectKey(config.prefix, account)]);
}
