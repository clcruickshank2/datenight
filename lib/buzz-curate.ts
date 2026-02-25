import "server-only";

/**
 * Call OpenAI to pick the 5 best articles for Denver food scene curation.
 * No new deps; uses fetch. Set OPENAI_API_KEY to enable.
 */

const RECENT_CAP = 50;
const PICK = 5;

export type ArticleForCuration = {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  source_id: string;
  published_at?: string | null;
};

export type CurationResult = {
  ids: string[];
  error?: string;
};

/**
 * Returns 5 article IDs in recommendation order (best first), or [] if no key or error.
 * Uses IDs so we never miss due to URL mismatch; prompt favors editorial sources.
 */
export async function pickCuratedArticleIds(
  articles: ArticleForCuration[],
  sourceNames: Map<string, string>
): Promise<CurationResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ids: [], error: "OPENAI_API_KEY missing" };
  if (articles.length === 0) return { ids: [], error: "No articles to curate" };

  const now = Date.now();
  const ageDays = (iso?: string | null) => {
    if (!iso) return 999;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return 999;
    return Math.floor((now - t) / (24 * 60 * 60 * 1000));
  };

  const redditPopularity = (url: string) => {
    // Light-weight proxy from reddit permalink when available.
    // Example pattern: .../comments/<id>/<slug>/
    // We cannot resolve views/shares directly without extra API calls,
    // but we can surface Reddit-related metadata cues in prompt/fallback.
    return /reddit\.com\/r\/[^/]+\/comments\//i.test(url);
  };

  const list = articles.slice(0, RECENT_CAP).map((a) => ({
    id: a.id,
    title: a.title,
    summary: (a.summary ?? "").slice(0, 300),
    source: sourceNames.get(a.source_id) ?? a.source_id,
    age_days: ageDays(a.published_at),
    popularity_proxy: redditPopularity(a.url) ? "reddit_post" : "unknown",
  }));

  const prompt = `You are curating a weekly Denver food newsletter. From the following articles, pick the 5 best for someone who wants to stay on top of the Denver restaurant and food scene.

Rules:
- Prefer editorial sources (5280 Magazine, Eater Denver, Westword, 303 Magazine) over Reddit when quality is similar.
- Favor: restaurant reviews, openings/closings, chef stories, neighborhood guides, and "where to eat" lists.
- Skip: generic questions, low-signal threads, or off-topic posts.
- Prefer recency: prioritize articles from the last 30 days unless older content is clearly higher-value evergreen.
- Use popularity proxies when present (e.g., social discussion signals in summaries/metadata) as a tie-breaker.

Articles (id, title, summary, source, age_days, popularity_proxy):
${list.map((a) => `- id: ${a.id} | "${a.title}" | ${a.summary} | ${a.source} | age_days=${a.age_days} | popularity_proxy=${a.popularity_proxy}`).join("\n")}

Return a JSON array of exactly 5 article IDs in order of recommendation (best first). No other text, only the array. Example: ["uuid-1", "uuid-2", ...]`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ids: [], error: `OpenAI ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ids: [], error: "OpenAI response missing content" };
    const ids = JSON.parse(content) as string[];
    if (!Array.isArray(ids)) return { ids: [], error: "OpenAI response was not a JSON array" };
    const validIds = new Set(articles.map((a) => a.id));
    return {
      ids: ids.slice(0, PICK).filter((id) => typeof id === "string" && validIds.has(id)),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown OpenAI error";
    return { ids: [], error: message };
  }
}

/**
 * Deterministic fallback curation when LLM fails or returns too few IDs.
 * Uses source quality + food-news keywords + slight recency bias.
 */
export function fallbackCuratedArticleIds(
  articles: ArticleForCuration[],
  sourceNames: Map<string, string>
): string[] {
  const sourceWeight: Record<string, number> = {
    "5280": 5,
    "eater-denver": 5,
    "westword": 4,
    "303-magazine": 4,
    "new-denizen": 4,
    "reddit-denverfood": 1,
  };

  const keywordWeight = (text: string) => {
    const t = text.toLowerCase();
    let score = 0;
    if (/(review|critic|top|best|guide|where to eat|heatmap)/.test(t)) score += 3;
    if (/(open|opening|close|closing|new restaurant|debut)/.test(t)) score += 2;
    if (/(chef|menu|tasting|neighborhood|denver)/.test(t)) score += 1;
    if (/(question|help me choose|na beers|birthday party)/.test(t)) score -= 2;
    return score;
  };

  const now = Date.now();
  const recencyWeight = (iso?: string | null) => {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return 0;
    const days = (now - t) / (24 * 60 * 60 * 1000);
    // Strong preference for last 30 days; taper off after that.
    if (days <= 7) return 3;
    if (days <= 30) return 2;
    if (days <= 90) return 1;
    return 0;
  };

  const popularityProxyWeight = (a: ArticleForCuration) => {
    const text = `${a.title} ${a.summary ?? ""}`.toLowerCase();
    let score = 0;
    // weak generic social proof keywords
    if (/(viral|trending|most read|popular|debate|buzz)/.test(text)) score += 1;
    // reddit-style discussion links get a slight bump only
    if (/reddit\.com\/r\/[^/]+\/comments\//i.test(a.url)) score += 0.5;
    return score;
  };

  const ranked = articles
    .map((a, idx) => {
      const sourceScore = sourceWeight[a.source_id] ?? 2;
      const sourceName = sourceNames.get(a.source_id) ?? a.source_id;
      const text = `${a.title} ${a.summary ?? ""} ${sourceName}`;
      const kw = keywordWeight(text);
      const recency = recencyWeight(a.published_at);
      const popularity = popularityProxyWeight(a);
      // recent list is already sorted by fetched_at desc; lower index => slightly higher score
      const fetchedOrderBias = Math.max(0, 1 - idx * 0.02);
      return { id: a.id, score: sourceScore + kw + recency + popularity + fetchedOrderBias };
    })
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const picks: string[] = [];
  for (const r of ranked) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    picks.push(r.id);
    if (picks.length >= PICK) break;
  }
  return picks;
}

type DiversifyOptions = {
  preferredIds: string[];   // Primary ordering (LLM picks)
  candidateIds: string[];   // Backup ordering (fallback-ranked list)
  articles: ArticleForCuration[];
  target?: number;
  maxPerSource?: number;
  minSources?: number;
};

/**
 * Enforce source diversity in curated picks.
 * - Try to include at least `minSources` different sources
 * - Cap per-source picks with `maxPerSource` when possible
 * - Preserve preferred ordering as much as possible
 */
export function diversifyCuratedArticleIds({
  preferredIds,
  candidateIds,
  articles,
  target = 5,
  maxPerSource = 2,
  minSources = 3,
}: DiversifyOptions): string[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const preferred = preferredIds.filter((id) => byId.has(id));
  const candidates = candidateIds.filter((id) => byId.has(id));
  const ordered = Array.from(new Set([...preferred, ...candidates]));

  const picks: string[] = [];
  const used = new Set<string>();
  const sourceCount = new Map<string, number>();

  const add = (id: string, allowOverflow = false): boolean => {
    if (used.has(id)) return false;
    const a = byId.get(id);
    if (!a) return false;
    const src = a.source_id;
    const current = sourceCount.get(src) ?? 0;
    if (!allowOverflow && current >= maxPerSource) return false;
    picks.push(id);
    used.add(id);
    sourceCount.set(src, current + 1);
    return true;
  };

  // Pass 1: guarantee source diversity first.
  // Pick first item from distinct sources in preferred/candidate order.
  for (const id of ordered) {
    if (picks.length >= target) break;
    const a = byId.get(id);
    if (!a) continue;
    if ((sourceCount.get(a.source_id) ?? 0) > 0) continue;
    add(id);
    if (sourceCount.size >= minSources) break;
  }

  // Pass 2: fill remaining from preferred first, then candidates, respecting cap.
  for (const id of preferred) {
    if (picks.length >= target) break;
    add(id);
  }
  for (const id of ordered) {
    if (picks.length >= target) break;
    add(id);
  }

  // Pass 3: if still short, allow overflow cap to ensure we always return target.
  for (const id of ordered) {
    if (picks.length >= target) break;
    add(id, true);
  }

  return picks.slice(0, target);
}
