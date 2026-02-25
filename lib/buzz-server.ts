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

/** Curated articles: limit, optional source_ids filter, order by published_at desc. */
export async function fetchBuzzArticles(limit: number, sourceIds?: string[]): Promise<BuzzArticle[]> {
  const { url, key } = getConfig();
  let path = `${url}/rest/v1/buzz_articles?select=id,source_id,title,url,summary,image_url,published_at,fetched_at&order=published_at.desc.nullslast,fetched_at.desc&limit=${limit}`;
  if (sourceIds?.length) {
    path += `&source_id=in.(${sourceIds.join(",")})`;
  }
  const res = await fetch(path, { headers: headers(key), cache: "no-store" });
  if (!res.ok) return [];
  return (await res.json()) as BuzzArticle[];
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
