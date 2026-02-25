import {
  fetchBuzzArticles,
  fetchBuzzSources,
  fetchBuzzPreferencesSourceIds,
  fetchBuzzRestaurants,
} from "@/lib/buzz-server";

const CURATED_LIMIT = 5;
const TRENDING_LIMIT = 15;

function formatPriceLevel(priceLevel: number | null): string {
  if (priceLevel == null) return "—";
  const n = Math.max(1, Math.min(4, Math.round(priceLevel)));
  return "$".repeat(n);
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
                  {a.image_url && (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                    >
                      <img
                        src={a.image_url}
                        alt=""
                        className="h-24 w-full rounded-lg object-cover sm:h-28 sm:w-40"
                      />
                    </a>
                  )}
                  <div className="min-w-0 flex-1">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-slate-900 hover:text-teal-700 hover:underline"
                    >
                      {a.title}
                    </a>
                    <div className="mt-1 text-sm text-slate-500">
                      {sourceMap.get(a.source_id) ?? a.source_id}
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
                      <p className="mt-2 line-clamp-2 text-sm text-slate-600">{a.summary}</p>
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
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-2 font-medium">Restaurant</th>
                  <th className="py-2 pr-2 font-medium">Neighborhood</th>
                  <th className="py-2 pr-2 font-medium">Price</th>
                  <th className="py-2 pr-2 font-medium">Cuisine/Vibes</th>
                  <th className="py-2 pr-2 font-medium">Overview</th>
                  <th className="py-2 w-20 font-medium text-right">Rating</th>
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
                    <td className="max-w-[220px] py-3 pr-2 text-slate-600 line-clamp-2">
                      {r.cuisine_vibes.length > 0 ? r.cuisine_vibes.join(", ") : "—"}
                    </td>
                    <td className="max-w-[260px] py-3 pr-2 text-slate-600 line-clamp-2">
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
