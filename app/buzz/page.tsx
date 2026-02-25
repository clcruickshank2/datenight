import {
  fetchBuzzArticles,
  fetchBuzzSources,
  fetchBuzzPreferencesSourceIds,
  fetchBuzzRestaurants,
} from "@/lib/buzz-server";

const CURATED_LIMIT = 5;
const TRENDING_LIMIT = 15;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSourceLogoUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(baseUrl)}&sz=128`;
}

function shouldShowArticleImage(sourceId: string, imageUrl: string | null): boolean {
  // Prefer source-logo fallback for noisy sources and untrusted image hosts.
  if (sourceId === "reddit-denverfood") return false;
  if (!imageUrl) return false;
  if (!/^https?:\/\//i.test(imageUrl)) return false;
  if (/reddit|preview\.redd\.it|external-preview\.redd\.it/i.test(imageUrl)) return false;
  return true;
}

function formatPriceLevel(priceLevel: number | null): string {
  if (priceLevel == null) return "—";
  const n = Math.max(1, Math.min(4, Math.round(priceLevel)));
  return "$".repeat(n);
}

function getDisplayTags(tags: string[]): string[] {
  return tags
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 24)
    .filter((t) => !/[.!?]/.test(t))
    .slice(0, 5);
}

export default async function BuzzPage() {
  let articles: Awaited<ReturnType<typeof fetchBuzzArticles>> = [];
  let sources: Awaited<ReturnType<typeof fetchBuzzSources>> = [];
  let sourceIds: string[] | null = null;
  let restaurants: Awaited<ReturnType<typeof fetchBuzzRestaurants>> = [];

  try {
    sources = await fetchBuzzSources();
    sourceIds = await fetchBuzzPreferencesSourceIds();
    articles = await fetchBuzzArticles(CURATED_LIMIT, sourceIds ?? undefined);
    restaurants = await fetchBuzzRestaurants(TRENDING_LIMIT);
  } catch {
    // Config or Supabase missing; show empty state
  }

  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const hasCuratedPicks = articles.some((a) => a.curated_rank != null);

  return (
    <main>
      <h1 className="text-2xl font-semibold text-slate-900">The Buzz</h1>
      <p className="mt-2 text-slate-600">
        Curated articles to stay on top of the Denver food scene. Updated weekly.
      </p>

      {articles.length === 0 ? (
        <div className="mt-8 card border-dashed border-slate-300 bg-slate-50/50">
          <p className="text-slate-600">
            No articles yet. The weekly cron will fetch from 5280, Westword, Eater Denver, 303 Magazine, r/denverfood, and New Denizen. Run it once manually or wait for the next run.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            To backfill now: <code className="rounded bg-slate-200 px-1">GET /api/cron/fetch-buzz</code> with <code className="rounded bg-slate-200 px-1">Authorization: Bearer YOUR_CRON_SECRET</code>.
          </p>
        </div>
      ) : (
        <section className="mt-8 space-y-6">
          <h2 className="text-lg font-medium text-slate-900">
            {hasCuratedPicks ? "Editor’s picks this week" : "Latest articles"}
          </h2>
          {!hasCuratedPicks && (
            <p className="text-sm text-slate-500">
              Run the weekly cron with OPENAI_API_KEY set to get 5 curated picks instead of just the latest.
            </p>
          )}
          <ul className="space-y-4">
            {articles.map((a) => (
              <li key={a.id} className="card">
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0"
                  >
                    {shouldShowArticleImage(a.source_id, a.image_url) ? (
                      <img
                        src={a.image_url ?? undefined}
                        alt=""
                        className="h-24 w-full rounded-lg object-cover sm:h-28 sm:w-40"
                      />
                    ) : (
                      <div className="flex h-24 w-full flex-col items-center justify-center rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 px-3 text-center sm:h-28 sm:w-40">
                        {getSourceLogoUrl(sourceById.get(a.source_id)?.base_url) && (
                          <img
                            src={getSourceLogoUrl(sourceById.get(a.source_id)?.base_url) ?? undefined}
                            alt=""
                            className="mb-2 h-7 w-7 rounded"
                          />
                        )}
                        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-600">
                          {cleanText(sourceMap.get(a.source_id) ?? a.source_id)}
                        </span>
                      </div>
                    )}
                  </a>
                  <div className="min-w-0 flex-1">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-slate-900 hover:text-teal-700 hover:underline"
                    >
                      {cleanText(a.title)}
                    </a>
                    <div className="mt-1 text-sm text-slate-500">
                      {cleanText(sourceMap.get(a.source_id) ?? a.source_id)}
                      {a.published_at && (
                        <>
                          {" · "}
                          {new Date(a.published_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </>
                      )}
                    </div>
                    {a.summary && (
                      <p className="mt-2 line-clamp-2 text-sm text-slate-600">
                        {cleanText(a.summary)}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium text-slate-900">Trending restaurants</h2>
        <p className="mt-1 text-sm text-slate-500">
          Restaurants getting buzz in Denver food coverage, enriched with neighborhood, vibe, price, and rating.
        </p>
        {restaurants.length === 0 ? (
          <div className="mt-4 card border-dashed border-slate-300 bg-slate-50/50">
            <p className="text-slate-600">No trending restaurants yet. Run the Buzz cron to extract and enrich them from curated coverage.</p>
          </div>
        ) : (
          <div className="mt-4">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="w-[22%] py-2 pr-2 font-medium">Restaurant</th>
                  <th className="w-[14%] py-2 pr-2 font-medium">Neighborhood</th>
                  <th className="w-[8%] py-2 pr-2 font-medium">Price</th>
                  <th className="w-[22%] py-2 pr-2 font-medium">Tags</th>
                  <th className="w-[28%] py-2 pr-2 font-medium">Overview</th>
                  <th className="w-[6%] py-2 font-medium text-right">Rating</th>
                </tr>
              </thead>
              <tbody>
                {restaurants.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="py-3 pr-2">
                      <div className="flex items-center gap-2">
                        {r.image_url && (
                          <img
                            src={r.image_url}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded object-cover"
                          />
                        )}
                        <span>
                          {r.website_url ? (
                            <a
                              href={r.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-slate-900 hover:text-teal-700 hover:underline"
                            >
                              {r.name}
                            </a>
                          ) : (
                            <span className="font-medium text-slate-900">{r.name}</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 pr-2 text-slate-600">{r.neighborhood ?? "—"}</td>
                    <td className="py-3 pr-2 text-slate-700">{formatPriceLevel(r.price_level)}</td>
                    <td className="max-w-[220px] py-3 pr-2 text-slate-600">
                      {getDisplayTags(r.cuisine_vibes).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {getDisplayTags(r.cuisine_vibes).map((tag) => (
                            <span
                              key={`${r.id}-${tag}`}
                              className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-[460px] py-3 pr-2 text-slate-600 line-clamp-4">
                      {r.overview ?? "—"}
                    </td>
                    <td className="py-3 text-right">
                      {r.google_rating != null ? (
                        <span className="text-slate-700">{r.google_rating.toFixed(1)}/5</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
