-- Run in Supabase SQL Editor after buzz_articles exists.
-- Adds curated_rank (1-5) so the weekly cron can store "this week's 5 picks" from an LLM.

alter table public.buzz_articles
  add column if not exists curated_rank integer null;

comment on column public.buzz_articles.curated_rank is '1-5 = this week''s curated picks (best first); null = not curated';
