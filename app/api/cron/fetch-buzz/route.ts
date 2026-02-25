import { NextRequest } from "next/server";
import {
  fetchBuzzSourcesWithFeeds,
  fetchBuzzSources,
  fetchRecentBuzzArticlesForCuration,
  upsertBuzzArticles,
  clearBuzzCuratedRanks,
  setBuzzCuratedRanksById,
} from "@/lib/buzz-server";
import { fallbackCuratedArticleIds, pickCuratedArticleIds } from "@/lib/buzz-curate";
import { parseRss, normalizePubDate } from "@/lib/rss";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS_PER_FEED = 30;

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
        let ids = llm.ids;
        if (ids.length >= 5) {
          curationMethod = "llm";
        } else {
          curationError = llm.error ?? "LLM returned fewer than 5 picks";
          ids = fallbackCuratedArticleIds(recent, sourceNames);
          if (ids.length >= 5) curationMethod = "fallback";
        }
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
  });
}
