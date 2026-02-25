"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Profile } from "@/lib/supabase-server";

export type PlanCriteria = {
  dateStart: string;
  dateEnd: string;
  partySize: number | null;
  vibeTags: string[];
  minPrice: number | null;
  maxPrice: number | null;
};

type ChatMessage = { role: "user" | "bot"; text: string };

type UiRecommendation = {
  id: string;
  name: string;
  neighborhood: string | null;
  priceLevel: number | null;
  bookingUrl: string | null;
  source: "db" | "web";
  reason: string;
  tradeoff: string;
  googleRating: number | null;
  ratingSource: string | null;
};

type RecommendResponse = {
  recommendations: UiRecommendation[];
  confidence: number;
  sourceMode: "db" | "hybrid";
  debug: {
    mode: string;
    baseCandidateCount: number;
    filteredCandidateCount: number;
    workingCandidateCount: number;
    webAdded: number;
    llmRerankUsed: boolean;
    offset: number;
    constraintRelaxed?: boolean;
    googleLiveEnrichedCount?: number;
    hasGoogleMapsKey?: boolean;
    requestedCount?: number;
    preWebCount?: number;
    excludeCount?: number;
  };
};

const PREFERENCE_KEYWORDS = [
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
  "mexican",
  "japanese",
  "sushi",
  "korean",
  "chinese",
  "thai",
  "vietnamese",
  "french",
  "spanish",
  "mediterranean",
  "steakhouse",
  "seafood",
  "pizza",
  "brunch",
  "cocktails",
  "vegetarian",
  "vegan",
  "gluten free",
  "gluten-free",
];

const STOPWORD_PREFS = new Set([
  "a",
  "an",
  "the",
  "place",
  "spot",
  "restaurant",
  "restaurants",
  "food",
  "for",
  "something",
  "with",
  "that",
  "and",
  "or",
  "to",
  "of",
  "in",
  "near",
]);

function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniquePhrases(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const normalized = normalizePhrase(raw);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function extractFreeformPreferences(lower: string): string[] {
  const chunks: string[] = [];
  const BLOCKLIST = new Set([
    "next",
    "week",
    "weeks",
    "tonight",
    "today",
    "tomorrow",
    "friday",
    "saturday",
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "party",
    "people",
    "guests",
    "diners",
    "under",
    "between",
    "budget",
  ]);

  const patterns = [
    /(?:preference for|prefer)\s+([^.!?]+)/g,
    /(?:looking for|look for)\s+([^.!?]+)/g,
    /(?:something)\s+([^.!?]+)/g,
    /(?:want)\s+([^.!?]+)/g,
  ];

  for (const pattern of patterns) {
    const matches = lower.matchAll(pattern);
    for (const m of matches) {
      if (m[1]) chunks.push(m[1]);
    }
  }

  const tokens: string[] = [];
  for (const chunk of chunks) {
    const parts = chunk.split(/[,/&]|\band\b|\bor\b/);
    for (const part of parts) {
      const pref = normalizePhrase(part);
      if (!pref) continue;
      if (STOPWORD_PREFS.has(pref)) continue;
      if (pref.length <= 2) continue;
      if (pref.split(" ").length > 4) continue;
      const words = pref.split(" ");
      if (words.some((w) => BLOCKLIST.has(w))) continue;
      tokens.push(pref);
    }
  }

  return tokens;
}

function parseMessageForCriteria(text: string): Partial<PlanCriteria> {
  const lower = text.toLowerCase().trim();
  const out: Partial<PlanCriteria> = {};

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

  const foundByKeyword = PREFERENCE_KEYWORDS.filter((v) => lower.includes(v));
  const foundFreeform = extractFreeformPreferences(lower);
  const prefs = uniquePhrases([...foundByKeyword, ...foundFreeform]);
  if (prefs.length) out.vibeTags = prefs;

  const between = lower.match(/between\s*(\${1,4})\s*and\s*(\${1,4})/);
  if (between) {
    const a = between[1].length;
    const b = between[2].length;
    out.minPrice = Math.min(a, b);
    out.maxPrice = Math.max(a, b);
  } else {
    const under = lower.match(/(?:under|up to|max)\s*(\${1,4})/);
    if (under) out.maxPrice = under[1].length;
    const exact = lower.match(/\${1,4}/);
    if (exact && out.minPrice == null && out.maxPrice == null) {
      out.minPrice = exact[0].length;
      out.maxPrice = exact[0].length;
    }
  }

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

  const nextWeeksMatch = lower.match(/\b(?:in the )?next (one|two|three|four|five|1|2|3|4|5)\s*weeks?\b/);
  if (nextWeeksMatch) {
    const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 } as const;
    const token = nextWeeksMatch[1]!;
    const w =
      (token in WORD_TO_NUM ? WORD_TO_NUM[token as keyof typeof WORD_TO_NUM] : undefined) ??
      (parseInt(token, 10) || 2);
    const days = Math.min(w * 7, 60);
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, days);
  } else if (/\bnext week\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 7);
  } else if (/\bnext month\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 31);
  } else if (/\btonight\b|\btoday\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = todayStr;
  } else if (/\btomorrow\b/.test(lower) && !out.dateStart) {
    const ts = addDays(today, 1);
    out.dateStart = ts;
    out.dateEnd = ts;
  } else if (/\b(?:next|this)\s*(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(lower) && !out.dateStart) {
    const days: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const match = lower.match(/\b(?:next|this)\s*(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/);
    const targetDay = match ? days[match[1]] : 5;
    const d = new Date(today);
    let diff = (targetDay - d.getDay() + 7) % 7;
    if (lower.includes("next ") && diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    const ts = d.toISOString().slice(0, 10);
    out.dateStart = ts;
    out.dateEnd = ts;
  } else if (/\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(lower) && /\bweeks?\b/.test(lower) && !out.dateStart) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 21);
  } else if (!out.dateStart && /\b(when|friday|saturday|sunday|monday|tuesday|wednesday|thursday|week|tonight|tomorrow|next|month)\b/.test(lower)) {
    out.dateStart = todayStr;
    out.dateEnd = addDays(today, 14);
  }

  return out;
}

function getNextPrompt(criteria: PlanCriteria): string | null {
  if (!criteria.dateStart || !criteria.dateEnd) {
    return "When are you thinking? (e.g. tonight, next Friday, next week)";
  }
  if (criteria.partySize == null) return "How many people?";
  if (criteria.vibeTags.length === 0) {
    return "Any vibe or cuisine in mind? (e.g. romantic, cozy, italian, sushi)";
  }
  return null;
}

function isCriteriaComplete(criteria: PlanCriteria): boolean {
  return Boolean(
    criteria.dateStart &&
      criteria.dateEnd &&
      criteria.partySize != null &&
      criteria.vibeTags.length > 0
  );
}

function isRecommendationRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return /(recommend|recommendation|suggest|best option|what do you recommend)/.test(
    lower
  );
}

function wantsDifferentRecommendations(text: string): boolean {
  const lower = text.toLowerCase();
  return /(different|another|new)\s+(recommendation|option|pick|one)/.test(lower);
}

function wantsBroaden(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(broaden|broader|expand|widen)\b/.test(lower) && /\b(search|options|results)\b/.test(lower);
}

function wantsTighten(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(tighten|narrow|stricter|more focused|focus)\b/.test(lower) &&
    /\b(recommendation|recommendations|options|results|search)\b/.test(lower);
}

function parseVibeInput(value: string): string[] {
  return uniquePhrases(value.split(/[,;]/));
}

type Props = {
  profile: Profile;
};

export function PlanClient({ profile }: Props) {
  const defaultCriteria: PlanCriteria = useMemo(
    () => ({
      dateStart: "",
      dateEnd: "",
      partySize: profile.party_size,
      // Start empty so chat intent drives tags instead of sticky defaults.
      vibeTags: [],
      // If user doesn't specify budget, default to full range.
      minPrice: 1,
      maxPrice: 4,
    }),
    [profile.party_size]
  );

  const [criteria, setCriteria] = useState<PlanCriteria>(defaultCriteria);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "bot",
      text: "What do you want to do? Tell me when, how many people, and the vibe or cuisine you are after, or skip chat and fill the criteria below.",
    },
  ]);
  const [input, setInput] = useState("");
  const [vibeInput, setVibeInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [lastChatSource, setLastChatSource] = useState<"llm" | "fallback" | null>(
    null
  );
  const [debugInfo, setDebugInfo] = useState<string>("No request sent yet.");
  const [recommendationOffset, setRecommendationOffset] = useState(0);
  const [recommendations, setRecommendations] = useState<UiRecommendation[]>([]);
  const [confidence, setConfidence] = useState(0);
  const [sourceMode, setSourceMode] = useState<"db" | "hybrid">("db");
  const [recDebug, setRecDebug] = useState("No recommendation call yet.");

  const updateCriteria = (patch: Partial<PlanCriteria>) => {
    setCriteria((c) => {
      const next = { ...c, ...patch };
      if (patch.vibeTags) next.vibeTags = uniquePhrases(patch.vibeTags);
      if (next.minPrice != null && next.maxPrice != null && next.minPrice > next.maxPrice) {
        const t = next.minPrice;
        next.minPrice = next.maxPrice;
        next.maxPrice = t;
      }
      return next;
    });
  };

  const fetchRecommendations = async (
    nextCriteria: PlanCriteria,
    mode: "default" | "regenerate" | "tighten" | "broaden" = "default",
    offset: number = recommendationOffset
  ) => {
    const excludeIds = mode === "broaden" ? recommendations.map((r) => r.id) : [];
    const res = await fetch("/api/plan/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ criteria: nextCriteria, mode, offset, excludeIds }),
    });
    if (!res.ok) throw new Error("recommend endpoint failed");
    const data = (await res.json()) as RecommendResponse;
    setRecommendations(data.recommendations ?? []);
    setConfidence(data.confidence ?? 0);
    setSourceMode(data.sourceMode ?? "db");
    setRecDebug(
      `mode=${data.debug.mode} · base=${data.debug.baseCandidateCount} · filtered=${data.debug.filteredCandidateCount} · preWeb=${data.debug.preWebCount ?? "n/a"} · working=${data.debug.workingCandidateCount} · webAdded=${data.debug.webAdded} · excluded=${data.debug.excludeCount ?? 0} · llmRerank=${String(data.debug.llmRerankUsed)} · relaxed=${String(data.debug.constraintRelaxed ?? false)} · requested=${data.debug.requestedCount ?? 3} · googleLive=${data.debug.googleLiveEnrichedCount ?? 0} · hasMapsKey=${String(data.debug.hasGoogleMapsKey ?? false)}`
    );
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setIsSending(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);

    // Optimistic local parse so criteria UI updates immediately while AI call is in flight.
    const localParsed = parseMessageForCriteria(text);
    const optimisticCriteria: PlanCriteria = {
      ...criteria,
      ...localParsed,
      vibeTags: uniquePhrases([
        ...criteria.vibeTags,
        ...(localParsed.vibeTags ?? []),
      ]),
      minPrice: localParsed.minPrice ?? criteria.minPrice,
      maxPrice: localParsed.maxPrice ?? criteria.maxPrice,
    };
    if (
      optimisticCriteria.minPrice != null &&
      optimisticCriteria.maxPrice != null &&
      optimisticCriteria.minPrice > optimisticCriteria.maxPrice
    ) {
      const t = optimisticCriteria.minPrice;
      optimisticCriteria.minPrice = optimisticCriteria.maxPrice;
      optimisticCriteria.maxPrice = t;
    }
    setCriteria(optimisticCriteria);
    setVibeInput(optimisticCriteria.vibeTags.join(", "));

    try {
      const res = await fetch("/api/plan/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, criteria: optimisticCriteria }),
      });
      if (!res.ok) throw new Error("chat endpoint failed");

      const data = (await res.json()) as {
        assistantMessage?: string;
        criteriaPatch?: {
          dateStart?: string;
          dateEnd?: string;
          partySize?: number;
          minPrice?: number;
          maxPrice?: number;
          vibeTagsToAdd?: string[];
        };
        debug?: {
          model?: string;
          used_ai?: boolean;
          has_openai_key?: boolean;
        };
      };
      const patch = data.criteriaPatch ?? {};
      const nextCriteria: PlanCriteria = {
        ...optimisticCriteria,
        dateStart: patch.dateStart ?? optimisticCriteria.dateStart,
        dateEnd: patch.dateEnd ?? optimisticCriteria.dateEnd,
        partySize: patch.partySize ?? optimisticCriteria.partySize,
        minPrice: patch.minPrice ?? optimisticCriteria.minPrice,
        maxPrice: patch.maxPrice ?? optimisticCriteria.maxPrice,
        vibeTags: uniquePhrases([
          ...optimisticCriteria.vibeTags,
          ...(patch.vibeTagsToAdd ?? []),
        ]),
      };
      if (
        nextCriteria.minPrice != null &&
        nextCriteria.maxPrice != null &&
        nextCriteria.minPrice > nextCriteria.maxPrice
      ) {
        const t = nextCriteria.minPrice;
        nextCriteria.minPrice = nextCriteria.maxPrice;
        nextCriteria.maxPrice = t;
      }
      setCriteria(nextCriteria);
      setVibeInput(nextCriteria.vibeTags.join(", "));
      setLastChatSource("llm");
      const dbg = data.debug;
      setDebugInfo(
        `AI OK · model=${dbg?.model ?? "unknown"} · used_ai=${String(
          dbg?.used_ai ?? true
        )} · has_key=${String(dbg?.has_openai_key ?? true)}`
      );

      const nextPrompt = getNextPrompt(nextCriteria);
      const wantsRecommendations = isRecommendationRequest(text);
      const isBroadenRequest = wantsBroaden(text);
      const isTightenRequest = wantsTighten(text);
      const shouldRecommend = wantsRecommendations || isCriteriaComplete(nextCriteria);
      let nextOffset = recommendationOffset;
      if (wantsDifferentRecommendations(text)) {
        nextOffset = recommendationOffset + 3;
        setRecommendationOffset(nextOffset);
      }
      if (shouldRecommend) {
        try {
          await fetchRecommendations(
            nextCriteria,
            isTightenRequest
              ? "tighten"
              : isBroadenRequest
              ? "broaden"
              : wantsDifferentRecommendations(text)
                ? "regenerate"
                : "default",
            nextOffset
          );
        } catch {
          setRecDebug("Recommendation endpoint failed.");
        }
      }
      const botText = nextPrompt
        ? nextPrompt
        : shouldRecommend
          ? isTightenRequest
            ? "Perfect. Here are your top 2 highest-confidence picks below."
            : "Perfect. Here are your top 3 high-confidence picks below."
          : data.assistantMessage?.trim() ||
            "Got it. I updated your criteria and recommendations.";
      setMessages((m) => [...m, { role: "bot", text: botText }]);
    } catch {
      const nextCriteria: PlanCriteria = { ...optimisticCriteria };
      if (
        nextCriteria.minPrice != null &&
        nextCriteria.maxPrice != null &&
        nextCriteria.minPrice > nextCriteria.maxPrice
      ) {
        const t = nextCriteria.minPrice;
        nextCriteria.minPrice = nextCriteria.maxPrice;
        nextCriteria.maxPrice = t;
      }
      setCriteria(nextCriteria);
      setVibeInput(nextCriteria.vibeTags.join(", "));
      setLastChatSource("fallback");
      setDebugInfo("Fallback parser used (AI endpoint unavailable or errored).");
      const nextPrompt = getNextPrompt(nextCriteria);
      const wantsRecommendations = isRecommendationRequest(text);
      const isBroadenRequest = wantsBroaden(text);
      const isTightenRequest = wantsTighten(text);
      const shouldRecommend = wantsRecommendations || isCriteriaComplete(nextCriteria);
      let nextOffset = recommendationOffset;
      if (wantsDifferentRecommendations(text)) {
        nextOffset = recommendationOffset + 3;
        setRecommendationOffset(nextOffset);
      }
      if (shouldRecommend) {
        try {
          await fetchRecommendations(
            nextCriteria,
            isTightenRequest
              ? "tighten"
              : isBroadenRequest
              ? "broaden"
              : wantsDifferentRecommendations(text)
                ? "regenerate"
                : "default",
            nextOffset
          );
        } catch {
          setRecDebug("Recommendation endpoint failed.");
        }
      }
      setMessages((m) => [
        ...m,
        {
          role: "bot",
          text: nextPrompt
            ? nextPrompt
            : shouldRecommend
              ? isTightenRequest
                ? "Got it. I tightened this to your top 2 picks below."
                : "Got it. I refreshed your top 3 picks below."
              : "Got it. I updated your criteria and refreshed recommendations.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const hasAnyCriteria =
    criteria.dateStart ||
    criteria.dateEnd ||
    criteria.partySize != null ||
    criteria.vibeTags.length > 0 ||
    criteria.minPrice != null ||
    criteria.maxPrice != null;

  const runAction = async (mode: "regenerate" | "tighten" | "broaden") => {
    try {
      const offset = mode === "regenerate" ? recommendationOffset + 3 : recommendationOffset;
      if (mode === "regenerate") setRecommendationOffset(offset);
      await fetchRecommendations(criteria, mode, offset);
    } catch {
      setRecDebug("Recommendation endpoint failed.");
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-slate-500">
        Hi, {profile.display_name} · Defaults: party of {profile.party_size}, {profile.time_window_start.slice(0, 5)}-{profile.time_window_end.slice(0, 5)}, budget {"$".repeat(profile.price_min)}-{"$".repeat(profile.price_max)}
      </p>

      <section className="card">
        <h2 className="mb-4 text-lg font-medium text-slate-900">What do you want to do?</h2>
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <span
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
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
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="e.g. Date night Friday or Saturday in the next 3 weeks, preference for italian under $$$"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
          />
          <button type="button" onClick={() => void sendMessage()} className="btn-primary whitespace-nowrap" disabled={isSending}>
            {isSending ? "Thinking..." : "Send"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Chat mode:{" "}
          {lastChatSource === "llm"
            ? "AI"
            : lastChatSource === "fallback"
              ? "fallback parser"
              : "not sent yet"}
        </p>
        <p className="mt-1 text-xs text-slate-500">Debug: {debugInfo}</p>
      </section>

      <section className="card border-teal-200 bg-teal-50/30">
        <h2 className="mb-3 text-lg font-medium text-slate-900">Your plan criteria</h2>
        <p className="mb-4 text-sm text-slate-600">Edit anytime, or fill these instead of chatting.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Date from</label>
            <input
              type="date"
              value={criteria.dateStart}
              onChange={(e) => updateCriteria({ dateStart: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Date to</label>
            <input
              type="date"
              value={criteria.dateEnd}
              onChange={(e) => updateCriteria({ dateEnd: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Party size</label>
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
            <label className="mb-1 block text-sm font-medium text-slate-700">Vibes / cuisine / dietary tags</label>
            <input
              type="text"
              value={vibeInput}
              onChange={(e) => {
                setVibeInput(e.target.value);
                updateCriteria({
                  vibeTags: parseVibeInput(e.target.value),
                });
              }}
              placeholder="e.g. romantic, italian, vegetarian"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Min budget</label>
            <select
              value={criteria.minPrice ?? ""}
              onChange={(e) =>
                updateCriteria({
                  minPrice: e.target.value ? parseInt(e.target.value, 10) : null,
                })
              }
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            >
              <option value="">Any</option>
              <option value="1">$</option>
              <option value="2">$$</option>
              <option value="3">$$$</option>
              <option value="4">$$$$</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Max budget</label>
            <select
              value={criteria.maxPrice ?? ""}
              onChange={(e) =>
                updateCriteria({
                  maxPrice: e.target.value ? parseInt(e.target.value, 10) : null,
                })
              }
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            >
              <option value="">Any</option>
              <option value="1">$</option>
              <option value="2">$$</option>
              <option value="3">$$$</option>
              <option value="4">$$$$</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-slate-900">
            {hasAnyCriteria ? `Top ${Math.max(1, recommendations.length || 3)} high-confidence picks` : "Recommendations"}
          </h2>
          <div className="text-xs text-slate-500">
            Confidence: {Math.round(confidence * 100)}% · Source: {sourceMode === "hybrid" ? "DB + Live web" : "DB"}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => void runAction("regenerate")}>Regenerate Top 3</button>
          <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => void runAction("tighten")}>Tighten recommendation</button>
          <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => void runAction("broaden")}>Broaden search</button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Recommend debug: {recDebug}</p>

        {recommendations.length === 0 ? (
          <div className="mt-4 card border-dashed border-slate-300 bg-slate-50/50">
            <p className="text-slate-600">No recommendations yet. Ask the chat what you are in the mood for.</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {recommendations.map((r, idx) => (
              <li key={r.id} className="card">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-slate-900">{idx + 1}. {r.name}</div>
                  <div className="flex items-center gap-2">
                    {r.priceLevel != null && (
                      <div className="text-xs text-slate-500">{"$".repeat(r.priceLevel)}</div>
                    )}
                    {r.googleRating != null && (
                      <div
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                        title={r.ratingSource ? `Rating source: ${r.ratingSource}` : "Rating source: Google"}
                      >
                        ★ {r.googleRating.toFixed(1)} G
                      </div>
                    )}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.source}</span>
                  </div>
                </div>

                {r.neighborhood && (
                  <div className="text-sm text-slate-500">{r.neighborhood}</div>
                )}

                <p className="mt-2 text-sm text-slate-700"><span className="font-medium">Why this fits:</span> {r.reason}</p>
                <p className="mt-1 text-sm text-slate-500"><span className="font-medium">Tradeoff:</span> {r.tradeoff}</p>

                {r.bookingUrl ? (
                  <a
                    href={r.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary mt-3 inline-block"
                  >
                    Open booking link &rarr;
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
