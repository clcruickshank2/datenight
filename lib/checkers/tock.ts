import "server-only";
import type { Profile } from "@/lib/supabase-server";
import type { Restaurant } from "@/lib/supabase-server";

/**
 * Result of an availability check. slots are in a generic shape for now.
 */
export type CheckResult = {
  success: boolean;
  error?: string;
  slots: Array<{ time?: string; date?: string; [k: string]: unknown }>;
};

/**
 * Tock does not provide a public API for availability (see Tock API FAQ).
 * This stub records that we ran a check and returns no slots.
 * When Tock adds an API or we have a safe public method (e.g. Hop Alley),
 * implement the real check here.
 */
export async function checkTockAvailability(
  _restaurant: Restaurant,
  _profile: Profile
): Promise<CheckResult> {
  return {
    success: true,
    slots: [],
    error: "Tock does not provide a public availability API; check recorded for pipeline.",
  };
}
