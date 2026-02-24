export const runtime = "nodejs";

type Restaurant = {
  id: string;
  name: string;
  neighborhood: string | null;
  status: string;
};

export default async function RestaurantsPage() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return (
      <main style={{ padding: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>Restaurants</h1>
        <p style={{ color: "crimson" }}>
          Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
        </p>
      </main>
    );
  }

  const res = await fetch(
    `${url}/rest/v1/restaurants?select=id,name,neighborhood,status&order=name.asc`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return (
      <main style={{ padding: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>Restaurants</h1>
        <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
      </main>
    );
  }

  const restaurants = (await res.json()) as Restaurant[];

  return (
    <main style={{ padding: 24, maxWidth: 800 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Restaurants</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>{restaurants.length} total</p>

      <ul style={{ marginTop: 16, paddingLeft: 18 }}>
        {restaurants.map((r) => (
          <li key={r.id} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <div style={{ opacity: 0.8, fontSize: 14 }}>
              {r.neighborhood ?? "—"} • {r.status}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}