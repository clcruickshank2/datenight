import { fetchProfile } from "@/lib/supabase-server";
import { PlanClient } from "./plan-client";

export default async function PlanPage() {
  let profile = null;
  let configError: string | null = null;

  try {
    profile = await fetchProfile();
  } catch (e) {
    configError = e instanceof Error ? e.message : "Configuration error";
  }

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
        <PlanClient profile={profile} />
      )}

      {!configError && !profile && (
        <div className="mt-6 card">
          <p className="text-slate-600">Profile not found. Set PROFILE_ID to a valid profile id.</p>
        </div>
      )}
    </main>
  );
}
