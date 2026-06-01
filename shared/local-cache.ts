const CACHE_PREFIX = "bangumini-http-";

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { data: T; cachedAt: number };
    return cached.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T) {
  localStorage.setItem(
    `${CACHE_PREFIX}${key}`,
    JSON.stringify({ data, cachedAt: Date.now() }),
  );
}

export function clearCache(key: string) {
  localStorage.removeItem(`${CACHE_PREFIX}${key}`);
}
