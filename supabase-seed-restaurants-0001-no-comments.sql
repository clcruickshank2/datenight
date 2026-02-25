begin;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RAISE EXCEPTION 'Profile % does not exist. Create it first, then rerun this seed.', '00000000-0000-0000-0000-000000000001';
  END IF;
END $$;

WITH seed AS (
  SELECT *
  FROM jsonb_to_recordset($json$[]$json$::jsonb) AS x(
    profile_id uuid,
    name text,
    neighborhood text,
    price_level integer,
    vibe_tags text[],
    status public.restaurant_status,
    notes text
  )
)
INSERT INTO public.restaurants (
  profile_id,
  name,
  neighborhood,
  price_level,
  vibe_tags,
  status,
  notes
)
SELECT
  s.profile_id,
  s.name,
  s.neighborhood,
  s.price_level,
  s.vibe_tags,
  s.status,
  s.notes
FROM seed s
ON CONFLICT (profile_id, name)
DO UPDATE SET
  neighborhood = EXCLUDED.neighborhood,
  price_level = EXCLUDED.price_level,
  vibe_tags = EXCLUDED.vibe_tags,
  status = EXCLUDED.status,
  notes = EXCLUDED.notes,
  updated_at = now();

commit;
