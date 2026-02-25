import "server-only";

/**
 * Call OpenAI to pick the 5 best articles for Denver food scene curation.
 * No new deps; uses fetch. Set OPENAI_API_KEY to enable.
 */

const RECENT_CAP = 50;
const PICK = 5;

export type ArticleForCuration = {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  source_id: string;
};

/**
 * Returns 5 article IDs in recommendation order (best first), or [] if no key or error.
 * Uses IDs so we never miss due to URL mismatch; prompt favors editorial sources.
 */
export async function pickCuratedArticleIds(
  articles: ArticleForCuration[],
  sourceNames: Map<string, string>
): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || articles.length === 0) return [];

  const list = articles.slice(0, RECENT_CAP).map((a) => ({
    id: a.id,
    title: a.title,
    summary: (a.summary ?? "").slice(0, 300),
    source: sourceNames.get(a.source_id) ?? a.source_id,
  }));

  const prompt = `You are curating a weekly Denver food newsletter. From the following articles, pick the 5 best for someone who wants to stay on top of the Denver restaurant and food scene.

Rules:
- Prefer editorial sources (5280 Magazine, Eater Denver, Westword, 303 Magazine) over Reddit when quality is similar.
- Favor: restaurant reviews, openings/closings, chef stories, neighborhood guides, and "where to eat" lists.
- Skip: generic questions, low-signal threads, or off-topic posts.

Articles (id, title, summary, source):
${list.map((a) => `- id: ${a.id} | "${a.title}" | ${a.summary} | ${a.source}`).join("\n")}

Return a JSON array of exactly 5 article IDs in order of recommendation (best first). No other text, only the array. Example: ["uuid-1", "uuid-2", ...]`;

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
        temperature: 0.3,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return [];
    const ids = JSON.parse(content) as string[];
    if (!Array.isArray(ids)) return [];
    const validIds = new Set(articles.map((a) => a.id));
    return ids.slice(0, PICK).filter((id) => typeof id === "string" && validIds.has(id));
  } catch {
    return [];
  }
}
