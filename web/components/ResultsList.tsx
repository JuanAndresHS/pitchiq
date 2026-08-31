import type { ScoredResult } from "@/lib/data";
import { shortName } from "@/lib/data";

/**
 * Played matches paired with the call the model made beforehand.
 *
 * The verdict shown is not just hit or miss. A model that says 60% will be
 * wrong four times in ten and still be well calibrated, so the probability it
 * assigned to what actually happened is the more informative number — a miss
 * that gave the real outcome 31% is a very different thing from one that gave
 * it 4%.
 */

const formatDate = (iso: string) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
};

export default function ResultsList({
  results,
}: {
  results: ScoredResult[];
}) {
  if (results.length === 0) {
    return (
      <p className="text-pitch-dim py-6 text-sm">
        No matches played in this round yet.
      </p>
    );
  }

  return (
    <ul className="divide-pitch-line-soft divide-y">
      {results.map((match) => {
        const homeWon = match.result === "H";
        const awayWon = match.result === "A";

        return (
          <li
            key={match.matchId}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 py-3"
          >
            <span className="font-display min-w-0 flex-1 truncate text-base">
              <span className={homeWon ? "" : "text-pitch-dim"}>
                {shortName(match.homeTeam)}
              </span>
              <span className="text-pitch-faint px-2 text-sm">v</span>
              <span className={awayWon ? "" : "text-pitch-dim"}>
                {shortName(match.awayTeam)}
              </span>
            </span>

            <span className="font-display tnum shrink-0 text-lg leading-none">
              {match.homeGoals}
              <span className="text-pitch-faint px-1">–</span>
              {match.awayGoals}
            </span>

            {match.hit !== null && (
              <span className="flex w-full shrink-0 items-center gap-2 text-xs sm:w-auto sm:justify-end">
                <span
                  className={`rounded px-2 py-0.5 ${
                    match.hit
                      ? "bg-outcome-home text-ink-home"
                      : "border-pitch-line text-pitch-faint border"
                  }`}
                >
                  {match.hit ? "Called it" : "Missed"}
                </span>
                <span className="text-pitch-faint tnum">
                  gave this outcome{" "}
                  {Math.round((match.probabilityOfActual ?? 0) * 100)}%
                </span>
              </span>
            )}

            <span className="text-pitch-faint tnum w-full text-xs sm:w-auto">
              {formatDate(match.date)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
