-- RezSimple Buzz: articles, sources, preferences, trending restaurants
-- Requires: set_updated_at() trigger function. Run buzz_sources first (others reference it).

-- 1. Sources (must exist before buzz_articles and buzz_preferences)
create table public.buzz_sources (
  id text not null,
  name text not null,
  base_url text not null,
  feed_url text null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint buzz_sources_pkey primary key (id)
) TABLESPACE pg_default;

create trigger buzz_sources_set_updated_at BEFORE
update on buzz_sources for EACH row
execute FUNCTION set_updated_at ();

-- 2. Articles
create table public.buzz_articles (
  id uuid not null default gen_random_uuid (),
  source_id text not null,
  external_id text null,
  title text not null,
  url text not null,
  summary text null,
  image_url text null,
  published_at timestamp with time zone null,
  fetched_at timestamp with time zone not null default now(),
  raw_content text null,
  constraint buzz_articles_pkey primary key (id),
  constraint buzz_articles_url_unique unique (source_id, url),
  constraint buzz_articles_source_id_fkey foreign KEY (source_id) references buzz_sources (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists buzz_articles_source_fetched_idx on public.buzz_articles using btree (source_id, fetched_at desc) TABLESPACE pg_default;
create index IF not exists buzz_articles_published_idx on public.buzz_articles using btree (published_at desc nulls last) TABLESPACE pg_default;

-- 3. Per-profile source preferences
create table public.buzz_preferences (
  profile_id uuid not null,
  source_id text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  constraint buzz_preferences_pkey primary key (profile_id, source_id),
  constraint buzz_preferences_profile_id_fkey foreign KEY (profile_id) references profiles (id) on delete CASCADE,
  constraint buzz_preferences_source_id_fkey foreign KEY (source_id) references buzz_sources (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists buzz_preferences_profile_idx on public.buzz_preferences using btree (profile_id) TABLESPACE pg_default;

-- 4. Trending restaurants (LLM extraction + Google Places later)
create table public.buzz_restaurants (
  id uuid not null default gen_random_uuid (),
  name text not null,
  website_url text null,
  image_url text null,
  overview text null,
  neighborhood text null,
  price_level integer null,
  cuisine_vibes text[] not null default '{}'::text[],
  google_place_id text null,
  google_rating numeric null,
  rating_source text null,
  source_article_ids uuid[] not null default '{}'::uuid[],
  fetched_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint buzz_restaurants_pkey primary key (id),
  constraint buzz_restaurants_price_level_check check (
    (
      price_level is null
      or ((price_level >= 1) and (price_level <= 4))
    )
  )
) TABLESPACE pg_default;

create index IF not exists buzz_restaurants_name_idx on public.buzz_restaurants using btree (name) TABLESPACE pg_default;
create index IF not exists buzz_restaurants_fetched_idx on public.buzz_restaurants using btree (fetched_at desc) TABLESPACE pg_default;

create trigger buzz_restaurants_set_updated_at BEFORE
update on buzz_restaurants for EACH row
execute FUNCTION set_updated_at ();

-- Seed sources (run after tables exist)
insert into public.buzz_sources (id, name, base_url, feed_url, sort_order) values
  ('5280', '5280 Magazine', 'https://www.5280.com', 'https://www.5280.com/category/eat-and-drink/feed/', 1),
  ('westword', 'Westword', 'https://www.westword.com', 'https://www.westword.com/index.rss', 2),
  ('eater-denver', 'Eater Denver', 'https://denver.eater.com', 'https://denver.eater.com/rss/index.xml', 3),
  ('303-magazine', '303 Magazine', 'https://303magazine.com', 'https://303magazine.com/feed/', 4),
  ('reddit-denverfood', 'r/denverfood', 'https://www.reddit.com/r/denverfood', 'https://www.reddit.com/r/denverfood/.rss', 5),
  ('new-denizen', 'New Denizen', 'https://newdenizen.com', 'https://newdenizen.substack.com/feed', 6)
on conflict (id) do update set
  name = excluded.name,
  base_url = excluded.base_url,
  feed_url = excluded.feed_url,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.buzz_sources (id, name, base_url, feed_url, enabled, sort_order) values
  ('ingoodtaste', 'In Good Taste Denver', 'https://ingoodtastedenver.com', null, false, 7),
  ('denver-ear', 'The Denver Ear', 'https://thedenverear.com', null, false, 8),
  ('denver-dweller', 'Denver Dweller', 'https://denverdweller.com', null, false, 9),
  ('biteswithbre', 'Bites with Bre', 'https://biteswithbre.com', null, false, 10)
on conflict (id) do update set
  name = excluded.name,
  base_url = excluded.base_url,
  feed_url = excluded.feed_url,
  enabled = excluded.enabled,
  sort_order = excluded.sort_order,
  updated_at = now();
