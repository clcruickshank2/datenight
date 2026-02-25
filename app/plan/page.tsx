import Link from "next/link";
import { fetchProfile, fetchRestaurantsForProfile, type Restaurant } from "@/lib/supabase-server";

function pickBestRestaurant(restaurants: Restaurant[]): Restaurant | null {
  const withLink = restaurants.find((r) => r.booking_url);
  if (withLink) return withLink;
  const active = restaurants.find((r) => r.status === "active");
  if (active) return active;
  return restaurants[0] ?? null;
}

export default async function PlanPage() {
  let profile = null;
  let restaurants: Restaurant[] = [];
  let configError: string | null = null;

  try {
    profile = await fetchProfile();
    restaurants = await fetchRestaurantsForProfile();
  } catch (e) {
    configError = e instanceof Error ? e.message : "Configuration error";
  }

  const best = pickBestRestaurant(restaurants);

  return (
    <main>
      <h1 className="text-2xl font-semibold text-slate-900">Make a plan</h1>
      <p className="mt-2 text-slate-600">
        What do you want to do? We’ll use your preferences to suggest restaurants and check availability.
      </p>

      {configError && (
        <div className="mt-6 card border-amber-200 bg-amber-50">
          <p className="text-amber-800">{configError}. Set PROFILE_ID and Supabase env.</p>
        </div>
      )}

      {!configError && profile && (
        <>
          <p className="mt-4 text-sm text-slate-500">
            Hi, {profile.display_name} · Party of {profile.party_size} · Prefer {profile.time_window_start.slice(0, 5)}–{profile.time_window_end.slice(0, 5)}
          </p>

          <section className="mt-8">
            <h2 className="text-lg font-medium text-slate-900">Best table for tonight</h2>
            {best ? (
              <div className="mt-4 card">
                <div className="font-medium text-slate-900">{best.name}</div>
                {best.neighborhood && (
                  <div className="text-sm text-slate-500">{best.neighborhood}</div>
                )}
                {best.booking_url ? (
                  <a
                    href={best.booking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary mt-3"
                  >
                    Book this table →
                  </a>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No booking link yet.</p>
                )}
              </div>
            ) : (
              <div className="mt-4 card border-dashed border-slate-300 bg-slate-50/50">
                <p className="text-slate-600">
                  No restaurants yet.{" "}
                  <Link href="/onboarding" className="font-medium text-teal-700 hover:underline">
                    Add some in onboarding
                  </Link>
                  .
                </p>
              </div>
            )}
          </section>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/onboarding" className="text-sm font-medium text-teal-700 hover:underline">
              Edit preferences
            </Link>
            <Link href="/restaurants" className="text-sm font-medium text-teal-700 hover:underline">
              All restaurants
            </Link>
          </div>
        </>
      )}

      {!configError && !profile && (
        <div className="mt-6 card">
          <p className="text-slate-600">Profile not found. Set PROFILE_ID to a valid profile id.</p>
        </div>
      )}

      <div className="mt-10 rounded-xl border border-dashed border-slate-300 bg-white/50 p-6 text-center text-sm text-slate-500">
        Coming soon: chat-style planning and availability-first search
      </div>
    </main>
  );
}
