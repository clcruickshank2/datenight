import { NextRequest } from "next/server";
import {
  fetchProfile,
  fetchRestaurantsForProfile,
  insertAvailabilityCheck,
  insertAlert,
  updateAlert,
  type Profile,
  type Restaurant,
} from "@/lib/supabase-server";
import { checkTockAvailability } from "@/lib/checkers/tock";
import { sendSms } from "@/lib/twilio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function assertConfig() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.PROFILE_ID) {
    throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or PROFILE_ID");
  }
}

/**
 * Stub for platforms we don't have a checker for yet.
 */
async function checkStub(_restaurant: Restaurant, _profile: Profile): Promise<{ success: boolean; error?: string; slots: unknown[] }> {
  return { success: true, slots: [] };
}

function runChecker(restaurant: Restaurant, profile: Profile): Promise<{ success: boolean; error?: string; slots: unknown[] }> {
  const platform = (restaurant.platform ?? "").toLowerCase();
  if (platform === "tock") return checkTockAvailability(restaurant, profile);
  return checkStub(restaurant, profile);
}

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

  let profile: Profile;
  let restaurants: Restaurant[];
  try {
    assertConfig();
    const [p, r] = await Promise.all([fetchProfile(), fetchRestaurantsForProfile()]);
    if (!p) {
      return Response.json({ error: "Profile not found" }, { status: 404 });
    }
    profile = p;
    restaurants = r;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Config error";
    return Response.json({ error: message }, { status: 500 });
  }

  const now = new Date();
  const searchEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const searchStartIso = now.toISOString();
  const searchEndIso = searchEnd.toISOString();

  const results: { restaurant_id: string; platform: string; success: boolean; slots_count: number; alert_sent?: boolean }[] = [];

  for (const restaurant of restaurants) {
    const platform = restaurant.platform ?? "unknown";
    const result = await runChecker(restaurant, profile);

    const insertErr = await insertAvailabilityCheck({
      profile_id: profile.id,
      restaurant_id: restaurant.id,
      platform,
      party_size: profile.party_size,
      search_start: searchStartIso,
      search_end: searchEndIso,
      success: result.success,
      error: result.error ?? null,
      slots: result.slots ?? [],
    });
    if (insertErr.error) {
      results.push({ restaurant_id: restaurant.id, platform, success: false, slots_count: 0 });
      continue;
    }

    const slotsCount = Array.isArray(result.slots) ? result.slots.length : 0;
    let alertSent = false;

    if (slotsCount > 0 && restaurant.booking_url) {
      const alertRes = await insertAlert({
        profile_id: profile.id,
        primary_restaurant_id: restaurant.id,
        status: "queued",
        channel: "sms",
        recommendation: { slots: result.slots, booking_url: restaurant.booking_url, restaurant_name: restaurant.name },
        reasons: ["availability_found"],
      });
      if (alertRes.id && !alertRes.error && profile.phone_e164) {
        const message = `DateNight: Table available at ${restaurant.name}. Book now: ${restaurant.booking_url}`;
        const sms = await sendSms(profile.phone_e164, message);
        if (sms.sid) {
          await updateAlert(alertRes.id, { sent_at: new Date().toISOString(), status: "sent", twilio_message_sid: sms.sid });
          alertSent = true;
        } else {
          await updateAlert(alertRes.id, { status: "failed", error: sms.error ?? "Unknown" });
        }
      }
    }

    results.push({
      restaurant_id: restaurant.id,
      platform,
      success: result.success,
      slots_count: slotsCount,
      ...(alertSent && { alert_sent: true }),
    });
  }

  return Response.json({ ok: true, checked: results.length, results });
}
