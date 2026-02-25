import { NextRequest } from "next/server";
import {
  fetchBuzzSourcesWithFeeds,
  fetchBuzzSources,
  fetchRecentBuzzArticlesForCuration,
  fetchCuratedBuzzArticles,
  upsertBuzzArticles,
  clearBuzzCuratedRanks,
  setBuzzCuratedRanksById,
  clearBuzzRestaurants,
  insertBuzzRestaurants,
  upsertTrendingIntoRestaurants,
} from "@/lib/buzz-server";
import {
  fallbackCuratedArticleIds,
  pickCuratedArticleIds,
  diversifyCuratedArticleIds,
  extractTrendingRestaurants,
} from "@/lib/buzz-curate";
import { parseRss, normalizePubDate } from "@/lib/rss";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS_PER_FEED = 30;
const ARTICLE_FETCH_TIMEOUT_MS = 10_000;

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchArticleExcerpt(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "RezSimple-Buzz/1.0" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return "";
    const html = await res.text();
    const text = stripHtmlToText(html);
    // Keep prompt size reasonable; enough context for restaurant extraction
    return text.slice(0, 3500);
  } catch {
    return "";
  }
}

export async function GET(request: NextRequest) {
  const secretRaw = process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production" && !secretRaw) {
    return Response.json({ error: "CRON_SECRET missing" }, { status: 500 });
  }
  const secret = secretRaw?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (token !== secret) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let sources;
  try {
    sources = await fetchBuzzSourcesWithFeeds();
  } catch (e) {
    const message = e instanceof Error ? e.message : "Config error";
    return Response.json({ error: message }, { status: 500 });
  }

  const results: { source_id: string; name: string; items: number; error?: string }[] = [];

  for (const source of sources) {
    const feedUrl = source.feed_url;
    if (!feedUrl) continue;
    if (source.id === "westword") {
      results.push({
        source_id: source.id,
        name: source.name,
        items: 0,
        error: "Skipped: feed currently unreliable (404).",
      });
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "RezSimple-Buzz/1.0" },
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        results.push({ source_id: source.id, name: source.name, items: 0, error: `HTTP ${res.status}` });
        continue;
      }
      const xml = await res.text();
      const parsed = parseRss(xml)
        .filter((item) => item.link && item.title)
        .slice(0, MAX_ITEMS_PER_FEED);
      if (parsed.length === 0) {
        results.push({ source_id: source.id, name: source.name, items: 0 });
        continue;
      }
      const rows = parsed.map((item) => ({
        source_id: source.id,
        title: item.title,
        url: item.link,
        summary: item.description,
        image_url: item.imageUrl,
        published_at: normalizePubDate(item.pubDate),
      }));
      const err = await upsertBuzzArticles(rows);
      if (err.error) {
        results.push({ source_id: source.id, name: source.name, items: 0, error: err.error });
      } else {
        results.push({ source_id: source.id, name: source.name, items: rows.length });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Fetch/parse error";
      results.push({ source_id: source.id, name: source.name, items: 0, error: message });
    }
  }

  // Curate: pick 5 articles by id (LLM first, deterministic fallback)
  let curated = 0;
  let curationMethod: "llm" | "fallback" | "none" = "none";
  let curationError: string | undefined;
  if (process.env.OPENAI_API_KEY) {
    try {
      const recent = await fetchRecentBuzzArticlesForCuration(50);
      if (recent.length >= 5) {
        const allSources = await fetchBuzzSources();
        const sourceNames = new Map(allSources.map((s) => [s.id, s.name]));
        const llm = await pickCuratedArticleIds(recent, sourceNames);
        const fallbackIds = fallbackCuratedArticleIds(recent, sourceNames);
        let ids = llm.ids;
        if (ids.length >= 5) {
          curationMethod = "llm";
        } else {
          curationError = llm.error ?? "LLM returned fewer than 5 picks";
          ids = fallbackIds;
          if (ids.length >= 5) curationMethod = "fallback";
        }
        // Enforce source diversity even when LLM picks are valid.
        ids = diversifyCuratedArticleIds({
          preferredIds: ids,
          candidateIds: fallbackIds,
          articles: recent,
          target: 5,
          maxPerSource: 1,
          minSources: 4,
        });
        if (ids.length >= 5) {
          await clearBuzzCuratedRanks();
          const err = await setBuzzCuratedRanksById(ids);
          if (!err.error) {
            curated = ids.length;
          } else if (!curationError) {
            curationError = err.error;
          }
        } else if (!curationError) {
          curationError = "Not enough candidate articles to curate 5 picks";
        }
      } else {
        curationError = "Need at least 5 recent articles before curation";
      }
    } catch (e) {
      curationError = e instanceof Error ? e.message : "Curation error";
    }
  } else {
    curationError = "OPENAI_API_KEY missing";
  }

  // Trending restaurant extraction (from curated articles)
  let trendingInserted = 0;
  let trendingSeeded = 0;
  let trendingMethod: "llm" | "heuristic" | "none" = "none";
  let trendingError: string | undefined;
  let trendingExtracted = 0;
  let trendingEnriched = 0;
  if (process.env.OPENAI_API_KEY) {
    try {
      const curatedArticles = await fetchCuratedBuzzArticles(5);
      if (curatedArticles.length > 0) {
        const allSources = await fetchBuzzSources();
        const sourceNames = new Map(allSources.map((s) => [s.id, s.name]));
        const excerpts = await Promise.all(
          curatedArticles.map(async (a) => ({
            id: a.id,
            excerpt: await fetchArticleExcerpt(a.url),
          }))
        );
        const excerptById = new Map(excerpts.map((x) => [x.id, x.excerpt]));

        const enriched = curatedArticles.map((a) => ({
          ...a,
          summary: `${a.summary ?? ""} ${excerptById.get(a.id) ?? ""}`.trim().slice(0, 4000),
        }));

        const extracted = await extractTrendingRestaurants(enriched, sourceNames);
        trendingExtracted = extracted.extracted_count ?? extracted.restaurants.length;
        trendingEnriched = extracted.enriched_count ?? 0;
        if (extracted.restaurants.length > 0) {
          const clearErr = await clearBuzzRestaurants();
          if (clearErr.error) {
            trendingError = clearErr.error;
          } else {
            const insertErr = await insertBuzzRestaurants(extracted.restaurants);
            if (insertErr.error) {
              trendingError = insertErr.error;
            } else {
              trendingInserted = extracted.restaurants.length;
              trendingMethod = extracted.method ?? "llm";
              const seed = await upsertTrendingIntoRestaurants(extracted.restaurants);
              if (seed.error) {
                trendingError = trendingError
                  ? `${trendingError}; ${seed.error}`
                  : seed.error;
              } else {
                trendingSeeded = seed.upserted;
              }
              if (extracted.error) {
                trendingError = trendingError
                  ? `${trendingError}; ${extracted.error}`
                  : extracted.error;
              }
            }
          }
        } else {
          trendingError = extracted.error ?? "No restaurants extracted from curated articles";
        }
      } else {
        trendingError = "No curated articles found for extraction";
      }
    } catch (e) {
      trendingError = e instanceof Error ? e.message : "Trending extraction error";
    }
  } else {
    trendingError = "OPENAI_API_KEY missing";
  }

  return Response.json({
    ok: true,
    sources: results.length,
    results,
    curated,
    curation: {
      method: curationMethod,
      error: curationError ?? null,
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    },
    trending: {
      extracted: trendingExtracted,
      enriched: trendingEnriched,
      inserted: trendingInserted,
      seeded_to_restaurants: trendingSeeded,
      method: trendingMethod,
      error: trendingError ?? null,
    },
  });
}
