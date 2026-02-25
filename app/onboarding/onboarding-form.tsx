"use client";

import { useState } from "react";
import { submitProfile, submitRestaurants, type ProfileForm, type RestaurantRow } from "./actions";

/** Profile shape from server (arrays); form state uses comma-separated strings. */
type ServerProfile = {
  display_name: string;
  party_size: number;
  time_window_start: string;
  time_window_end: string;
  neighborhoods: string[];
  price_min: number;
  price_max: number;
  vibe_tags: string[];
  hard_nos: string[];
  timezone: string;
};

type Props = {
  profile: ServerProfile;
  existingRestaurantCount: number;
};

function profileToForm(profile: ServerProfile): Record<keyof ProfileForm, string | number> {
  return {
    display_name: profile.display_name,
    party_size: profile.party_size,
    time_window_start: profile.time_window_start.slice(0, 5),
    time_window_end: profile.time_window_end.slice(0, 5),
    neighborhoods: profile.neighborhoods.join(", "),
    price_min: profile.price_min,
    price_max: profile.price_max,
    vibe_tags: profile.vibe_tags.join(", "),
    hard_nos: profile.hard_nos.join(", "),
    timezone: profile.timezone,
  };
}

const emptyRestaurant: RestaurantRow = { name: "", neighborhood: "", booking_url: "", platform: "" };

export function OnboardingForm({ profile, existingRestaurantCount }: Props) {
  const [form, setForm] = useState(profileToForm(profile));
  const [restaurants, setRestaurants] = useState<RestaurantRow[]>([{ ...emptyRestaurant }]);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const addRestaurant = () => setRestaurants((r) => [...r, { ...emptyRestaurant }]);
  const removeRestaurant = (i: number) =>
    setRestaurants((r) => (r.length <= 1 ? r : r.filter((_, j) => j !== i)));
  const setRestaurant = (i: number, field: keyof RestaurantRow, value: string) =>
    setRestaurants((r) => {
      const next = [...r];
      next[i] = { ...next[i], [field]: value };
      return next;
    });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const profileResult = await submitProfile(form as unknown as ProfileForm);
    if (profileResult.error) {
      setMessage({ type: "error", text: profileResult.error });
      return;
    }
    const restResult = await submitRestaurants(restaurants);
    if (restResult.error) {
      setMessage({ type: "error", text: restResult.error });
      return;
    }
    setMessage({ type: "ok", text: "Saved. You can go to the home page to see Book now." });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-xl">
      <section>
        <h2 className="text-xl font-semibold mb-4">Your preferences</h2>
        <div className="grid gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Display name</span>
            <input
              type="text"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.display_name}
              onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Party size</span>
            <input
              type="number"
              min={1}
              max={20}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.party_size}
              onChange={(e) => setForm((f) => ({ ...f, party_size: Number(e.target.value) || 2 }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Time window start</span>
              <input
                type="time"
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
                value={form.time_window_start}
                onChange={(e) => setForm((f) => ({ ...f, time_window_start: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Time window end</span>
              <input
                type="time"
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
                value={form.time_window_end}
                onChange={(e) => setForm((f) => ({ ...f, time_window_end: e.target.value }))}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-sm text-gray-600">Neighborhoods (comma-separated)</span>
            <input
              type="text"
              placeholder="e.g. RiNo, LoDo, Capitol Hill"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.neighborhoods}
              onChange={(e) => setForm((f) => ({ ...f, neighborhoods: e.target.value }))}
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Price min (1–4)</span>
              <input
                type="number"
                min={1}
                max={4}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
                value={form.price_min}
                onChange={(e) => setForm((f) => ({ ...f, price_min: Number(e.target.value) || 1 }))}
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Price max (1–4)</span>
              <input
                type="number"
                min={1}
                max={4}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
                value={form.price_max}
                onChange={(e) => setForm((f) => ({ ...f, price_max: Number(e.target.value) || 4 }))}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-sm text-gray-600">Vibe tags (comma-separated)</span>
            <input
              type="text"
              placeholder="e.g. romantic, outdoor, quiet"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.vibe_tags}
              onChange={(e) => setForm((f) => ({ ...f, vibe_tags: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Hard nos (comma-separated)</span>
            <input
              type="text"
              placeholder="e.g. too loud, no patio"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.hard_nos}
              onChange={(e) => setForm((f) => ({ ...f, hard_nos: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Timezone</span>
            <input
              type="text"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
              value={form.timezone}
              onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            />
          </label>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2">Seed restaurants</h2>
        {existingRestaurantCount > 0 && (
          <p className="text-sm text-gray-600 mb-4">You already have {existingRestaurantCount} restaurant(s). Add more below.</p>
        )}
        <div className="space-y-4">
          {restaurants.map((r, i) => (
            <div key={i} className="flex flex-wrap gap-2 items-end rounded border border-gray-200 p-3">
              <input
                type="text"
                placeholder="Restaurant name *"
                className="flex-1 min-w-[140px] rounded border border-gray-300 px-3 py-2"
                value={r.name}
                onChange={(e) => setRestaurant(i, "name", e.target.value)}
              />
              <input
                type="text"
                placeholder="Neighborhood"
                className="w-28 rounded border border-gray-300 px-3 py-2"
                value={r.neighborhood}
                onChange={(e) => setRestaurant(i, "neighborhood", e.target.value)}
              />
              <input
                type="url"
                placeholder="Booking URL"
                className="flex-1 min-w-[160px] rounded border border-gray-300 px-3 py-2"
                value={r.booking_url}
                onChange={(e) => setRestaurant(i, "booking_url", e.target.value)}
              />
              <input
                type="text"
                placeholder="Platform"
                className="w-24 rounded border border-gray-300 px-3 py-2"
                value={r.platform}
                onChange={(e) => setRestaurant(i, "platform", e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeRestaurant(i)}
                className="px-3 py-2 text-gray-600 hover:text-red-600"
                aria-label="Remove row"
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addRestaurant} className="text-sm text-teal-700 hover:underline">
            + Add restaurant
          </button>
        </div>
      </section>

      {message && (
        <p className={message.type === "error" ? "text-red-600" : "text-green-600"}>{message.text}</p>
      )}
      <button
        type="submit"
        className="btn-primary"
      >
        Save preferences & restaurants
      </button>
    </form>
  );
}
