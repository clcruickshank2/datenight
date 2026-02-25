-- Add enrichment fields for Buzz trending restaurants.
alter table public.buzz_restaurants
  add column if not exists neighborhood text null,
  add column if not exists price_level integer null,
  add column if not exists cuisine_vibes text[] not null default '{}'::text[],
  add column if not exists rating_source text null;

alter table public.buzz_restaurants
  drop constraint if exists buzz_restaurants_price_level_check;

alter table public.buzz_restaurants
  add constraint buzz_restaurants_price_level_check
  check (
    price_level is null or (price_level >= 1 and price_level <= 4)
  );
