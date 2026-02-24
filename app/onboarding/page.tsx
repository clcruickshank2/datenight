import Link from "next/link";
import { fetchProfile, fetchRestaurantsForProfile } from "@/lib/supabase-server";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  let profile;
  let restaurantCount = 0;
  try {
    profile = await fetchProfile();
    const restaurants = await fetchRestaurantsForProfile();
    restaurantCount = restaurants.length;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Configuration error";
    return (
      <main className="min-h-screen p-8 max-w-2xl">
        <h1 className="text-2xl font-bold">Onboarding</h1>
        <p className="mt-4 text-red-600">{message}</p>
        <p className="mt-2 text-sm text-gray-600">
          Set PROFILE_ID (and Supabase env) in your environment.
        </p>
        <Link href="/" className="mt-4 inline-block text-blue-600 hover:underline">
          ← Home
        </Link>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="min-h-screen p-8 max-w-2xl">
        <h1 className="text-2xl font-bold">Onboarding</h1>
        <p className="mt-4 text-gray-600">Profile not found. Check PROFILE_ID.</p>
        <Link href="/" className="mt-4 inline-block text-blue-600 hover:underline">
          ← Home
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl">
      <div className="mb-6 flex items-center gap-4">
        <Link href="/" className="text-blue-600 hover:underline">
          ← Home
        </Link>
        <h1 className="text-2xl font-bold">Onboarding</h1>
      </div>
      <p className="mb-8 text-gray-600">
        Set your reservation preferences and add restaurants you want to monitor.
      </p>
      <OnboardingForm
        profile={{
          ...profile,
          time_window_start: profile.time_window_start,
          time_window_end: profile.time_window_end,
        }}
        existingRestaurantCount={restaurantCount}
      />
    </main>
  );
}
