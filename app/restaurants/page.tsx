import Link from "next/link";

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
      <main>
        <h1 className="text-2xl font-semibold text-slate-900">Restaurants</h1>
        <div className="mt-4 card border-amber-200 bg-amber-50">
          <p className="text-amber-800">Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY</p>
        </div>
        <Link href="/plan" className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
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
      <main>
        <h1 className="text-2xl font-semibold text-slate-900">Restaurants</h1>
        <div className="mt-4 card">
          <pre className="whitespace-pre-wrap text-sm text-slate-600">{text}</pre>
        </div>
        <Link href="/plan" className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
      </main>
    );
  }

  const restaurants = (await res.json()) as Restaurant[];

  return (
    <main>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Restaurants</h1>
        <Link href="/plan" className="text-sm font-medium text-teal-700 hover:underline">
          ← Make a plan
        </Link>
      </div>
      <p className="text-slate-500">{restaurants.length} total</p>

      <ul className="mt-6 space-y-3">
        {restaurants.map((r) => (
          <li key={r.id} className="card">
            <div className="font-medium text-slate-900">{r.name}</div>
            <div className="text-sm text-slate-500">
              {r.neighborhood ?? "—"} · {r.status}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
