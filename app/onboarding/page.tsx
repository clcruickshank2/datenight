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
      <main>
        <h1 className="text-2xl font-semibold text-slate-900">Onboarding</h1>
        <div className="mt-4 card border-amber-200 bg-amber-50">
          <p className="text-amber-800">{message}</p>
          <p className="mt-2 text-sm text-amber-700">Set PROFILE_ID (and Supabase env) in your environment.</p>
        </div>
        <Link href="/plan" className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
      </main>
    );
  }

  if (!profile) {
    return (
      <main>
        <h1 className="text-2xl font-semibold text-slate-900">Onboarding</h1>
        <p className="mt-4 text-slate-600">Profile not found. Check PROFILE_ID.</p>
        <Link href="/plan" className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
      </main>
    );
  }

  return (
    <main>
      <div className="mb-6 flex items-center gap-4">
        <Link href="/plan" className="text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Onboarding</h1>
      </div>
      <p className="mb-8 text-slate-600">
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
