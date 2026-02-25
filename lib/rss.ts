/**
 * Minimal RSS/Atom parser (no deps). Extracts items with title, link, description, pubDate, image.
 */

export type RssItem = {
  title: string;
  link: string;
  description: string | null;
  pubDate: string | null;
  imageUrl: string | null;
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function extractTag(xml: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(close, start);
  if (end === -1) return null;
  let raw = xml.slice(start + open.length, end).trim();
  if (raw.startsWith("<![CDATA[")) {
    raw = raw.slice(9, raw.endsWith("]]>") ? raw.length - 3 : raw.length);
  }
  return stripHtml(raw) || null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Parse RSS 2.0 or Atom and return items (title, link, description, pubDate, image). */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const lower = xml.toLowerCase();

  if (lower.includes("<item>") || lower.includes("</item>")) {
    const itemBlocks = xml.split(/<\/item\s*>/i).filter((b) => b.includes("<item"));
    for (const block of itemBlocks) {
      const item = block.replace(/.*<item\s*>/i, "");
      const title = extractTag(item, "title") ?? "";
      const link = extractTag(item, "link") ?? extractAttr(item, "link", "href") ?? "";
      if (!title || !link) continue;
      let description = extractTag(item, "description");
      if (description && description.length > 500) description = description.slice(0, 497) + "...";
      const pubDate = extractTag(item, "pubDate");
      let imageUrl = extractAttr(item, "enclosure", "url");
      if (!imageUrl) imageUrl = extractAttr(item, "media:content", "url");
      if (!imageUrl) imageUrl = extractAttr(item, "media:thumbnail", "url");
      items.push({
        title,
        link,
        description: description || null,
        pubDate: pubDate || null,
        imageUrl: imageUrl || null,
      });
    }
  } else if (lower.includes("<entry>") || lower.includes("</entry>")) {
    const entryBlocks = xml.split(/<\/entry\s*>/i).filter((b) => b.includes("<entry"));
    for (const block of entryBlocks) {
      const entry = block.replace(/.*<entry\s*>/i, "");
      const title = extractTag(entry, "title") ?? "";
      const link = extractAttr(entry, "link", "href") ?? extractTag(entry, "link") ?? "";
      if (!title || !link) continue;
      let description = extractTag(entry, "summary") ?? extractTag(entry, "content");
      if (description && description.length > 500) description = description.slice(0, 497) + "...";
      const updated = extractTag(entry, "updated");
      const pubDate = updated || extractTag(entry, "published");
      let imageUrl = extractAttr(entry, "media:content", "url");
      if (!imageUrl) imageUrl = extractAttr(entry, "media:thumbnail", "url");
      items.push({
        title,
        link,
        description: description || null,
        pubDate: pubDate || null,
        imageUrl: imageUrl || null,
      });
    }
  }

  return items;
}

/** Parse ISO 8601 or RFC 2822 date to ISO string for DB, or null. */
export function normalizePubDate(pubDate: string | null): string | null {
  if (!pubDate || !pubDate.trim()) return null;
  const d = new Date(pubDate);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
