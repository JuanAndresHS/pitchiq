import type { Forecast } from "@/lib/data";
import { shortName } from "@/lib/data";
import ProbabilityBar from "./ProbabilityBar";

const formatDate = (iso: string) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
};

export default function FixtureList({ fixtures }: { fixtures: Forecast[] }) {
  if (fixtures.length === 0) {
    return (
      <p className="text-pitch-dim py-8 text-sm">
        No fixtures forecast yet. Run the model notebook to generate them.
      </p>
    );
  }

  return (
    <ul className="divide-pitch-line-soft divide-y">
      {fixtures.map((fixture) => (
        <li key={fixture.matchId} className="py-4">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <h3 className="font-display truncate text-lg leading-tight">
              {shortName(fixture.homeTeam)}
              <span className="text-pitch-faint px-2 text-sm">v</span>
              {shortName(fixture.awayTeam)}
            </h3>
            <span className="text-pitch-dim tnum shrink-0 text-xs">
              {formatDate(fixture.date)}
            </span>
          </div>

          <ProbabilityBar
            home={fixture.pHome}
            draw={fixture.pDraw}
            away={fixture.pAway}
            homeTeam={shortName(fixture.homeTeam)}
            awayTeam={shortName(fixture.awayTeam)}
          />

          <div className="text-pitch-faint tnum mt-2 flex gap-4 text-xs">
            <span>
              Expected goals {fixture.xgHome.toFixed(2)} – {fixture.xgAway.toFixed(2)}
            </span>
            <span>Likeliest score {fixture.likelyScore}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
