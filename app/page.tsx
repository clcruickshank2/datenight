import Link from "next/link";
import { fetchProfile, fetchRestaurantsForProfile, type Restaurant } from "@/lib/supabase-server";

function pickBestRestaurant(restaurants: Restaurant[]): Restaurant | null {
  const withLink = restaurants.find((r) => r.booking_url);
  if (withLink) return withLink;
  const active = restaurants.find((r) => r.status === "active");
  if (active) return active;
  return restaurants[0] ?? null;
}

export default async function Home() {
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
    <main className="min-h-screen flex flex-col p-8 max-w-2xl">
      <h1 className="text-3xl font-bold">DateNight</h1>

      {configError && (
        <p className="mt-4 text-red-600">
          {configError}. Set PROFILE_ID and Supabase env.
        </p>
      )}

      {!configError && profile && (
        <>
          <p className="mt-2 text-gray-600">
            Hi, {profile.display_name}. Party size: {profile.party_size}. Prefer {profile.time_window_start.slice(0, 5)}–{profile.time_window_end.slice(0, 5)}.
          </p>

          <section className="mt-8">
            <h2 className="text-xl font-semibold">Book now</h2>
            {best ? (
              <div className="mt-4 rounded-lg border border-gray-200 p-4">
                <div className="font-semibold">{best.name}</div>
                {best.neighborhood && (
                  <div className="text-sm text-gray-600">{best.neighborhood}</div>
                )}
                {best.booking_url ? (
                  <a
                    href={best.booking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block rounded bg-green-600 text-white px-4 py-2 hover:bg-green-700"
                  >
                    Book this table →
                  </a>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">No booking link yet.</p>
                )}
              </div>
            ) : (
              <p className="mt-4 text-gray-600">
                No restaurants yet.{" "}
                <Link href="/onboarding" className="text-blue-600 hover:underline">
                  Add some in onboarding
                </Link>
                .
              </p>
            )}
          </section>
        </>
      )}

      {!configError && !profile && (
        <p className="mt-4 text-gray-600">
          Profile not found. Set PROFILE_ID to a valid profile id.
        </p>
      )}

      <nav className="mt-8 flex gap-4">
        <Link href="/onboarding" className="text-blue-600 hover:underline">
          Onboarding
        </Link>
        <Link href="/restaurants" className="text-blue-600 hover:underline">
          Restaurants
        </Link>
      </nav>
    </main>
  );
}
