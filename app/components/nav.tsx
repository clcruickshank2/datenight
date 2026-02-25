"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/buzz", label: "The Buzz" },
  { href: "/plan", label: "Make a plan" },
  { href: "/wishlist", label: "Wishlist" },
  { href: "/feedback", label: "Feedback" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/plan"
          className="font-semibold text-slate-800 transition hover:text-rez-primary"
        >
          RezSimple
        </Link>
        <nav className="flex items-center gap-1" aria-label="Main">
          {tabs.map(({ href, label }) => {
            const active = pathname === href || (href === "/plan" && (pathname === "/plan" || pathname === "/onboarding")) || (href !== "/plan" && pathname?.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-rez-primary/10 text-rez-primary"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
