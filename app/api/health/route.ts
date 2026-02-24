export const runtime = "nodejs";

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return Response.json(
      { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
    );
  }

  const res = await fetch(`${url}/rest/v1/restaurants?select=id`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return Response.json(
      { ok: false, error: `Supabase REST error ${res.status}`, details: text },
      { status: 500 }
    );
  }

  const contentRange = res.headers.get("content-range"); // e.g. "0-4/5"
  const total = contentRange?.split("/")[1];
  const restaurants = total ? Number(total) : null;

  return Response.json({ ok: true, restaurants });
}