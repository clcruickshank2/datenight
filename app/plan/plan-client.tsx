"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { Profile, Restaurant } from "@/lib/supabase-server";

export type PlanCriteria = {
  dateStart: string;
  dateEnd: string;
  partySize: number | null;
  vibeTags: string[];
};

type ChatMessage = { role: "user" | "bot"; text: string };

const VIBE_KEYWORDS = [
  "romantic",
  "casual",
  "lively",
  "cozy",
  "upscale",
  "intimate",
  "celebratory",
  "low-key",
  "trendy",
  "quiet",
  "outdoor",
  "date night",
  "cool",
  "italian",
];

function parseMessageForCriteria(text: string): Partial<PlanCriteria> {
  const lower = text.toLowerCase().trim();
  const out: Partial<PlanCriteria> = {};

  // Party size: "2", "two", "party of 4", "4 people"
  const partyMatch = lower.match(/(?:party of|for)\s*(\d+)|(\d+)\s*(?:people|guests|diners)?/);
  if (partyMatch) {
    const n = parseInt(partyMatch[1] || partyMatch[2] || "0", 10);
    if (n >= 1 && n <= 20) out.partySize = n;
  }
  const numOnly = lower.match(/^(\d+)$/);
  if (numOnly && !out.partySize) {
    const n = parseInt(numOnly[1], 10);
    if (n >= 1 && n <= 20) out.partySize = n;
  }

  // Vibes: match known keywords
  const foundVibes = VIBE_KEYWORDS.filter((v) => lower.includes(v));
  if (foundVibes.length) out.vibeTags = foundVibes;

  // When: tonight, tomorrow, next N weeks, next week, next friday, etc.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const addDays = (d: Date, n: number) => {
    const next = new Date(d);
    next.setDate(next.getDate() + n);
    return next.toISOString().slice(0, 10);
  };

  // "in the next three weeks", "next 3 weeks", "next two weeks"
  const nextWeeksMatch = lower.match(/\b(?:in the )?next (one|two|three|four|five|1|2|3|4|5)\s*weeks?\b/);
  if (nextWeeksMatch) {
    const w = { one: 1, two: 2, three: 3, four: 4, five: 5 }[nextWeeksMatch[1] as keyof object] ?? parseInt(nextWeeksMatch[1], 10) || 2;
    const days = Math.min(w * 7, 60);
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, days);
  }
  // "next week" (single week)
  else if (/\bnext week\b/.test(lower) && !out.dateStart) {
    const start = new Date(today);
    start.setDate(start.getDate() + 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    out.dateStart = start.toISOString().slice(0, 10);
    out.dateEnd = end.toISOString().slice(0, 10);
  }
  // "next month"
  else if (/\bnext month\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 31);
  }
  // "tonight" / "today"
  else if (/\btonight\b|\btoday\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = todayStr;
  }
  // "tomorrow"
  else if (/\btomorrow\b/.test(lower) && !out.dateStart) {
    const ts = addDays(today, 1);
    out.dateStart = ts;
    out.dateEnd = ts;
  }
  // "next Friday" / "this Friday"
  else if (/\b(?:next|this)\s*(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(lower) && !out.dateStart) {
    const days: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const match = lower.match(/\b(?:next|this)\s*(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/);
    const targetDay = match ? days[match[1]] : 5;
    const d = new Date(today);
    let diff = (targetDay - d.getDay() + 7) % 7;
    if (lower.includes("next ") && diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    const ts = d.toISOString().slice(0, 10);
    out.dateStart = ts;
    out.dateEnd = ts;
  }
  // "Friday or Saturday" with "weeks" → treat as date range
  else if (/\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(lower) && /\bweeks?\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 21);
  }
  // Fallback: user clearly mentioned time but we didn't parse — set next 2 weeks so we don't loop asking "when?"
  else if (!out.dateStart && /\b(when|friday|saturday|sunday|monday|tuesday|wednesday|thursday|week|tonight|tomorrow|next|month)\b/.test(lower)) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 14);
  }

  return out;
}

function getNextPrompt(criteria: PlanCriteria): string | null {
  if (!criteria.dateStart || !criteria.dateEnd) return "When are you thinking? (e.g. tonight, next Friday, next week)";
  if (criteria.partySize == null) return "How many people?";
  if (criteria.vibeTags.length === 0) return "Any vibe in mind? (e.g. romantic, casual, lively, cozy)";
  return null;
}

/** Normalize for match: "date-night" and "date night" both become "date night". */
function normalizeVibe(s: string): string {
  return s.toLowerCase().trim().replace(/-/g, " ");
}

function filterRestaurants(restaurants: Restaurant[], criteria: PlanCriteria): Restaurant[] {
  if (criteria.vibeTags.length === 0) return restaurants;
  const normalizedUserVibes = criteria.vibeTags.map(normalizeVibe).filter(Boolean);
  return restaurants.filter((r) => {
    const tags = (r.vibe_tags || []).map(normalizeVibe);
    if (tags.length === 0) return true; // no tags on restaurant → include (don't hide untagged places)
    return normalizedUserVibes.some((v) => tags.includes(v));
  });
}

type Props = {
  profile: Profile;
  restaurants: Restaurant[];
};

export function PlanClient({ profile, restaurants }: Props) {
  const defaultCriteria: PlanCriteria = useMemo(
    () => ({
      dateStart: "",
      dateEnd: "",
      partySize: profile.party_size,
      vibeTags: [...profile.vibe_tags],
    }),
    [profile.party_size, profile.vibe_tags]
  );

  const [criteria, setCriteria] = useState<PlanCriteria>(defaultCriteria);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "bot",
      text: "What do you want to do? Tell me when, how many people, and the vibe you're after—or skip the chat and fill in the details below.",
    },
  ]);
  const [input, setInput] = useState("");

  const updateCriteria = (patch: Partial<PlanCriteria>) => {
    setCriteria((c) => ({ ...c, ...patch }));
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);

    const parsed = parseMessageForCriteria(text);
    const nextCriteria = { ...criteria, ...parsed };
    if (parsed.dateStart != null) nextCriteria.dateStart = parsed.dateStart;
    if (parsed.dateEnd != null) nextCriteria.dateEnd = parsed.dateEnd;
    if (parsed.partySize != null) nextCriteria.partySize = parsed.partySize;
    if (parsed.vibeTags?.length) nextCriteria.vibeTags = [...new Set([...criteria.vibeTags, ...parsed.vibeTags])];
    setCriteria(nextCriteria);

    const nextPrompt = getNextPrompt(nextCriteria);
    if (nextPrompt) {
      setMessages((m) => [...m, { role: "bot", text: nextPrompt }]);
    } else {
      setMessages((m) => [
        ...m,
        { role: "bot", text: "Got it. Check your criteria below and see the matches." },
      ]);
    }
  };

  const curated = useMemo(() => filterRestaurants(restaurants, criteria), [restaurants, criteria]);
  const hasAnyCriteria = criteria.dateStart || criteria.dateEnd || criteria.partySize != null || criteria.vibeTags.length > 0;

  return (
    <div className="space-y-8">
      <p className="text-sm text-slate-500">
        Hi, {profile.display_name} · Defaults: party of {profile.party_size}, {profile.time_window_start.slice(0, 5)}–{profile.time_window_end.slice(0, 5)}
      </p>

      {/* Chat */}
      <section className="card">
        <h2 className="text-lg font-medium text-slate-900 mb-4">What do you want to do?</h2>
        <div className="space-y-3 max-h-64 overflow-y-auto">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <span
                className={`rounded-xl px-3 py-2 text-sm max-w-[85%] ${
                  msg.role === "user"
                    ? "bg-teal-700 text-white"
                    : "bg-slate-100 text-slate-800"
                }`}
              >
                {msg.text}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="e.g. Date night next Friday for 2, something romantic"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
          />
          <button type="button" onClick={sendMessage} className="btn-primary whitespace-nowrap">
            Send
          </button>
        </div>
      </section>

      {/* Criteria (below chat) */}
      <section className="card border-teal-200 bg-teal-50/30">
        <h2 className="text-lg font-medium text-slate-900 mb-3">Your plan criteria</h2>
        <p className="text-sm text-slate-600 mb-4">
          Edit anytime—or fill these out instead of chatting.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date from</label>
            <input
              type="date"
              value={criteria.dateStart}
              onChange={(e) => updateCriteria({ dateStart: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date to</label>
            <input
              type="date"
              value={criteria.dateEnd}
              onChange={(e) => updateCriteria({ dateEnd: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Party size</label>
            <input
              type="number"
              min={1}
              max={20}
              value={criteria.partySize ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                updateCriteria({ partySize: v === "" ? null : parseInt(v, 10) });
              }}
              placeholder="e.g. 2"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Vibes</label>
            <input
              type="text"
              value={criteria.vibeTags.join(", ")}
              onChange={(e) =>
                updateCriteria({
                  vibeTags: e.target.value
                    .split(/[,;]/)
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean),
                })
              }
              placeholder="e.g. romantic, casual, cozy"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
        </div>
      </section>

      {/* Curated list */}
      <section>
        <h2 className="text-lg font-medium text-slate-900">
          {hasAnyCriteria ? "Matches" : "Your restaurants"}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {criteria.vibeTags.length > 0
            ? `Showing places matching: ${criteria.vibeTags.join(", ")}.`
            : "Add vibes above to narrow the list."}
        </p>
        {restaurants.length === 0 ? (
          <div className="mt-4 card border-dashed border-slate-300 bg-slate-50/50">
            <p className="text-slate-600">
              No restaurants yet.{" "}
              <Link href="/onboarding" className="font-medium text-teal-700 hover:underline">
                Add some in onboarding
              </Link>
              .
            </p>
          </div>
        ) : curated.length === 0 ? (
          <div className="mt-4 card border-amber-200 bg-amber-50">
            <p className="text-amber-800">
              No restaurants match these vibes. Try different tags or clear vibes to see all.
            </p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {curated.map((r) => (
              <li key={r.id} className="card">
                <div className="font-medium text-slate-900">{r.name}</div>
                {r.neighborhood && (
                  <div className="text-sm text-slate-500">{r.neighborhood}</div>
                )}
                {r.booking_url ? (
                  <a
                    href={r.booking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary mt-3 inline-block"
                  >
                    Book →
                  </a>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No booking link yet.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/onboarding" className="text-sm font-medium text-teal-700 hover:underline">
          Edit preferences
        </Link>
        <Link href="/restaurants" className="text-sm font-medium text-teal-700 hover:underline">
          All restaurants
        </Link>
      </div>
    </div>
  );
}
