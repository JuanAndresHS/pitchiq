import type { LeagueStrength } from "@/lib/data";

/**
 * League strength with its uncertainty.
 *
 * The interval is the point of this chart, not decoration. Some pairs of
 * leagues meet three times in four seasons, and a bare number would imply a
 * precision the data cannot support. Where two intervals overlap, the model is
 * saying it cannot separate those leagues — which is a finding, not a failure.
 */
export default function LeagueStrengthChart({
  strengths,
  referenceName,
}: {
  strengths: LeagueStrength[];
  referenceName: string;
}) {
  if (strengths.length === 0) {
    return (
      <p className="text-pitch-dim py-6 text-sm">
        No cross-league estimate yet. Run the European model to generate one.
      </p>
    );
  }

  const values = strengths.flatMap((s) => [
    s.strength,
    s.ciLow ?? s.strength,
    s.ciHigh ?? s.strength,
  ]);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pad = span * 0.08;

  const position = (value: number) =>
    ((value - (min - pad)) / (span + pad * 2)) * 100;

  const zero = position(0);

  return (
    <div>
      <ul className="space-y-3.5">
        {strengths.map((s) => {
          const hasInterval = s.ciLow !== null && s.ciHigh !== null;
          const isReference = s.strength === 0 && !hasInterval;
          const low = position(s.ciLow ?? s.strength);
          const high = position(s.ciHigh ?? s.strength);

          // An interval that straddles zero means this league is not
          // distinguishable from the reference on the available matches.
          const straddlesZero =
            hasInterval && (s.ciLow as number) < 0 && (s.ciHigh as number) > 0;

          return (
            <li key={s.league}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="font-display truncate text-base">
                  {s.name}
                  {s.pooled && (
                    <span className="text-pitch-faint ml-2 text-xs">pooled</span>
                  )}
                </span>
                <span className="tnum text-pitch-dim shrink-0 text-sm">
                  {s.goalRatio.toFixed(2)}×
                </span>
              </div>

              <div className="relative h-4">
                <span
                  className="bg-pitch-line-soft absolute top-1/2 h-px w-full"
                  aria-hidden="true"
                />
                <span
                  className="bg-pitch-line absolute top-0 h-full w-px"
                  style={{ left: `${zero}%` }}
                  aria-hidden="true"
                />

                {hasInterval && !isReference && (
                  <span
                    className={`absolute top-1/2 h-1 -translate-y-1/2 rounded-full ${
                      straddlesZero ? "bg-pitch-line" : "bg-outcome-home/40"
                    }`}
                    style={{ left: `${low}%`, width: `${high - low}%` }}
                  />
                )}

                <span
                  className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                    isReference ? "bg-pitch-dim" : "bg-outcome-home"
                  }`}
                  style={{ left: `${position(s.strength)}%` }}
                  title={`${s.name}: ${s.strength >= 0 ? "+" : ""}${s.strength.toFixed(3)}`}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="text-pitch-faint mt-5 space-y-2 text-xs leading-relaxed">
        <p>
          Each league&apos;s goal rate relative to the {referenceName}, estimated
          only from matches where clubs from different leagues actually met. The
          bar is a 95% interval from bootstrap resampling.
        </p>
        <p>
          Where an interval crosses the centre line, the model cannot separate
          that league from the reference on the matches available. Two leagues
          whose intervals overlap are not ranked by this chart, whatever the
          order of the dots suggests.
        </p>
      </div>
    </div>
  );
}
