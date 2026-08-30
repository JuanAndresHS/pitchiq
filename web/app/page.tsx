import FixtureList from "@/components/FixtureList";
import StandingsTable from "@/components/StandingsTable";
import {
  getNextMatchday,
  getStandings,
  getSummary,
  getTeamRatings,
  getTrackRecord,
  shortName,
} from "@/lib/data";

/*
  Rebuilt hourly. The ingestion pipeline commits new results daily, which
  triggers a redeploy anyway — this is a safety net for the gap between them.
*/
export const revalidate = 3600;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-pitch-raised rounded-lg px-4 py-3">
      <p className="text-pitch-faint text-xs">{label}</p>
      <p className="font-display tnum mt-1 text-2xl leading-none">{value}</p>
    </div>
  );
}

function SectionHeading({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="font-display text-xl leading-none">{title}</h2>
      {meta && <span className="text-pitch-faint text-xs">{meta}</span>}
    </div>
  );
}

export default async function Home() {
  const [summary, standings, nextMatchday, ratings, track] = await Promise.all([
    getSummary(),
    getStandings(),
    getNextMatchday(),
    getTeamRatings(),
    getTrackRecord(),
  ]);

  const seasonLabel = summary.season
    ? `${summary.season}/${String((summary.season + 1) % 100).padStart(2, "0")}`
    : "—";

  return (
    <div className="bg-pitch-deep mx-auto min-h-screen max-w-5xl">
      <header className="border-pitch-line border-b px-6 py-8">
        <h1 className="font-display text-4xl leading-none tracking-tight">
          PitchIQ
        </h1>
        <p className="text-pitch-dim mt-2 max-w-lg text-sm leading-relaxed">
          Probabilistic forecasts for the Premier League, from a Dixon–Coles
          model fit on four seasons of results. Every match is a distribution,
          not a prediction.
        </p>
      </header>

      <main className="space-y-10 px-6 py-8">
        <section>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Season" value={seasonLabel} />
            <Stat
              label="Matches analysed"
              value={summary.matchesAnalysed.toLocaleString("en-GB")}
            />
            <Stat
              label="Goals per match"
              value={summary.goalsPerMatch.toFixed(2)}
            />
            <Stat
              label={track.evaluated > 0 ? "Live accuracy" : "Open forecasts"}
              value={
                track.accuracy !== null
                  ? `${Math.round(track.accuracy * 100)}%`
                  : summary.forecastsOpen.toLocaleString("en-GB")
              }
            />
          </div>
          {track.evaluated > 0 && (
            <p className="text-pitch-faint mt-2 text-xs">
              {track.correct} correct from {track.evaluated} forecasts scored
              against real results.
            </p>
          )}
        </section>

        <section>
          <SectionHeading
            title={
              nextMatchday.matchday
                ? `Matchday ${nextMatchday.matchday}`
                : "Next fixtures"
            }
            meta="Model forecast"
          />
          <FixtureList fixtures={nextMatchday.fixtures} />

          <div className="text-pitch-faint mt-4 flex flex-wrap gap-4 text-xs">
            <span className="flex items-center gap-2">
              <span className="bg-outcome-home size-2 rounded-xs" />
              Home win
            </span>
            <span className="flex items-center gap-2">
              <span className="bg-outcome-draw size-2 rounded-xs" />
              Draw
            </span>
            <span className="flex items-center gap-2">
              <span className="bg-outcome-away size-2 rounded-xs" />
              Away win
            </span>
          </div>
        </section>

        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <section>
            <SectionHeading
              title="Table"
              meta={
                summary.lastUpdated ? `Updated ${summary.lastUpdated}` : undefined
              }
            />
            <StandingsTable rows={standings} />
          </section>

          <section>
            <SectionHeading title="Model ratings" meta="Attack + defense" />
            {ratings.length === 0 ? (
              <p className="text-pitch-dim py-8 text-sm">
                No ratings yet. Run the model notebook to generate them.
              </p>
            ) : (
              <ol className="divide-pitch-line-soft divide-y">
                {ratings.slice(0, 10).map((rating, i) => (
                  <li
                    key={rating.team}
                    className="flex items-baseline justify-between gap-3 py-2"
                  >
                    <span className="text-pitch-faint tnum w-5 text-sm">
                      {i + 1}
                    </span>
                    <span className="font-display flex-1 truncate text-base">
                      {shortName(rating.team)}
                    </span>
                    <span className="tnum text-outcome-draw text-sm">
                      {rating.overall > 0 ? "+" : ""}
                      {rating.overall.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-pitch-faint mt-3 text-xs leading-relaxed">
              Combined attack and defense strength estimated by the model. Zero
              is league average, so these are independent of current position.
            </p>
          </section>
        </div>
      </main>

      <footer className="border-pitch-line text-pitch-faint border-t px-6 py-6 text-xs leading-relaxed">
        <p>
          The model knows goals, teams and dates. It does not know about
          injuries, suspensions or European fixture congestion, and newly
          promoted sides carry the least reliable ratings.
        </p>
        <p className="mt-3">
          Data from football-data.org. An independent project, not affiliated
          with the Premier League.{" "}
          <a
            href="https://github.com/JuanAndresHS/pitchiq"
            className="text-pitch-dim underline underline-offset-2"
          >
            Source on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
