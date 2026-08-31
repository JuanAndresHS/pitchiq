import type { PerformanceGap } from "@/lib/data";
import { shortName } from "@/lib/data";

/**
 * Where the table and the model disagree.
 *
 * The bar is drawn from a centre line so the direction reads at a glance:
 * right means the model rates a team above where it sits, left means below.
 * Length is proportional to the size of the disagreement.
 */

export default function PerformanceGaps({
  gaps,
}: {
  gaps: PerformanceGap[];
}) {
  if (gaps.length === 0) {
    return (
      <p className="text-pitch-dim py-6 text-sm">
        Not enough matches played to compare yet.
      </p>
    );
  }

  const widest = Math.max(...gaps.map((g) => Math.abs(g.gap)), 1);

  return (
    <div>
      <ul className="divide-pitch-line-soft divide-y">
        {gaps.map((gap) => {
          const share = (Math.abs(gap.gap) / widest) * 50;
          const better = gap.gap > 0;

          return (
            <li key={gap.team} className="py-2.5">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="font-display truncate text-base">
                  {shortName(gap.team)}
                </span>
                <span className="text-pitch-faint tnum shrink-0 text-xs">
                  {gap.tablePosition}
                  <span className="px-1">→</span>
                  {gap.modelRank}
                </span>
              </div>

              <div className="relative h-1.5">
                <span className="bg-pitch-line-soft absolute inset-0 rounded-full" />
                <span
                  className={`absolute top-0 h-full rounded-full ${
                    better ? "bg-outcome-home" : "bg-outcome-away"
                  }`}
                  style={
                    better
                      ? { left: "50%", width: `${share}%` }
                      : { right: "50%", width: `${share}%` }
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-pitch-faint mt-3 text-xs leading-relaxed">
        League position on the left, model rank on the right. Green means a team
        has played better than its points suggest and has room to climb; red
        means the table currently flatters it. Early in a season these gaps are
        wide, because a handful of results say less than a rating built on four
        years of matches.
      </p>
    </div>
  );
}
