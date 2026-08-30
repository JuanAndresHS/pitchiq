import type { Forecast } from "@/lib/data";
import { shortName } from "@/lib/data";

/**
 * The hero is a live forecast rather than a description of one. Opening with
 * the matchday's most lopsided fixture shows the product working in the first
 * second, and the three-way split makes the point that these are distributions
 * rather than picks.
 */

const pct = (value: number) => Math.round(value * 100);

export default function FeaturedForecast({
  fixture,
}: {
  fixture: Forecast | null;
}) {
  if (!fixture) {
    return (
      <p className="text-pitch-dim text-sm">
        No fixtures forecast yet. Run the model notebook to generate them.
      </p>
    );
  }

  const home = shortName(fixture.homeTeam);
  const away = shortName(fixture.awayTeam);

  const outcomes = [
    { label: `${home} win`, value: fixture.pHome, color: "bg-outcome-home" },
    { label: "Draw", value: fixture.pDraw, color: "bg-outcome-draw" },
    { label: `${away} win`, value: fixture.pAway, color: "bg-outcome-away" },
  ];

  const leading = outcomes.reduce((a, b) => (b.value > a.value ? b : a));

  return (
    <div>
      <p className="text-pitch-faint mb-3 text-xs">
Matchday {fixture.matchday} · pick of the round
      </p>

      <h2 className="font-display text-3xl leading-none sm:text-4xl">
        {home}
        <span className="text-pitch-faint px-3 text-2xl">v</span>
        {away}
      </h2>

      <p className="font-display mt-5 text-5xl leading-none sm:text-6xl">
        <span className="tnum">{pct(leading.value)}%</span>
        <span className="text-pitch-dim ml-3 text-xl">{leading.label}</span>
      </p>

      <div className="mt-6 space-y-2">
        {outcomes.map((outcome) => (
          <div key={outcome.label} className="flex items-center gap-3">
            <span className="text-pitch-dim w-28 shrink-0 truncate text-xs">
              {outcome.label}
            </span>
            <span className="bg-pitch-line-soft h-2 flex-1 overflow-hidden rounded-full">
              <span
                className={`block h-full rounded-full ${outcome.color}`}
                style={{ width: `${outcome.value * 100}%` }}
              />
            </span>
            <span className="tnum text-pitch-dim w-9 shrink-0 text-right text-xs">
              {pct(outcome.value)}%
            </span>
          </div>
        ))}
      </div>

      <p className="text-pitch-faint tnum mt-5 text-xs">
        Expected goals {fixture.xgHome.toFixed(2)} – {fixture.xgAway.toFixed(2)}
        <span className="px-2">·</span>
        Likeliest score {fixture.likelyScore}
      </p>
    </div>
  );
}
