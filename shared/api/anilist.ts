const BASE_URL = "https://graphql.anilist.co";

let fetchFn: typeof fetch = fetch;

export function setFetchFunction(fn: typeof fetch) {
  fetchFn = fn;
}

const AIRING_QUERY = `query ($search: String!) {
  Page(page: 1, perPage: 1) {
    media(search: $search, type: ANIME) {
      id
      nextAiringEpisode { airingAt episode }
    }
  }
}`;
const AIRING_REQUEST_TIMEOUT = 8000;
const AIRING_MAX_ATTEMPTS = 3;

interface AniListResponse {
  data?: {
    Page?: {
      media?: {
        id: number;
        nextAiringEpisode: { airingAt: number; episode: number } | null;
      }[];
    };
  };
  errors?: { message?: string }[];
}

export type AiringLookupResult =
  | {
      status: "scheduled";
      value: { airingAt: number; episode: number };
    }
  | { status: "no_schedule" }
  | { status: "not_found" }
  | {
      status: "network_error";
      retryable: boolean;
      message: string;
    };

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return 750 * 2 ** attempt;
}

export async function getAiringAt(title: string): Promise<AiringLookupResult> {
  let lastMessage = "AniList request failed";

  for (let attempt = 0; attempt < AIRING_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      AIRING_REQUEST_TIMEOUT,
    );

    try {
      const res = await fetchFn(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: AIRING_QUERY,
          variables: { search: title },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        lastMessage = `AniList HTTP ${res.status}`;
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt + 1 < AIRING_MAX_ATTEMPTS) {
          await delay(getRetryDelay(res, attempt));
          continue;
        }
        return { status: "network_error", retryable, message: lastMessage };
      }

      const json = (await res.json()) as AniListResponse;
      if (json.errors?.length) {
        lastMessage = json.errors[0]?.message || "AniList GraphQL error";
        if (attempt + 1 < AIRING_MAX_ATTEMPTS) {
          await delay(750 * 2 ** attempt);
          continue;
        }
        return {
          status: "network_error",
          retryable: true,
          message: lastMessage,
        };
      }

      const media = json.data?.Page?.media?.[0];
      if (!media) return { status: "not_found" };
      if (!media.nextAiringEpisode) return { status: "no_schedule" };

      return {
        status: "scheduled",
        value: {
          airingAt: media.nextAiringEpisode.airingAt,
          episode: media.nextAiringEpisode.episode,
        },
      };
    } catch (error) {
      lastMessage =
        error instanceof Error ? error.message : "AniList network error";
      if (attempt + 1 < AIRING_MAX_ATTEMPTS) {
        await delay(750 * 2 ** attempt);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { status: "network_error", retryable: true, message: lastMessage };
}

// ── Next Season ──────────────────────────────────────────────

export interface NextSeasonItem {
  id: number;
  title: { native: string; romaji: string };
  cover: string;
  startDate: { year: number; month: number; day: number | null };
  airingAt: number | null;
  episode: number | null;
  episodes: number | null;
  format: string;
}

interface NextSeasonResponse {
  data: {
    Page: {
      pageInfo: { hasNextPage: boolean };
      media: {
        id: number;
        title: { native: string; romaji: string };
        coverImage: { large: string };
        startDate: {
          year: number | null;
          month: number | null;
          day: number | null;
        };
        nextAiringEpisode: { airingAt: number; episode: number } | null;
        episodes: number | null;
        format: string;
      }[];
    };
  };
}

export function getNextSeasonInfo(): {
  season: string;
  seasonYear: number;
  label: string;
} {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (month <= 3)
    return { season: "SPRING", seasonYear: year, label: `${year} 春季` };
  if (month <= 6)
    return { season: "SUMMER", seasonYear: year, label: `${year} 夏季` };
  if (month <= 9)
    return { season: "FALL", seasonYear: year, label: `${year} 秋季` };
  return { season: "WINTER", seasonYear: year + 1, label: `${year + 1} 冬季` };
}

export async function getNextSeason(): Promise<NextSeasonItem[]> {
  const { season, seasonYear } = getNextSeasonInfo();

  const allItems: NextSeasonItem[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const query = `{ Page(page: ${page}, perPage: 50) { pageInfo { hasNextPage } media(season: ${season}, seasonYear: ${seasonYear}, type: ANIME, sort: POPULARITY_DESC) { id title { native romaji } coverImage { large } startDate { year month day } nextAiringEpisode { airingAt episode } episodes format } } }`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetchFn(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) break;

    const json = (await res.json()) as NextSeasonResponse;
    const media = json.data?.Page?.media ?? [];
    hasNext = json.data?.Page?.pageInfo?.hasNextPage ?? false;

    for (const m of media) {
      allItems.push({
        id: m.id,
        title: { native: m.title.native, romaji: m.title.romaji },
        cover: m.coverImage.large,
        startDate: {
          year: m.startDate.year ?? 0,
          month: m.startDate.month ?? 0,
          day: m.startDate.day,
        },
        airingAt: m.nextAiringEpisode?.airingAt ?? null,
        episode: m.nextAiringEpisode?.episode ?? null,
        episodes: m.episodes,
        format: m.format,
      });
    }

    page++;
  }

  return allItems;
}
