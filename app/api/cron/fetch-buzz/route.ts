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
const TRENDING_MIN_VALID_COUNT = 5;
const TRENDING_MIN_EVIDENCE_RATIO = 0.7;
const ARTICLE_EXCERPT_MAX_CHARS = 9000;

type TrendingRestaurantRow = {
  name: string;
  overview?: string;
  source_article_ids: string[];
  neighborhood?: string | null;
  price_level?: number | null;
  cuisine_vibes?: string[];
  google_rating?: number | null;
};

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

function extractArticleLikeHtml(html: string): string {
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");

  const candidates: string[] = [];
  const pushMatches = (re: RegExp) => {
    const matches = withoutNonContent.match(re);
    if (!matches) return;
    for (const m of matches) candidates.push(m);
  };

  pushMatches(/<article[\s\S]*?<\/article>/gi);
  pushMatches(/<main[\s\S]*?<\/main>/gi);
  pushMatches(/<(section|div)[^>]*(content|article|post|entry|story|body)[^>]*>[\s\S]*?<\/\1>/gi);

  if (candidates.length === 0) {
    return withoutNonContent;
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function stripKnownNoisePhrases(text: string): string {
  return text
    .replace(/\b(sign up|subscribe|newsletter|privacy policy|terms of use|cookie policy)\b/gi, " ")
    .replace(/\b(log in|login|register|my account)\b/gi, " ")
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
    const articleHtml = extractArticleLikeHtml(html);
    const text = stripKnownNoisePhrases(stripHtmlToText(articleHtml));
    // Keep prompt size reasonable while allowing long list-style articles.
    return text.slice(0, ARTICLE_EXCERPT_MAX_CHARS);
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNoise(name: string): boolean {
  const n = normalizeText(name);
  const blocked = [
    "subscribe",
    "newsletter",
    "newsletters",
    "sign up",
    "readers",
    "privacy",
    "policy",
    "terms",
    "account",
    "log in",
    "login",
    "register",
    "everywhere",
    "everything",
  ];
  return blocked.some((term) => n.includes(term));
}

function hasArticleEvidence(name: string, articleText: string): boolean {
  const needle = normalizeText(name);
  if (!needle) return false;
  const hay = normalizeText(articleText);
  if (!hay) return false;
  return hay.includes(needle);
}

function isSeedEligible(row: TrendingRestaurantRow): boolean {
  return Boolean(
    row.neighborhood ||
      (typeof row.price_level === "number" && row.price_level >= 1 && row.price_level <= 4) ||
      (Array.isArray(row.cuisine_vibes) && row.cuisine_vibes.length > 0) ||
      (typeof row.google_rating === "number" && row.google_rating >= 0 && row.google_rating <= 5)
  );
}

function evaluateTrendingQuality(
  restaurants: TrendingRestaurantRow[],
  articleTextById: Map<string, string>
): {
  passed: boolean;
  accepted: TrendingRestaurantRow[];
  validCount: number;
  evidenceCount: number;
  evidenceRatio: number;
  noiseFiltered: number;
  reason?: string;
} {
  const cleaned = restaurants.filter((r) => !looksLikeNoise(r.name));
  const accepted = cleaned.filter((r) => {
    const textFromLinkedIds = r.source_article_ids
      .map((id) => articleTextById.get(id) ?? "")
      .join(" ");
    return hasArticleEvidence(r.name, textFromLinkedIds);
  });

  const validCount = cleaned.length;
  const evidenceCount = accepted.length;
  const evidenceRatio = validCount > 0 ? evidenceCount / validCount : 0;
  const noiseFiltered = restaurants.length - cleaned.length;

  if (validCount < TRENDING_MIN_VALID_COUNT) {
    return {
      passed: false,
      accepted: [],
      validCount,
      evidenceCount,
      evidenceRatio,
      noiseFiltered,
      reason: `quality_gate_failed: only ${validCount} plausible rows (min ${TRENDING_MIN_VALID_COUNT})`,
    };
  }

  if (evidenceRatio < TRENDING_MIN_EVIDENCE_RATIO) {
    return {
      passed: false,
      accepted: [],
      validCount,
      evidenceCount,
      evidenceRatio,
      noiseFiltered,
      reason: `quality_gate_failed: evidence ratio ${evidenceRatio.toFixed(2)} below ${TRENDING_MIN_EVIDENCE_RATIO}`,
    };
  }

  return {
    passed: true,
    accepted,
    validCount,
    evidenceCount,
    evidenceRatio,
    noiseFiltered,
  };
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
  let trendingTelemetry: {
    llm_calls: number;
    request_ids: string[];
    stages: string[];
  } | null = null;
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
          summary: `${a.summary ?? ""} ${excerptById.get(a.id) ?? ""}`.trim().slice(0, 9000),
        }));
        const articleTextById = new Map(
          enriched.map((a) => [a.id, `${a.title} ${a.summary ?? ""}`])
        );

        const extracted = await extractTrendingRestaurants(enriched, sourceNames);
        trendingTelemetry = extracted.telemetry ?? null;
        trendingExtracted = extracted.extracted_count ?? extracted.restaurants.length;
        trendingEnriched = extracted.enriched_count ?? 0;
        if (extracted.restaurants.length > 0) {
          const quality = evaluateTrendingQuality(
            extracted.restaurants as TrendingRestaurantRow[],
            articleTextById
          );
          if (!quality.passed) {
            trendingMethod = extracted.method ?? "none";
            trendingError = [
              extracted.error,
              quality.reason,
              `quality_stats(valid=${quality.validCount}, evidence=${quality.evidenceCount}, evidence_ratio=${quality.evidenceRatio.toFixed(2)}, noise_filtered=${quality.noiseFiltered})`,
            ]
              .filter(Boolean)
              .join("; ");
            // Safeguard: keep last known-good trending rows. Do not overwrite or seed.
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
                telemetry: trendingTelemetry,
                error: trendingError ?? null,
              },
            });
          }

          const acceptedRows = quality.accepted;
          const clearErr = await clearBuzzRestaurants();
          if (clearErr.error) {
            trendingError = clearErr.error;
          } else {
            const insertErr = await insertBuzzRestaurants(acceptedRows);
            if (insertErr.error) {
              trendingError = insertErr.error;
            } else {
              trendingInserted = acceptedRows.length;
              trendingMethod = extracted.method ?? "llm";
              const seedableRows = acceptedRows.filter((row) =>
                isSeedEligible(row as TrendingRestaurantRow)
              );
              if (seedableRows.length > 0) {
                const seed = await upsertTrendingIntoRestaurants(seedableRows);
                if (seed.error) {
                  trendingError = trendingError
                    ? `${trendingError}; ${seed.error}`
                    : seed.error;
                } else {
                  trendingSeeded = seed.upserted;
                }
              } else {
                trendingError = [
                  trendingError,
                  "No enriched trending rows met seed eligibility; skipped seeding",
                ]
                  .filter(Boolean)
                  .join("; ");
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
      telemetry: trendingTelemetry,
      error: trendingError ?? null,
    },
  });
}
