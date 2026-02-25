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

const CUISINE_SYNONYMS: Record<string, string[]> = {
  sushi: ["sushi", "nigiri", "sashimi", "omakase", "izakaya", "temaki"],
  japanese: ["japanese", "sushi", "ramen", "izakaya", "omakase", "yakitori"],
  italian: ["italian", "pasta", "trattoria", "osteria", "pizza"],
  mexican: ["mexican", "taco", "taqueria"],
  chinese: ["chinese", "dim sum", "szechuan", "sichuan"],
  thai: ["thai"],
  vietnamese: ["vietnamese", "pho"],
  korean: ["korean", "bbq", "bulgogi"],
  french: ["french", "bistro", "brasserie"],
  spanish: ["spanish", "tapas"],
  mediterranean: ["mediterranean", "middle eastern", "levantine"],
  seafood: ["seafood", "oyster", "raw bar"],
  steakhouse: ["steakhouse", "steak"],
  pizza: ["pizza", "pizzeria"],
  ramen: ["ramen"],
  omakase: ["omakase", "sushi"],
};

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

function cuisineIntentFromTags(tags: string[]): string[] {
  const normalized = unique(tags);
  const intent: string[] = [];
  for (const [cuisine, synonyms] of Object.entries(CUISINE_SYNONYMS)) {
    const hasMatch = normalized.some((t) => t === cuisine || synonyms.some((s) => t.includes(s) || s.includes(t)));
    if (hasMatch) intent.push(cuisine);
  }
  return intent;
}

function textMatchesCuisine(hay: string, cuisineIntent: string[]): boolean {
  if (cuisineIntent.length === 0) return true;
  return cuisineIntent.some((cuisine) => {
    const keywords = CUISINE_SYNONYMS[cuisine] ?? [cuisine];
    return keywords.some((k) => hay.includes(normalize(k)));
  });
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
  const cuisineIntent = cuisineIntentFromTags(tags);
  const hardDietary = tags.filter((t) => HARD_DIETARY.has(t));

  const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
  if (!textMatchesCuisine(hay, cuisineIntent)) return false;
  if (hardDietary.length === 0) return true;
  return hardDietary.every((t) => hay.includes(t));
}

function scoreCandidate(c: Candidate, criteria: PlanCriteria, profileNeighborhoods: string[], profileMin: number, profileMax: number) {
  let score = 0;
  const reasons: string[] = [];

  const tags = unique(criteria.vibeTags ?? []);
  const cuisineIntent = cuisineIntentFromTags(tags);
  const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
  const matchedCuisine = cuisineIntent.filter((cuisine) =>
    (CUISINE_SYNONYMS[cuisine] ?? [cuisine]).some((k) => hay.includes(normalize(k)))
  );
  if (matchedCuisine.length > 0) {
    score += 26;
    reasons.push(`matches cuisine: ${matchedCuisine.slice(0, 2).join(", ")}`);
  } else if (cuisineIntent.length > 0) {
    score -= 40;
  }

  const softTags = tags.filter((t) => !HARD_DIETARY.has(t) && !cuisineIntent.includes(t));
  const matchedSoft = softTags.filter((t) => hay.includes(t));
  if (matchedSoft.length > 0) {
    score += matchedSoft.length * 6;
    reasons.push(`matches vibe: ${matchedSoft.slice(0, 2).join(", ")}`);
  }

  const nhood = normalize(c.neighborhood ?? "");
  if (nhood && profileNeighborhoods.some((n) => nhood.includes(n) || n.includes(nhood))) {
    score += 3;
    reasons.push("in your preferred area");
  }

  const min = criteria.minPrice ?? profileMin ?? 1;
  const max = criteria.maxPrice ?? profileMax ?? 4;
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
  const cuisineIntent = cuisineIntentFromTags(tags);
  const hardTags = tags.filter((t) => HARD_DIETARY.has(t) || CUISINE_HINTS.has(t) || cuisineIntent.includes(t));
  if (hardTags.length === 0) return candidates.length >= 3 ? 0.75 : 0.45;

  const matchedCount = candidates.filter((c) => {
    const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
    const cuisineOk = textMatchesCuisine(hay, cuisineIntent);
    const dietaryOk = tags.filter((t) => HARD_DIETARY.has(t)).every((t) => hay.includes(t));
    return cuisineOk && dietaryOk;
  }).length;
  const coverage = Math.min(1, matchedCount / Math.max(3, hardTags.length));
  const depth = Math.min(1, candidates.length / 8);
  return Number((0.65 * coverage + 0.35 * depth).toFixed(2));
}

function decodeDuckDuckGoHref(href: string): string {
  if (!href) return "";
  try {
    if (href.startsWith("http")) return href;
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return href;
  }
}

function cleanWebTitle(title: string): string {
  return title
    .replace(/\s*[-|]\s*(Denver|Colorado|CO).*$/i, "")
    .replace(/\s*[-|]\s*(OpenTable|Yelp|Tripadvisor|Infatuation|Westword).*$/i, "")
    .trim();
}

function looksLikeRestaurantName(title: string): boolean {
  const t = normalize(title);
  if (!t) return false;
  const banned = [
    "best sushi",
    "top",
    "guide",
    "updated",
    "restaurants in denver",
    "tripadvisor",
    "yelp",
    "infatuation",
    "westword",
    "visit denver",
  ];
  return !banned.some((b) => t.includes(b));
}

function seededWebCuisineCandidates(criteria: PlanCriteria): Candidate[] {
  const cuisineIntent = cuisineIntentFromTags(criteria.vibeTags ?? []);
  const out: Candidate[] = [];
  if (cuisineIntent.includes("sushi") || cuisineIntent.includes("japanese") || cuisineIntent.includes("omakase")) {
    const seeds = [
      "Sushi Den",
      "Temaki Den",
      "Matsuhisa Denver",
      "Blue Sushi Sake Grill",
    ];
    for (let i = 0; i < seeds.length; i++) {
      const name = seeds[i];
      out.push({
        id: `web:seed:sushi:${i}:${normalize(name).replace(/\s+/g, "-")}`,
        name,
        neighborhood: null,
        priceLevel: null,
        bookingUrl: `https://duckduckgo.com/?q=${encodeURIComponent(`${name} denver reservations`)}`,
        notes: "Cuisine-seeded live web candidate",
        source: "web",
        tagsText: "sushi japanese",
      });
    }
  }
  return out;
}

async function webAugment(criteria: PlanCriteria): Promise<Candidate[]> {
  const tags = unique(criteria.vibeTags ?? []);
  const cuisineIntent = cuisineIntentFromTags(tags);
  const queryCore = cuisineIntent.length > 0 ? cuisineIntent.join(" ") : tags.length > 0 ? tags.join(" ") : "restaurants";
  const query = `${queryCore} denver reservations`;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "RezSimple/1.0" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]*(?:class=\"result__a\"|class=\"result-link\")[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>/gi)];
    const picks: Candidate[] = [...seededWebCuisineCandidates(criteria)];
    for (let i = 0; i < Math.min(matches.length, 16); i++) {
      const hrefRaw = matches[i][1] ?? "";
      const href = decodeDuckDuckGoHref(hrefRaw);
      const rawTitle = (matches[i][2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const title = cleanWebTitle(rawTitle);
      if (!title) continue;
      if (!looksLikeRestaurantName(title)) continue;
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
    return dedupeCandidates(picks).slice(0, 12);
  } catch {
    return seededWebCuisineCandidates(criteria);
  }
}

function relaxCuisineTags(tags: string[]): string[] {
  const normalized = unique(tags);
  const cuisineIntent = cuisineIntentFromTags(normalized);
  if (cuisineIntent.length <= 1) return normalized;
  // If multiple cuisines were inferred, keep the first explicit one to avoid over-constraining.
  const primary = cuisineIntent[0];
  return normalized.filter((t) => {
    if (HARD_DIETARY.has(t)) return true;
    const tagCuisine = cuisineIntentFromTags([t]);
    if (tagCuisine.length === 0) return true;
    return tagCuisine.includes(primary);
  });
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

  const payload = candidates.slice(0, 18).map((c) => ({
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
- If cuisine is explicit, every returned pick must match that cuisine intent.
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
    const cuisineIntent = cuisineIntentFromTags(criteria.vibeTags ?? []);
    const dietaryTags = unique(criteria.vibeTags ?? []).filter((t) => HARD_DIETARY.has(t));
    for (const row of picksRaw) {
      if (!row || typeof row !== "object") continue;
      const id = typeof (row as Record<string, unknown>).id === "string" ? String((row as Record<string, unknown>).id) : "";
      if (!id || !byId.has(id)) continue;
      const c = byId.get(id)!;
      const hay = normalize(`${c.name} ${c.neighborhood ?? ""} ${c.notes ?? ""} ${c.tagsText}`);
      if (!textMatchesCuisine(hay, cuisineIntent)) continue;
      if (!dietaryTags.every((t) => hay.includes(t))) continue;
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
  const normalizedCriteria: PlanCriteria = {
    ...criteria,
    minPrice: criteria.minPrice ?? 1,
    maxPrice: criteria.maxPrice ?? 4,
    vibeTags: unique(criteria.vibeTags ?? []),
  };
  if (
    normalizedCriteria.minPrice != null &&
    normalizedCriteria.maxPrice != null &&
    normalizedCriteria.minPrice > normalizedCriteria.maxPrice
  ) {
    const t = normalizedCriteria.minPrice;
    normalizedCriteria.minPrice = normalizedCriteria.maxPrice;
    normalizedCriteria.maxPrice = t;
  }
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
  let filtered = dbCandidates.filter((c) => matchesHardConstraints(c, normalizedCriteria));
  let constraintRelaxed = false;
  if (filtered.length === 0 && (normalizedCriteria.vibeTags?.length ?? 0) > 0) {
    // Keep dietary hard filters, but relax accidental multi-cuisine collisions.
    const relaxedTags = relaxCuisineTags(normalizedCriteria.vibeTags ?? []);
    const relaxedCriteria: PlanCriteria = { ...normalizedCriteria, vibeTags: relaxedTags };
    filtered = dbCandidates.filter((c) => matchesHardConstraints(c, relaxedCriteria));
    if (filtered.length > 0) {
      normalizedCriteria.vibeTags = relaxedTags;
      constraintRelaxed = true;
    }
  }
  const candidatesForScore = filtered;

  const scored = candidatesForScore
    .map((c) => ({
      candidate: c,
      ...scoreCandidate(
        c,
        normalizedCriteria,
        (profile.neighborhoods || []).map(normalize),
        profile.price_min,
        profile.price_max
      ),
    }))
    .sort((a, b) => b.score - a.score);

  let workingCandidates = scored.map((s) => s.candidate);
  const baseConfidence = confidenceScore(workingCandidates, normalizedCriteria);

  let sourceMode: "db" | "hybrid" = "db";
  let webAdded = 0;
  const needWebAugmentation =
    mode === "broaden" ||
    workingCandidates.length < 6 ||
    baseConfidence < 0.65;
  if (needWebAugmentation) {
    const webCandidates = await webAugment(normalizedCriteria);
    webAdded = webCandidates.length;
    if (webCandidates.length > 0) {
      workingCandidates = dedupeCandidates([...workingCandidates, ...webCandidates]);
      sourceMode = "hybrid";
    }
  }

  const rerank = await rerankWithLlm(normalizedCriteria, workingCandidates);
  let recommendations: Recommendation[] = rerank.picks;
  if (recommendations.length === 0) {
    const ranked = workingCandidates
      .map((c) => ({
        c,
        ...scoreCandidate(
          c,
          normalizedCriteria,
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
    normalizedCriteria
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
      constraintRelaxed,
    },
  });
}
