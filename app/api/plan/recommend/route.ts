import { NextRequest } from "next/server";
import { fetchProfile, fetchRestaurantsForProfile, type Restaurant } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type PlanCriteria = {
  dateStart?: string;
  dateEnd?: string;
  partySize?: number | null;
  vibeTags?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
};

type Candidate = {
  id: string;
  name: string;
  neighborhood: string | null;
  priceLevel: number | null;
  bookingUrl: string | null;
  notes: string | null;
  source: "db" | "web";
  tagsText: string;
};

type Recommendation = {
  id: string;
  name: string;
  neighborhood: string | null;
  priceLevel: number | null;
  bookingUrl: string | null;
  source: "db" | "web";
  reason: string;
  tradeoff: string;
};

const HARD_DIETARY = new Set([
  "vegetarian",
  "vegan",
  "gluten free",
  "gluten-free",
  "dairy free",
  "halal",
  "kosher",
  "pescatarian",
]);

const CUISINE_HINTS = new Set([
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
  "ramen",
  "omakase",
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const n = normalize(item);
    if (!n || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

function candidateFromRestaurant(r: Restaurant): Candidate {
  return {
    id: r.id,
    name: r.name,
    neighborhood: r.neighborhood,
    priceLevel: r.price_level,
    bookingUrl: r.booking_url,
    notes: r.notes,
    source: "db",
    tagsText: unique(r.vibe_tags || []).join(" "),
  };
}

function matchesHardConstraints(c: Candidate, criteria: PlanCriteria): boolean {
  if (
    c.priceLevel != null &&
    ((criteria.minPrice != null && c.priceLevel < criteria.minPrice) ||
      (criteria.maxPrice != null && c.priceLevel > criteria.maxPrice))
  ) {
    return false;
  }

  const tags = unique(criteria.vibeTags ?? []);
  const hardDietary = tags.filter((t) => HARD_DIETARY.has(t));
  if (hardDietary.length === 0) return true;

  const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
  return hardDietary.every((t) => hay.includes(t));
}

function scoreCandidate(c: Candidate, criteria: PlanCriteria, profileNeighborhoods: string[], profileMin: number, profileMax: number) {
  let score = 0;
  const reasons: string[] = [];

  const tags = unique(criteria.vibeTags ?? []);
  const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
  const matched = tags.filter((t) => hay.includes(t));
  if (matched.length > 0) {
    score += matched.length * 9;
    reasons.push(`matches: ${matched.slice(0, 3).join(", ")}`);
  }

  const nhood = normalize(c.neighborhood ?? "");
  if (nhood && profileNeighborhoods.some((n) => nhood.includes(n) || n.includes(nhood))) {
    score += 3;
    reasons.push("in your preferred area");
  }

  const min = criteria.minPrice ?? profileMin;
  const max = criteria.maxPrice ?? profileMax;
  if (c.priceLevel != null) {
    if (c.priceLevel >= min && c.priceLevel <= max) {
      score += 4;
      reasons.push("within budget");
    } else {
      score -= 4;
    }
  }

  if (c.bookingUrl) {
    score += 1;
    reasons.push("bookable link available");
  }

  return { score, reasons };
}

function confidenceScore(candidates: Candidate[], criteria: PlanCriteria): number {
  if (candidates.length === 0) return 0;
  const tags = unique(criteria.vibeTags ?? []);
  const hardTags = tags.filter((t) => HARD_DIETARY.has(t) || CUISINE_HINTS.has(t));
  if (hardTags.length === 0) return candidates.length >= 3 ? 0.75 : 0.45;

  const matchedCount = candidates.filter((c) => {
    const hay = normalize(`${c.name} ${c.notes ?? ""} ${c.tagsText}`);
    return hardTags.some((t) => hay.includes(t));
  }).length;
  const coverage = Math.min(1, matchedCount / Math.max(3, hardTags.length));
  const depth = Math.min(1, candidates.length / 8);
  return Number((0.65 * coverage + 0.35 * depth).toFixed(2));
}

async function webAugment(criteria: PlanCriteria): Promise<Candidate[]> {
  const tags = unique(criteria.vibeTags ?? []);
  const queryCore = tags.length > 0 ? tags.join(" ") : "best restaurants";
  const query = `${queryCore} denver`;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RezSimple/1.0" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>/gi)];
    const picks: Candidate[] = [];
    for (let i = 0; i < Math.min(matches.length, 8); i++) {
      const href = matches[i][1] ?? "";
      const title = (matches[i][2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!title) continue;
      picks.push({
        id: `web:${i}:${normalize(title).replace(/\s+/g, "-")}`,
        name: title,
        neighborhood: null,
        priceLevel: null,
        bookingUrl: href,
        notes: "Live web candidate (DuckDuckGo augmentation)",
        source: "web",
        tagsText: queryCore,
      });
    }
    return picks;
  } catch {
    return [];
  }
}

function dedupeCandidates(list: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const key = normalize(c.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    const parsed = JSON.parse(fence[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new Error("Invalid JSON object from model");
}

async function rerankWithLlm(criteria: PlanCriteria, candidates: Candidate[]): Promise<{ picks: Recommendation[]; llmUsed: boolean }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || candidates.length === 0) return { picks: [], llmUsed: false };

  const payload = candidates.slice(0, 12).map((c) => ({
    id: c.id,
    name: c.name,
    neighborhood: c.neighborhood,
    priceLevel: c.priceLevel,
    bookingUrl: c.bookingUrl,
    source: c.source,
    notes: c.notes,
    tagsText: c.tagsText,
  }));

  const prompt = `You are selecting top 3 restaurant recommendations for a Denver planning app.

Constraints:
- Respect hard user constraints (cuisine/dietary/budget) whenever possible.
- Do not pick obviously irrelevant cuisines when explicit cuisine requested (e.g., sushi request should prioritize sushi/Japanese).
- Return 3 picks max.
- Keep reasons specific and short.

Criteria:
${JSON.stringify(criteria)}

Candidates:
${JSON.stringify(payload)}

Return ONLY JSON:
{
  "picks": [
    {"id":"...", "reason":"...", "tradeoff":"..."},
    {"id":"...", "reason":"...", "tradeoff":"..."},
    {"id":"...", "reason":"...", "tradeoff":"..."}
  ],
  "confidence": 0.0
}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!res.ok) return { picks: [], llmUsed: false };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { picks: [], llmUsed: false };
    const parsed = parseJsonObject(content);
    const picksRaw = Array.isArray(parsed.picks) ? parsed.picks : [];
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picks: Recommendation[] = [];
    for (const row of picksRaw) {
      if (!row || typeof row !== "object") continue;
      const id = typeof (row as Record<string, unknown>).id === "string" ? String((row as Record<string, unknown>).id) : "";
      if (!id || !byId.has(id)) continue;
      const c = byId.get(id)!;
      const reason = typeof (row as Record<string, unknown>).reason === "string" ? String((row as Record<string, unknown>).reason) : "Strong fit for your criteria.";
      const tradeoff = typeof (row as Record<string, unknown>).tradeoff === "string" ? String((row as Record<string, unknown>).tradeoff) : "May require flexibility on timing.";
      picks.push({
        id: c.id,
        name: c.name,
        neighborhood: c.neighborhood,
        priceLevel: c.priceLevel,
        bookingUrl: c.bookingUrl,
        source: c.source,
        reason,
        tradeoff,
      });
      if (picks.length >= 3) break;
    }
    return { picks, llmUsed: picks.length > 0 };
  } catch {
    return { picks: [], llmUsed: false };
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    criteria?: PlanCriteria;
    mode?: "default" | "regenerate" | "tighten" | "broaden";
    offset?: number;
  };
  const criteria = body.criteria ?? {};
  const mode = body.mode ?? "default";
  const offset = typeof body.offset === "number" ? body.offset : 0;

  let profile;
  let restaurants;
  try {
    profile = await fetchProfile();
    restaurants = await fetchRestaurantsForProfile();
  } catch (e) {
    const message = e instanceof Error ? e.message : "Configuration error";
    return Response.json({ error: message }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404 });
  }

  const dbCandidates = restaurants.map(candidateFromRestaurant);
  const filtered = dbCandidates.filter((c) => matchesHardConstraints(c, criteria));
  const candidatesForScore = mode === "broaden" && filtered.length < 8 ? dbCandidates : filtered;

  const scored = candidatesForScore
    .map((c) => ({
      candidate: c,
      ...scoreCandidate(
        c,
        criteria,
        (profile.neighborhoods || []).map(normalize),
        profile.price_min,
        profile.price_max
      ),
    }))
    .sort((a, b) => b.score - a.score);

  let workingCandidates = scored.map((s) => s.candidate);
  const baseConfidence = confidenceScore(workingCandidates, criteria);

  let sourceMode: "db" | "hybrid" = "db";
  let webAdded = 0;
  const needWebAugmentation =
    mode === "broaden" ||
    workingCandidates.length < 6 ||
    baseConfidence < 0.65;
  if (needWebAugmentation) {
    const webCandidates = await webAugment(criteria);
    webAdded = webCandidates.length;
    if (webCandidates.length > 0) {
      workingCandidates = dedupeCandidates([...workingCandidates, ...webCandidates]);
      sourceMode = "hybrid";
    }
  }

  const rerank = await rerankWithLlm(criteria, workingCandidates);
  let recommendations: Recommendation[] = rerank.picks;
  if (recommendations.length === 0) {
    const ranked = workingCandidates
      .map((c) => ({
        c,
        ...scoreCandidate(
          c,
          criteria,
          (profile.neighborhoods || []).map(normalize),
          profile.price_min,
          profile.price_max
        ),
      }))
      .sort((a, b) => b.score - a.score);
    const start = workingCandidates.length > 0 ? offset % Math.max(1, ranked.length) : 0;
    const rotated = ranked.slice(start).concat(ranked.slice(0, start));
    recommendations = rotated.slice(0, 3).map((r) => ({
      id: r.c.id,
      name: r.c.name,
      neighborhood: r.c.neighborhood,
      priceLevel: r.c.priceLevel,
      bookingUrl: r.c.bookingUrl,
      source: r.c.source,
      reason: r.reasons[0] ?? "Strong fit for your preferences.",
      tradeoff: "Consider flexibility on time window for best availability.",
    }));
  }

  const finalConfidence = confidenceScore(
    recommendations.map((r) => ({
      id: r.id,
      name: r.name,
      neighborhood: r.neighborhood,
      priceLevel: r.priceLevel,
      bookingUrl: r.bookingUrl,
      notes: null,
      source: r.source,
      tagsText: "",
    })),
    criteria
  );

  return Response.json({
    recommendations,
    confidence: finalConfidence,
    sourceMode,
    debug: {
      mode,
      baseCandidateCount: dbCandidates.length,
      filteredCandidateCount: filtered.length,
      workingCandidateCount: workingCandidates.length,
      webAdded,
      llmRerankUsed: rerank.llmUsed,
      offset,
    },
  });
}
