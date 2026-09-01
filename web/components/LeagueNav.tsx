import Link from "next/link";
import { LEAGUES, type League } from "@/lib/leagues";

/**
 * League switcher.
 *
 * Rendered as links rather than a dropdown so every competition is one click
 * away and each has its own crawlable URL. Country codes stand in for flag
 * emoji, which Windows does not render.
 */
export default function LeagueNav({ current }: { current: League }) {
  return (
    <nav aria-label="Leagues" className="flex flex-wrap items-center gap-2">
      <Link
        href="/"
        className="text-pitch-faint hover:text-pitch-text mr-1 text-sm"
      >
        ← All
      </Link>

      {LEAGUES.map((league) => {
        const active = league.slug === current.slug;

        return (
          <Link
            key={league.slug}
            href={`/${league.route}`}
            aria-current={active ? "page" : undefined}
            className={`font-display flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
              active
                ? "border-outcome-draw text-outcome-draw"
                : "border-pitch-line text-pitch-dim hover:border-pitch-dim hover:text-pitch-text"
            }`}
          >
            <span
              className="text-[10px] tracking-wider opacity-60"
              aria-hidden="true"
            >
              {league.code}
            </span>
            {league.shortName}
          </Link>
        );
      })}
    </nav>
  );
}
