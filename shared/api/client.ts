import type {
  CalendarItem,
  Episode,
  PagedResponse,
  RelatedCharacter,
  RelatedPerson,
  SearchResponse,
  Subject,
  User,
  UserCollection,
} from "./types";

const BASE_URL = "https://api.bgm.tv";

let tokenProvider: (() => Promise<string>) | null = null;

export function setTokenProvider(fn: () => Promise<string>) {
  tokenProvider = fn;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = tokenProvider ? await tokenProvider() : "";
  const headers: Record<string, string> = {
    "User-Agent": "RaycastBangumi/1.0",
    Accept: "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      clearTimeout(timeout);
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("unreachable");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const authHeaders = await getAuthHeaders();
  const headers = { ...authHeaders, ...(options.headers || {}) };

  const res = await fetchWithRetry(url, { ...options, headers });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bangumi API error ${res.status}: ${body}`);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Search Bangumi for an anime subject by name, returns first match */
export async function searchAnimeSubject(keyword: string): Promise<{ id: number; name_cn: string } | null> {
  try {
    const resp = await searchSubjects({ keyword, type: [2], limit: 3 });
    const match = resp.data?.[0];
    return match ? { id: match.id, name_cn: match.name_cn || match.name } : null;
  } catch {
    return null;
  }
}

/** GET /calendar — 每日放送 */
export async function getCalendar(): Promise<CalendarItem[]> {
  return request<CalendarItem[]>("/calendar");
}

/** POST /v0/search/subjects — 条目搜索 */
export async function searchSubjects(params: {
  keyword: string;
  sort?: "match" | "rank" | "date";
  type?: number[];
  limit?: number;
  offset?: number;
}): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    keyword: params.keyword,
    sort: params.sort || "rank",
    limit: params.limit || 30,
  };

  if (params.type && params.type.length > 0) {
    body.filter = { type: params.type };
  }

  return request<SearchResponse>("/v0/search/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /v0/subjects/{id} — 获取条目详情 */
export async function getSubject(id: number): Promise<Subject> {
  return request<Subject>(`/v0/subjects/${id}`);
}

/** GET /v0/me — 获取当前用户信息 */
export async function getMyself(): Promise<User> {
  return request<User>("/v0/me");
}

/** GET /v0/users/{username}/collections — 获取用户收藏 */
export async function getUserCollections(params: {
  username: string;
  subjectType?: number;
  type?: number;
  limit?: number;
  offset?: number;
}): Promise<PagedResponse<UserCollection>> {
  const uname = params.username;

  const searchParams = new URLSearchParams();
  if (params.subjectType) searchParams.set("subject_type", String(params.subjectType));
  if (params.type) searchParams.set("type", String(params.type));
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));

  const qs = searchParams.toString();
  return request<PagedResponse<UserCollection>>(
    `/v0/users/${uname}/collections${qs ? `?${qs}` : ""}`,
  );
}

/** POST /v0/users/-/collections/{subject_id} — 新增或修改收藏 */
export async function postUserCollection(
  subjectId: number,
  data: {
    type?: number;
    rate?: number;
    comment?: string;
    tags?: string[];
    private?: boolean;
  },
): Promise<void> {
  await request(`/v0/users/-/collections/${subjectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** GET /v0/users/{username}/collections/{subject_id} — 获取单个条目收藏状态 */
export async function getUserCollection(
  username: string,
  subjectId: number,
): Promise<UserCollection> {
  return request<UserCollection>(
    `/v0/users/${username}/collections/${subjectId}`,
  );
}

/** GET /v0/subjects/{id}/persons — 获取条目关联人物 */
export async function getSubjectPersons(
  subjectId: number,
): Promise<RelatedPerson[]> {
  return request<RelatedPerson[]>(`/v0/subjects/${subjectId}/persons`);
}

/** GET /v0/subjects/{id}/characters — 获取条目关联角色 */
export async function getSubjectCharacters(
  subjectId: number,
): Promise<RelatedCharacter[]> {
  return request<RelatedCharacter[]>(`/v0/subjects/${subjectId}/characters`);
}

/** GET /v0/episodes — 获取条目剧集列表 */
export async function getEpisodes(subjectId: number): Promise<PagedResponse<Episode>> {
  return request<PagedResponse<Episode>>(
    `/v0/episodes?subject_id=${subjectId}&limit=200`,
  );
}

/** GET /v0/users/{username}/collections — 全量获取用户收藏（处理分页） */
export async function getAllUserCollections(params: {
  username: string;
  type?: number;
}): Promise<PagedResponse<UserCollection>> {
  const result: PagedResponse<UserCollection> = { data: [], total: 0, limit: 100, offset: 0 };

  while (true) {
    const page = await getUserCollections({
      username: params.username,
      type: params.type,
      limit: 100,
      offset: result.data.length,
    });
    result.data.push(...page.data);
    result.total = page.total;
    if (result.data.length >= page.total) break;
  }

  return result;
}

/** PATCH /v0/users/-/collections/{subject_id}/episodes — 批量更新剧集收藏状态 */
export async function patchSubjectEpisodes(
  subjectId: number,
  data: { episode_id: number[]; type: number },
): Promise<void> {
  await request(`/v0/users/-/collections/${subjectId}/episodes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
