"use server";

import { updateProfile as updateProfileDb, insertRestaurants } from "@/lib/supabase-server";

export type ProfileForm = {
  display_name: string;
  party_size: number;
  time_window_start: string;
  time_window_end: string;
  neighborhoods: string;
  price_min: number;
  price_max: number;
  vibe_tags: string;
  hard_nos: string;
  timezone: string;
};

export async function submitProfile(form: ProfileForm) {
  const neighborhoods = form.neighborhoods
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const vibe_tags = form.vibe_tags
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hard_nos = form.hard_nos
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const toTime = (s: string, fallback: string) =>
    !s ? fallback : s.length === 5 ? `${s}:00` : s;
  return updateProfileDb({
    display_name: form.display_name.trim() || "Default",
    party_size: Number(form.party_size) || 2,
    time_window_start: toTime(form.time_window_start, "18:00:00"),
    time_window_end: toTime(form.time_window_end, "21:00:00"),
    neighborhoods,
    price_min: Math.min(4, Math.max(1, Number(form.price_min) || 1)),
    price_max: Math.min(4, Math.max(1, Number(form.price_max) || 4)),
    vibe_tags,
    hard_nos,
    timezone: form.timezone.trim() || "America/Denver",
  });
}

export type RestaurantRow = {
  name: string;
  neighborhood: string;
  booking_url: string;
  platform: string;
};

export async function submitRestaurants(rows: RestaurantRow[]) {
  const valid = rows
    .map((r) => ({
      name: r.name?.trim() ?? "",
      neighborhood: r.neighborhood?.trim() || undefined,
      booking_url: r.booking_url?.trim() || undefined,
      platform: r.platform?.trim() || undefined,
    }))
    .filter((r) => r.name.length > 0);
  if (valid.length === 0) return {};
  return insertRestaurants(valid);
}
