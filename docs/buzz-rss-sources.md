# Buzz RSS sources

Sources with a **feed_url** in `buzz_sources` are used by the weekly cron. Others are disabled until we have a feed or another ingestion method.

| Source | Feed URL | Notes |
|--------|----------|--------|
| **5280 Magazine** | `https://www.5280.com/category/eat-and-drink/feed/` | Eat & Drink category |
| **Westword** | `https://www.westword.com/index.rss` | Site-wide; may include non-food |
| **Eater Denver** | `https://denver.eater.com/rss/index.xml` | Denver food news |
| **303 Magazine** | `https://303magazine.com/feed/` | Site-wide |
| **r/denverfood** | `https://www.reddit.com/r/denverfood/.rss` | Subreddit |
| **New Denizen** | `https://newdenizen.substack.com/feed` | Substack (confirm subdomain if different) |

**No RSS yet (enabled = false in seed):**

- In Good Taste Denver (ingoodtastedenver.com) — try `/feed` if WordPress
- The Denver Ear (thedenverear.com)
- Denver Dweller (denverdweller.com)
- Bites with Bre (biteswithbre.com) — Instagram-heavy

After running the schema, you can flip `enabled` or set `feed_url` in Supabase for any source.
