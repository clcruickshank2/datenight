import "server-only";

/**
 * Server-only Supabase REST helpers. No extra deps; uses fetch.
 */

const getConfig = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const profileId = process.env.PROFILE_ID;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!profileId) throw new Error("Missing PROFILE_ID");
  return { url, key, profileId };
};

const headers = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

export type Profile = {
  id: string;
  display_name: string;
  phone_e164: string | null;
  party_size: number;
  time_window_start: string;
  time_window_end: string;
  neighborhoods: string[];
  price_min: number;
  price_max: number;
  vibe_tags: string[];
  hard_nos: string[];
  notify_window_start: string;
  notify_window_end: string;
  timezone: string;
  created_at: string;
  updated_at: string;
};

export type Restaurant = {
  id: string;
  profile_id: string;
  name: string;
  neighborhood: string | null;
  price_level: number | null;
  vibe_tags: string[];
  status: string;
  platform: string | null;
  platform_restaurant_id: string | null;
  booking_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export async function fetchProfile(): Promise<Profile | null> {
  const { url, key, profileId } = getConfig();
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${profileId}&select=*`, {
    headers: headers(key),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Profile[];
  return rows[0] ?? null;
}

export async function fetchRestaurantsForProfile(): Promise<Restaurant[]> {
  const { url, key, profileId } = getConfig();
  const res = await fetch(
    `${url}/rest/v1/restaurants?profile_id=eq.${profileId}&select=id,name,neighborhood,price_level,status,booking_url,platform,notes,vibe_tags&order=name.asc`,
    { headers: headers(key), cache: "no-store" }
  );
  if (!res.ok) return [];
  return (await res.json()) as Restaurant[];
}

export async function updateProfile(patch: Partial<Profile>): Promise<{ error?: string }> {
  const { url, key, profileId } = getConfig();
  const res = await fetch(`${url}/rest/v1/profiles?id=eq.${profileId}`, {
    method: "PATCH",
    headers: headers(key),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}

export async function insertRestaurants(rows: { name: string; neighborhood?: string; booking_url?: string; platform?: string; notes?: string }[]): Promise<{ error?: string }> {
  const { url, key, profileId } = getConfig();
  const body = rows.map((r) => ({
    profile_id: profileId,
    name: r.name.trim(),
    neighborhood: r.neighborhood?.trim() || null,
    booking_url: r.booking_url?.trim() || null,
    platform: r.platform?.trim() || null,
    notes: r.notes?.trim() || null,
    status: "backlog",
    vibe_tags: [],
  }));
  const res = await fetch(`${url}/rest/v1/restaurants?on_conflict=profile_id,name`, {
    method: "POST",
    headers: {
      ...headers(key),
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}

// --- Availability checks & alerts (monitoring pipeline) ---

export type AvailabilityCheckRow = {
  profile_id: string;
  restaurant_id: string;
  platform: string;
  party_size: number;
  search_start: string | null;
  search_end: string | null;
  success: boolean;
  error: string | null;
  slots: unknown; // jsonb array
};

export async function insertAvailabilityCheck(row: AvailabilityCheckRow): Promise<{ error?: string }> {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/rest/v1/availability_checks`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}

export type AlertRow = {
  profile_id: string;
  primary_restaurant_id: string;
  status: string;
  channel: string;
  recommendation: Record<string, unknown>;
  reasons: string[];
};

export async function insertAlert(row: AlertRow): Promise<{ error?: string; id?: string }> {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/rest/v1/alerts`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  const created = (await res.json()) as { id?: string }[];
  return { id: created[0]?.id };
}

export async function updateAlert(id: string, patch: { sent_at?: string; status?: string; twilio_message_sid?: string; error?: string }): Promise<{ error?: string }> {
  const { url, key } = getConfig();
  const res = await fetch(`${url}/rest/v1/alerts?id=eq.${id}`, {
    method: "PATCH",
    headers: headers(key),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `Supabase ${res.status}: ${text}` };
  }
  return {};
}
