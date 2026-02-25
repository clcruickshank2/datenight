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

export type TrendingExtractionResult = {
  restaurants: {
    name: string;
    overview: string;
    source_article_ids: string[];
    neighborhood?: string | null;
    price_level?: number | null;
    cuisine_vibes?: string[];
    google_rating?: number | null;
    rating_source?: string | null;
  }[];
  method?: "llm" | "heuristic";
  extracted_count?: number;
  enriched_count?: number;
  error?: string;
};

function parseJsonArrayFromModel(content: string): unknown[] {
  const trimmed = content.trim();
  // 1) direct parse first
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch {
    // continue
  }

  // 2) fenced block: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    const parsed = JSON.parse(fenced);
    if (Array.isArray(parsed)) return parsed;
  }

  // 3) first JSON array slice fallback
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsed = JSON.parse(sliced);
    if (Array.isArray(parsed)) return parsed;
  }

  throw new Error("Model did not return a valid JSON array");
}

function parseJsonObjectFromModel(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const parsed = JSON.parse(fenceMatch[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsed = JSON.parse(sliced);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  throw new Error("Model did not return a valid JSON object");
}

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
    const ids = parseJsonArrayFromModel(content) as string[];
    const validIds = new Set(articles.map((a) => a.id));
    const filtered = ids
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id) => id.length > 0 && validIds.has(id));
    return { ids: filtered.slice(0, PICK) };
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

/**
 * Extract trending restaurants from curated articles using OpenAI.
 * Returns 0..N rows ready for insert into buzz_restaurants.
 */
export async function extractTrendingRestaurants(
  articles: ArticleForCuration[],
  sourceNames: Map<string, string>
): Promise<TrendingExtractionResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { restaurants: [], error: "OPENAI_API_KEY missing" };
  if (articles.length === 0) return { restaurants: [], error: "No curated articles provided" };

  const list = articles.map((a, idx) => ({
    ref: `A${idx + 1}`,
    id: a.id,
    source: sourceNames.get(a.source_id) ?? a.source_id,
    title: a.title,
    summary: (a.summary ?? "").slice(0, 1600),
    url: a.url,
  }));
  const refToId = new Map(list.map((a) => [a.ref, a.id]));

  const baseContext = `Input articles (ref, source, title, summary, url):
${list.map((a) => `- ref=${a.ref} | source=${a.source} | title="${a.title}" | summary="${a.summary}" | url=${a.url}`).join("\n")}`;

  try {
    const strictPrompt = `You are extracting Denver restaurant names from curated articles.

${baseContext}

Rules:
- Include only restaurants explicitly named in the article content.
- Do not invent names and do not include neighborhoods or generic phrases.
- Use article refs (A1..A5), never UUIDs.
- Return up to 15 rows.

Return ONLY a JSON object:
{
  "restaurants": [
    {
      "name": "Restaurant Name",
      "overview": "One or two concise sentences about why it is trending.",
      "article_refs": ["A1", "A3"]
    }
  ]
}`;

    const strictAttempt = await runRestaurantExtractionAttempt(
      strictPrompt,
      key,
      articles,
      refToId
    );

    let extracted = strictAttempt.restaurants;
    let extractionError = strictAttempt.error;

    if (extracted.length === 0) {
      const retryPrompt = `Extract explicitly named restaurants from these Denver food articles.

${baseContext}

Return ONLY JSON:
{
  "restaurants": [
    { "name": "Restaurant Name", "article_refs": ["A1"] }
  ]
}

If unsure, exclude the item.`;
      const retryAttempt = await runRestaurantExtractionAttempt(
        retryPrompt,
        key,
        articles,
        refToId
      );
      extracted = retryAttempt.restaurants;
      extractionError = [extractionError, retryAttempt.error].filter(Boolean).join("; ");
    }

    const trimmed = dedupeRestaurantsByName(extracted).slice(0, 15);
    if (trimmed.length > 0) {
      const enriched = await enrichTrendingRestaurants(trimmed);
      return {
        restaurants: enriched.restaurants,
        method: "llm",
        extracted_count: trimmed.length,
        enriched_count: enriched.enrichedCount,
        error: [extractionError, enriched.error].filter(Boolean).join("; ") || undefined,
      };
    }

    const fallbackBase = heuristicTrendingRestaurants(articles);
    const fallback = fallbackBase.map((r) => ({
      name: r.name,
      overview: r.overview,
      source_article_ids: r.source_article_ids,
    }));
    if (fallback.length > 0) {
      const enrichedFallback = await enrichTrendingRestaurants(fallback);
      return {
        restaurants: enrichedFallback.restaurants,
        method: "heuristic",
        extracted_count: fallback.length,
        enriched_count: enrichedFallback.enrichedCount,
        error: [
          extractionError || "LLM returned empty extraction; used heuristic fallback",
          enrichedFallback.error,
        ]
          .filter(Boolean)
          .join("; "),
      };
    }
    return {
      restaurants: [],
      method: "llm",
      extracted_count: 0,
      enriched_count: 0,
      error: extractionError || "LLM returned empty extraction",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown extraction error";
    const fallback = heuristicTrendingRestaurants(articles);
    if (fallback.length > 0) {
      const enrichedFallback = await enrichTrendingRestaurants(
        fallback.map((r) => ({
          name: r.name,
          overview: r.overview,
          source_article_ids: r.source_article_ids,
        }))
      );
      return {
        restaurants: enrichedFallback.restaurants,
        method: "heuristic",
        extracted_count: fallback.length,
        enriched_count: enrichedFallback.enrichedCount,
        error: [message, "used heuristic fallback", enrichedFallback.error]
          .filter(Boolean)
          .join("; "),
      };
    }
    return {
      restaurants: [],
      method: "llm",
      extracted_count: 0,
      enriched_count: 0,
      error: message,
    };
  }
}

async function runRestaurantExtractionAttempt(
  prompt: string,
  key: string,
  articles: ArticleForCuration[],
  refToId: Map<string, string>
): Promise<{ restaurants: ExtractedTrendingRestaurant[]; error?: string }> {
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
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { restaurants: [], error: `OpenAI ${res.status}: ${text}` };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { restaurants: [], error: "OpenAI response missing content" };

    const parsedRows = extractRestaurantsFromModelContent(content);
    if (parsedRows.length === 0) {
      return { restaurants: [], error: "LLM returned zero restaurant rows" };
    }

    const restaurants = dedupeRestaurantsByName(
      parsedRows
        .map((r) => {
          const name = (r.name ?? "").trim();
          const overview = (r.overview ?? "").trim();
          const refs = Array.isArray(r.article_refs)
            ? r.article_refs
                .map((ref) => (typeof ref === "string" ? ref.trim().toUpperCase() : ""))
                .filter((ref) => ref.length > 0)
            : [];
          const fromRefs = refs
            .map((ref) => refToId.get(ref))
            .filter((id): id is string => Boolean(id));
          const inferredIds = fromRefs.length > 0 ? fromRefs : inferArticleIdsByName(name, articles);
          return {
            name,
            overview: overview || "Trending restaurant in Denver food coverage.",
            source_article_ids: inferredIds.length > 0 ? inferredIds : [articles[0].id],
          };
        })
        .filter((r) => r.name.length > 0)
    ).slice(0, 15);

    if (restaurants.length === 0) {
      return { restaurants: [], error: "LLM output rows were not valid restaurants" };
    }
    return { restaurants };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown extraction error";
    return { restaurants: [], error: message };
  }
}

function extractRestaurantsFromModelContent(content: string): {
  name?: string;
  overview?: string;
  article_refs?: unknown[];
}[] {
  try {
    const object = parseJsonObjectFromModel(content);
    const fromObject = object.restaurants;
    if (Array.isArray(fromObject)) {
      return fromObject as {
        name?: string;
        overview?: string;
        article_refs?: unknown[];
      }[];
    }
  } catch {
    // continue with array fallback
  }

  const array = parseJsonArrayFromModel(content);
  return array as {
    name?: string;
    overview?: string;
    article_refs?: unknown[];
  }[];
}

function inferArticleIdsByName(name: string, articles: ArticleForCuration[]): string[] {
  if (!name) return [];
  const needle = normalizeRestaurantName(name);
  if (!needle) return [];
  const ids = articles
    .filter((a) => normalizeRestaurantName(`${a.title} ${a.summary ?? ""}`).includes(needle))
    .map((a) => a.id);
  return ids.slice(0, 3);
}

function heuristicTrendingRestaurants(
  articles: ArticleForCuration[]
): {
  name: string;
  overview: string;
  source_article_ids: string[];
  neighborhood?: string | null;
  price_level?: number | null;
  cuisine_vibes?: string[];
  google_rating?: number | null;
  rating_source?: string | null;
}[] {
  const stop = new Set([
    "Denver",
    "Eater",
    "Magazine",
    "Guide",
    "Guides",
    "Restaurants",
    "Restaurant",
    "Food",
    "Foods",
    "Cherry Creek",
    "LoHi",
    "Fall",
    "The",
    "A",
    "An",
  ]);

  const byName = new Map<string, { count: number; articleIds: Set<string> }>();
  for (const a of articles) {
    const text = `${a.title}. ${a.summary ?? ""}`;
    const re = /\b([A-Z][a-zA-Z'&.-]+(?:\s+[A-Z][a-zA-Z'&.-]+){0,3})\b/g;
    const seenThisArticle = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (raw.length < 3 || raw.length > 40) continue;
      if (stop.has(raw)) continue;
      // skip obvious non-restaurant phrases
      if (/(Best|Top|Guide|Denver|Food|Restaurant|Restaurants|Michelin|Bib Gourmand)$/i.test(raw)) continue;
      if (seenThisArticle.has(raw)) continue;
      seenThisArticle.add(raw);
      const rec = byName.get(raw) ?? { count: 0, articleIds: new Set<string>() };
      rec.count += 1;
      rec.articleIds.add(a.id);
      byName.set(raw, rec);
    }
  }

  return Array.from(byName.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([name, rec]) => ({
      name,
      overview: "Mentioned in this week's curated Denver food coverage.",
      source_article_ids: Array.from(rec.articleIds),
      neighborhood: null,
      price_level: null,
      cuisine_vibes: [],
      google_rating: null,
      rating_source: null,
    }));
}

function normalizeRestaurantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeRestaurantsByName<T extends { name: string }>(rows: T[]): T[] {
  const byName = new Map<string, T>();
  for (const row of rows) {
    const key = normalizeRestaurantName(row.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, row);
  }
  return Array.from(byName.values());
}

type ExtractedTrendingRestaurant = {
  name: string;
  overview: string;
  source_article_ids: string[];
};

async function enrichTrendingRestaurants(
  restaurants: ExtractedTrendingRestaurant[]
): Promise<{
  restaurants: TrendingExtractionResult["restaurants"];
  enrichedCount: number;
  error?: string;
}> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      restaurants: restaurants.map((r) => ({
        ...r,
        neighborhood: null,
        price_level: null,
        cuisine_vibes: [],
        google_rating: null,
        rating_source: null,
      })),
      enrichedCount: 0,
      error: "OPENAI_API_KEY missing",
    };
  }

  const prompt = `You are enriching Denver restaurant metadata.

Input restaurants:
${restaurants.map((r) => `- name="${r.name}" | overview="${r.overview}"`).join("\n")}

For each restaurant, return:
- name (same as input)
- neighborhood (string or null)
- price_level (integer 1..4 where 1=$ and 4=$$$$, or null)
- cuisine_vibes (array of short strings, 1 to 6 items, or empty array)
- google_rating (number 0.0..5.0 or null)
- rating_source ("google" when rating is from known Google rating context, otherwise "llm_estimate" or null)
- overview (optional improved 1-2 sentence summary)

Rules:
- Return every input restaurant exactly once.
- Use null when unknown; do not fabricate specific facts.
- Output ONLY valid JSON array.
`;

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
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        restaurants: restaurants.map((r) => ({
          ...r,
          neighborhood: null,
          price_level: null,
          cuisine_vibes: [],
          google_rating: null,
          rating_source: null,
        })),
        enrichedCount: 0,
        error: `OpenAI ${res.status}: ${text}`,
      };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return {
        restaurants: restaurants.map((r) => ({
          ...r,
          neighborhood: null,
          price_level: null,
          cuisine_vibes: [],
          google_rating: null,
          rating_source: null,
        })),
        enrichedCount: 0,
        error: "OpenAI enrichment response missing content",
      };
    }

    const parsed = parseJsonArrayFromModel(content) as {
      name?: string;
      neighborhood?: string | null;
      price_level?: number | null;
      cuisine_vibes?: unknown;
      google_rating?: number | null;
      rating_source?: string | null;
      overview?: string | null;
    }[];

    const byName = new Map<string, (typeof parsed)[number]>();
    for (const row of parsed) {
      const name = (row.name ?? "").trim();
      const keyName = normalizeRestaurantName(name);
      if (!keyName) continue;
      if (!byName.has(keyName)) byName.set(keyName, row);
    }

    let enrichedCount = 0;
    const merged = restaurants.map((r) => {
      const enriched = byName.get(normalizeRestaurantName(r.name));
      const neighborhood = sanitizeNullableText(enriched?.neighborhood);
      const price_level = sanitizePriceLevel(enriched?.price_level);
      const cuisine_vibes = sanitizeCuisineVibes(enriched?.cuisine_vibes);
      const google_rating = sanitizeGoogleRating(enriched?.google_rating);
      const rating_source = sanitizeNullableText(enriched?.rating_source);
      const overview = sanitizeNullableText(enriched?.overview) ?? r.overview;

      if (
        neighborhood !== null ||
        price_level !== null ||
        cuisine_vibes.length > 0 ||
        google_rating !== null
      ) {
        enrichedCount += 1;
      }

      return {
        name: r.name,
        overview,
        source_article_ids: r.source_article_ids,
        neighborhood,
        price_level,
        cuisine_vibes,
        google_rating,
        rating_source: rating_source ?? (google_rating != null ? "google" : null),
      };
    });

    return { restaurants: merged, enrichedCount };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown enrichment error";
    return {
      restaurants: restaurants.map((r) => ({
        ...r,
        neighborhood: null,
        price_level: null,
        cuisine_vibes: [],
        google_rating: null,
        rating_source: null,
      })),
      enrichedCount: 0,
      error: message,
    };
  }
}

function sanitizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : null;
}

function sanitizePriceLevel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= 1 && n <= 4 ? n : null;
}

function sanitizeGoogleRating(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 5) return null;
  return Math.round(value * 10) / 10;
}

function sanitizeCuisineVibes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed.length > 40) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 6) break;
  }
  return out;
}
