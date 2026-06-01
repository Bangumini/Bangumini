const BASE_URL = "https://graphql.anilist.co";

let fetchFn: typeof fetch = fetch;

export function setFetchFunction(fn: typeof fetch) {
  fetchFn = fn;
}

function buildQuery(title: string): string {
  const escaped = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `
    query {
      Page(page: 1, perPage: 1) {
        media(search: "${escaped}", type: ANIME) {
          nextAiringEpisode {
            airingAt
            episode
          }
        }
      }
    }
  `;
}

type AniListResponse = {
  data?: {
    Page?: {
      media?: Array<{
        nextAiringEpisode?: { airingAt: number; episode: number } | null;
      }>;
    };
  };
  errors?: unknown[];
};

async function searchAiringAt(title: string): Promise<{ airingAt: number; episode: number } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetchFn(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: buildQuery(title) }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const json = (await res.json()) as AniListResponse;
    return json.data?.Page?.media?.[0]?.nextAiringEpisode ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAiringAt(...titles: string[]): Promise<{ airingAt: number; episode: number } | null> {
  const tried = new Set<string>();
  for (const title of titles) {
    const trimmed = title.trim();
    if (!trimmed || tried.has(trimmed)) continue;
    tried.add(trimmed);
    const result = await searchAiringAt(trimmed);
    if (result) return result;
  }
  return null;
}
