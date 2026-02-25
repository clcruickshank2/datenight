import {
  fetchBuzzArticles,
  fetchBuzzSources,
  fetchBuzzPreferencesSourceIds,
} from "@/lib/buzz-server";

const CURATED_LIMIT = 5;

export default async function BuzzPage() {
  let articles: Awaited<ReturnType<typeof fetchBuzzArticles>> = [];
  let sources: Awaited<ReturnType<typeof fetchBuzzSources>> = [];
  let sourceIds: string[] | null = null;

  try {
    sources = await fetchBuzzSources();
    sourceIds = await fetchBuzzPreferencesSourceIds();
    articles = await fetchBuzzArticles(CURATED_LIMIT, sourceIds ?? undefined);
  } catch (e) {
    // Config or Supabase missing; show empty state
  }

  const sourceMap = new Map(sources.map((s) => [s.id, s.name]));

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
          <h2 className="text-lg font-medium text-slate-900">Curated this week</h2>
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

      <p className="mt-8 text-sm text-slate-500">
        Trending restaurants (from these articles) coming soon.
      </p>
    </main>
  );
}
