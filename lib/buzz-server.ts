import "server-only";

/**
 * Buzz: sources, articles, preferences. Uses Supabase REST via fetch.
 * Read operations only need SUPABASE_URL + key; preferences need PROFILE_ID.
 */

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

function getConfigWithProfile() {
  const { url, key } = getConfig();
  const profileId = process.env.PROFILE_ID;
  return { url, key, profileId };
}

const headers = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

export type BuzzSource = {
  id: string;
  name: string;
  base_url: string;
  feed_url: string | null;
  enabled: boolean;
  sort_order: number;
};

export type BuzzArticle = {
  id: string;
  source_id: string;
  title: string;
  url: string;
  summary: string | null;
  image_url: string | null;
  published_at: string | null;
  fetched_at: string;
  curated_rank?: number | null;
};

/** All enabled sources with a feed_url (for cron). */
export async function fetchBuzzSourcesWithFeeds(): Promise<BuzzSource[]> {
  const { url, key } = getConfig();
  const res = await fetch(
    `${url}/rest/v1/buzz_sources?enabled=eq.true&feed_url=not.is.null&order=sort_order.asc&select=id,name,base_url,feed_url,enabled,sort_order`,
    { headers: headers(key), cache: "no-store" }
  );
  if (!res.ok) return [];
  return (await res.json()) as BuzzSource[];
}

/** All enabled sources (for page display). */
export async function fetchBuzzSources(): Promise<BuzzSource[]> {
  const { url, key } = getConfig();
  const res = await fetch(
    `${url}/rest/v1/buzz_sources?enabled=eq.true&order=sort_order.asc&select=id,name,base_url,feed_url,enabled,sort_order`,
    { headers: headers(key), cache: "no-store" }
  );
  if (!res.ok) return [];
  return (await res.json()) as BuzzSource[];
}

/** Curated articles: show 5 with curated_rank 1-5 first; if fewer than 5 curated, fill with latest. Optional source_ids filter. */
export async function fetchBuzzArticles(limit: number, sourceIds?: string[]): Promise<BuzzArticle[]> {
  const { url, key } = getConfig();
  const select = "id,source_id,title,url,summary,image_url,published_at,fetched_at,curated_rank";
  const sourceFilter = sourceIds?.length ? `&source_id=in.(${sourceIds.join(",")})` : "";
  // Curated first (rank 1-5), then by recency
  const path = `${url}/rest/v1/buzz_articles?select=${select}&order=curated_rank.asc.nullslast,published_at.desc.nullslast,fetched_at.desc&limit=${limit}${sourceFilter}`;
  const res = await fetch(path, { headers: headers(key), cache: "no-store" });
  if (!res.ok) return [];
  const all = (await res.json()) as BuzzArticle[];
  // If we have at least one curated, take only curated (so we don't mix curated + uncurated)
  const curated = all.filter((a) => a.curated_rank != null);
  if (curated.length >= limit) return curated.slice(0, limit);
  if (curated.length > 0) return curated;
  return all.slice(0, limit);
}

/** Recent articles for LLM curation (cron): last N by fetched_at, with title/summary/source for picking. */
export async function fetchRecentBuzzArticlesForCuration(limit: number): Promise<{ id: string; title: string; url: string; summary: string | null; source_id: string }[]> {
  const { url, key } = getConfig();
  const path = `${url}/rest/v1/buzz_articles?select=id,title,url,summary,source_id&order=fetched_at.desc&limit=${limit}`;
  const res = await fetch(path, { headers: headers(key), cache: "no-store" });
  if (!res.ok) return [];
  return (await res.json()) as { id: string; title: string; url: string; summary: string | null; source_id: string }[];
}

/** Clear curated_rank 1-5 (before setting new picks). */
export async function clearBuzzCuratedRanks(): Promise<{ error?: string }> {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/rest/v1/buzz_articles?curated_rank=in.(1,2,3,4,5)`, {
    method: "PATCH",
    headers: headers(key),
    body: JSON.stringify({ curated_rank: null }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}

/** Set curated_rank 1-5 for articles by url (order = rank). */
export async function setBuzzCuratedRanks(orderedUrls: string[]): Promise<{ error?: string }> {
  const { url, key } = getConfig();
  for (let i = 0; i < Math.min(5, orderedUrls.length); i++) {
    const res = await fetch(`${url}/rest/v1/buzz_articles?url=eq.${encodeURIComponent(orderedUrls[i])}`, {
      method: "PATCH",
      headers: headers(key),
      body: JSON.stringify({ curated_rank: i + 1 }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: `Supabase ${res.status}: ${text}` };
    }
  }
  return {};
}

/** Profile's enabled source ids for curation. If none, use all enabled source ids. */
export async function fetchBuzzPreferencesSourceIds(): Promise<string[] | null> {
  const { url, key, profileId } = getConfigWithProfile();
  if (!profileId) return null;
  const res = await fetch(
    `${url}/rest/v1/buzz_preferences?profile_id=eq.${profileId}&enabled=eq.true&select=source_id&order=sort_order.asc`,
    { headers: headers(key), cache: "no-store" }
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as { source_id: string }[];
  if (rows.length === 0) return null;
  return rows.map((r) => r.source_id);
}

/** Upsert articles (by source_id + url). */
export async function upsertBuzzArticles(
  rows: { source_id: string; title: string; url: string; summary?: string | null; image_url?: string | null; published_at?: string | null }[]
): Promise<{ error?: string }> {
  const { url, key } = getConfig();
  const body = rows.map((r) => ({
    source_id: r.source_id,
    title: r.title,
    url: r.url,
    summary: r.summary ?? null,
    image_url: r.image_url ?? null,
    published_at: r.published_at ?? null,
  }));
  const res = await fetch(`${url}/rest/v1/buzz_articles?on_conflict=source_id,url`, {
    method: "POST",
    headers: {
      ...headers(key),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}
