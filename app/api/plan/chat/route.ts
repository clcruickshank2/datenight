import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type ChatCriteria = {
  dateStart?: string;
  dateEnd?: string;
  partySize?: number | null;
  vibeTags?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
};

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonObjectFromModel(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const parsed = JSON.parse(fenceMatch[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsed = JSON.parse(sliced);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  throw new Error("Model did not return valid JSON object");
}

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return Response.json({ error: "OPENAI_API_KEY missing" }, { status: 500 });
  }

  const body = (await req.json()) as {
    message?: string;
    criteria?: ChatCriteria;
  };
  const message = body.message?.trim();
  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  const criteria = body.criteria ?? {};
  const prompt = `You are RezSimple's planning assistant for Denver restaurants.

Task:
1) Parse the user's latest message into structured criteria updates.
2) Return a concise assistant chat reply that feels intelligent and contextual.
3) If key fields are missing, ask exactly one follow-up question.

Current criteria:
${JSON.stringify(criteria)}

Rules:
- Budget parsing:
  - "$" => minPrice=1, maxPrice=1
  - "$$" => minPrice=2, maxPrice=2
  - "$$$" => minPrice=3, maxPrice=3
  - "$$$$" => minPrice=4, maxPrice=4
  - "under $$" => maxPrice=2
  - "up to $$$" => maxPrice=3
  - "between $$ and $$$" => minPrice=2, maxPrice=3
- Parse dynamic tags, including dietary/cuisine/vibe terms like vegetarian, vegan, gluten-free, italian, cozy, romantic, etc.
- Only add vibeTagsToAdd when explicitly mentioned by the user in this latest message.
- Do not add generic defaults like "cozy" or "date night" unless user explicitly says them.
- Keep dates as YYYY-MM-DD when you can infer a range (e.g. next 3 weeks).
- Never remove existing tags; only add new tags in vibeTagsToAdd.
- Keep assistantMessage short (1-2 sentences).

Return ONLY JSON with this exact shape:
{
  "assistantMessage": "string",
  "criteriaPatch": {
    "dateStart": "YYYY-MM-DD or null",
    "dateEnd": "YYYY-MM-DD or null",
    "partySize": 2,
    "minPrice": 1,
    "maxPrice": 3,
    "vibeTagsToAdd": ["vegetarian", "italian"]
  }
}

User message:
${message}`;

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

    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: `OpenAI ${res.status}: ${text}` }, { status: 500 });
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return Response.json({ error: "OpenAI response missing content" }, { status: 500 });
    }

    const parsed = parseJsonObjectFromModel(content);
    const assistantMessage =
      typeof parsed.assistantMessage === "string" && parsed.assistantMessage.trim().length > 0
        ? parsed.assistantMessage.trim()
        : "Got it. I updated your criteria and refreshed recommendations.";

    const rawPatch =
      parsed.criteriaPatch && typeof parsed.criteriaPatch === "object"
        ? (parsed.criteriaPatch as Record<string, unknown>)
        : {};

    const vibeTagsToAdd = Array.isArray(rawPatch.vibeTagsToAdd)
      ? rawPatch.vibeTagsToAdd
          .map((t) => (typeof t === "string" ? normalizeTag(t) : ""))
          .filter((t) => t.length > 0)
      : [];

    const criteriaPatch: ChatCriteria & { vibeTagsToAdd: string[] } = {
      dateStart:
        typeof rawPatch.dateStart === "string" && rawPatch.dateStart.trim().length > 0
          ? rawPatch.dateStart.trim()
          : undefined,
      dateEnd:
        typeof rawPatch.dateEnd === "string" && rawPatch.dateEnd.trim().length > 0
          ? rawPatch.dateEnd.trim()
          : undefined,
      partySize:
        typeof rawPatch.partySize === "number" && rawPatch.partySize >= 1 && rawPatch.partySize <= 20
          ? rawPatch.partySize
          : undefined,
      minPrice:
        typeof rawPatch.minPrice === "number" && rawPatch.minPrice >= 1 && rawPatch.minPrice <= 4
          ? rawPatch.minPrice
          : undefined,
      maxPrice:
        typeof rawPatch.maxPrice === "number" && rawPatch.maxPrice >= 1 && rawPatch.maxPrice <= 4
          ? rawPatch.maxPrice
          : undefined,
      vibeTagsToAdd,
    };

    if (
      criteriaPatch.minPrice != null &&
      criteriaPatch.maxPrice != null &&
      criteriaPatch.minPrice > criteriaPatch.maxPrice
    ) {
      const swappedMin = criteriaPatch.maxPrice;
      criteriaPatch.maxPrice = criteriaPatch.minPrice;
      criteriaPatch.minPrice = swappedMin;
    }

    return Response.json({
      assistantMessage,
      criteriaPatch,
      debug: {
        model: "gpt-4o-mini",
        used_ai: true,
        has_openai_key: true,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown chat error";
    return Response.json(
      {
        error: message,
        debug: {
          model: "gpt-4o-mini",
          used_ai: false,
          has_openai_key: Boolean(process.env.OPENAI_API_KEY),
        },
      },
      { status: 500 }
    );
  }
}
