import { NextRequest } from "next/server";
import { fetchBuzzSourcesWithFeeds, upsertBuzzArticles } from "@/lib/buzz-server";
import { parseRss, normalizePubDate } from "@/lib/rss";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS_PER_FEED = 30;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    return Response.json({ error: "CRON_SECRET missing" }, { status: 500 });
  }
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
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

  return Response.json({ ok: true, sources: results.length, results });
}
