import "server-only";

/**
 * Call OpenAI to pick the 5 best articles for Denver food scene curation.
 * No new deps; uses fetch. Set OPENAI_API_KEY to enable.
 */

const RECENT_CAP = 50;
const PICK = 5;

export type ArticleForCuration = {
  title: string;
  url: string;
  summary: string | null;
  source_id: string;
};

/**
 * Returns 5 article URLs in recommendation order (best first), or [] if no key or error.
 */
export async function pickCuratedArticleUrls(
  articles: ArticleForCuration[],
  sourceNames: Map<string, string>
): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || articles.length === 0) return [];

  const list = articles.slice(0, RECENT_CAP).map((a) => ({
    title: a.title,
    url: a.url,
    summary: (a.summary ?? "").slice(0, 300),
    source: sourceNames.get(a.source_id) ?? a.source_id,
  }));

  const prompt = `You are curating a weekly Denver food newsletter. From the following articles, pick the 5 best for someone who wants to stay on top of the Denver restaurant and food scene. Consider: relevance to Denver dining, quality of source, and reader interest (reviews, openings, guides, chef stories).

Articles (title, url, summary, source):
${list.map((a) => `- "${a.title}" | ${a.url} | ${a.summary} | ${a.source}`).join("\n")}

Return a JSON array of exactly 5 article URLs in order of recommendation (best first). No other text, only the array. Example: ["https://...", "https://...", ...]`;

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
    const urls = JSON.parse(content) as string[];
    if (!Array.isArray(urls)) return [];
    return urls.slice(0, PICK).filter((u) => typeof u === "string" && u.startsWith("http"));
  } catch {
    return [];
  }
}
