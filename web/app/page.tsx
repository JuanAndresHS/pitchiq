import Chat from "@/components/Chat";
import FeaturedForecast from "@/components/FeaturedForecast";
import FixtureList from "@/components/FixtureList";
import StandingsTable from "@/components/StandingsTable";
import { MODEL_METRICS } from "@/lib/model-metrics";
import {
  getFeaturedFixture,
  getNextMatchday,
  getStandings,
  getSummary,
  getTeamRatings,
  getTrackRecord,
} from "@/lib/data";

export const revalidate = 3600;

function Section({
  id,
  title,
  meta,
  children,
}: {
  id?: string;
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <div className="border-pitch-line mb-4 flex items-baseline justify-between gap-4 border-b pb-2">
        <h2 className="font-display text-xl leading-none">{title}</h2>
        {meta && <span className="text-pitch-faint text-xs">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="bg-pitch-raised rounded-lg px-4 py-3.5">
      <p className="text-pitch-faint text-xs">{label}</p>
      <p className="font-display tnum mt-1.5 text-2xl leading-none">{value}</p>
      {note && <p className="text-pitch-faint mt-1.5 text-xs">{note}</p>}
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

  const featured = await getFeaturedFixture(nextMatchday.fixtures);

  const rest = nextMatchday.fixtures.filter(
    (f) => f.matchId !== featured?.matchId,
  );

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const topRated = ratings.slice(0, 6);

  return (
    <div className="bg-pitch-deep mx-auto min-h-screen max-w-5xl">
      <header className="border-pitch-line border-b px-6 pt-12 pb-9">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <h1 className="font-display text-6xl leading-[0.85] tracking-tight sm:text-8xl">
            PitchIQ
          </h1>
          <nav className="text-pitch-faint flex gap-4 pb-1 text-xs">
            <a href="#ask" className="hover:text-pitch-text">
              Ask
            </a>
            <a href="#fixtures" className="hover:text-pitch-text">
              Fixtures
            </a>
            <a href="#model" className="hover:text-pitch-text">
              How it works
            </a>
          </nav>
        </div>

        <p className="text-pitch-dim mt-5 max-w-xl leading-relaxed">
          Probabilistic forecasts for the Premier League, from a Dixon–Coles
          model fit on {summary.matchesAnalysed.toLocaleString("en-GB")} matches.
          Every fixture is a distribution, not a prediction.
        </p>
      </header>

      <main>
        <div className="border-pitch-line border-b px-6 py-10">
          <FeaturedForecast fixture={featured} />
        </div>

        <div className="space-y-14 px-6 py-10">
          <Chat />

          <section>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Season" value={seasonLabel} />
              <Metric
                label="Matches analysed"
                value={summary.matchesAnalysed.toLocaleString("en-GB")}
              />
              <Metric
                label="Goals per match"
                value={summary.goalsPerMatch.toFixed(2)}
              />
              <Metric
                label={track.evaluated > 0 ? "Live accuracy" : "Open forecasts"}
                value={
                  track.accuracy !== null
                    ? `${Math.round(track.accuracy * 100)}%`
                    : summary.forecastsOpen.toLocaleString("en-GB")
                }
                note={
                  track.evaluated > 0
                    ? `${track.correct} of ${track.evaluated} scored`
                    : undefined
                }
              />
            </div>
          </section>

          <Section
            id="fixtures"
            title={
              nextMatchday.matchday
                ? `Rest of matchday ${nextMatchday.matchday}`
                : "Next fixtures"
            }
            meta="Model forecast"
          >
            <FixtureList fixtures={rest} />

            <div className="text-pitch-faint mt-5 flex flex-wrap gap-4 text-xs">
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
          </Section>

          <div className="grid gap-10 lg:grid-cols-[1.5fr_1fr]">
            <Section
              title="Table"
              meta={
                summary.lastUpdated ? `Updated ${summary.lastUpdated}` : undefined
              }
            >
              <StandingsTable rows={standings} />
            </Section>

            <Section title="Strongest sides" meta="Model rating">
              {topRated.length === 0 ? (
                <p className="text-pitch-dim py-8 text-sm">
                  No ratings yet. Run the model notebook to generate them.
                </p>
              ) : (
                <ol className="divide-pitch-line-soft divide-y">
                  {topRated.map((rating, i) => (
                    <li
                      key={rating.team}
                      className="flex items-baseline justify-between gap-3 py-2.5"
                    >
                      <span className="text-pitch-faint tnum w-5 text-sm">
                        {i + 1}
                      </span>
                      <span className="font-display flex-1 truncate text-base">
                        {rating.team.replace(/\s+FC$/, "")}
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
                is league average, so this is independent of current position.
              </p>
            </Section>
          </div>

          <Section id="model" title="How it works" meta="Data to forecast">
            <div className="text-pitch-dim space-y-6 text-sm leading-relaxed">
              <div className="grid gap-6 sm:grid-cols-3">
                <div>
                  <h3 className="text-pitch-text font-display mb-1.5 text-base">
                    Ingest
                  </h3>
                  <p>
                    A scheduled job pulls results from football-data.org every
                    morning, validates them, and commits the clean data. The
                    dataset grows without anyone touching it.
                  </p>
                </div>
                <div>
                  <h3 className="text-pitch-text font-display mb-1.5 text-base">
                    Model
                  </h3>
                  <p>
                    Goal counts turn out to be statistically consistent with a
                    Poisson distribution, which makes Dixon–Coles a justified
                    choice rather than an arbitrary one. Each team gets an attack
                    and a defense parameter; home advantage is a shared term.
                  </p>
                </div>
                <div>
                  <h3 className="text-pitch-text font-display mb-1.5 text-base">
                    Answer
                  </h3>
                  <p>
                    The assistant above has tools that query this data directly.
                    It cannot recall a standing or invent a probability — it has
                    to ask, which is what keeps a fluent wrong answer from
                    reaching you.
                  </p>
                </div>
              </div>

              <div>
                <h3 className="text-pitch-text font-display mt-8 mb-3 text-base">
                  Does it actually work
                </h3>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric
                    label="Accuracy"
                    value={pct(MODEL_METRICS.accuracy.model)}
                    note={`baseline ${pct(MODEL_METRICS.accuracy.baseline)}`}
                  />
                  <Metric
                    label="Log-loss"
                    value={MODEL_METRICS.logLoss.model.toFixed(3)}
                    note={`baseline ${MODEL_METRICS.logLoss.baseline.toFixed(3)}`}
                  />
                  <Metric
                    label="RPS gain"
                    value={`${(MODEL_METRICS.rpsImprovement * 100).toFixed(1)}%`}
                    note="over baseline"
                  />
                  <Metric
                    label="Home advantage"
                    value={`${MODEL_METRICS.homeAdvantage.toFixed(2)}×`}
                    note="goal rate"
                  />
                </div>

                <p className="mt-4 max-w-2xl">
                  Measured on the {MODEL_METRICS.testSeason} season, held out
                  entirely from training. The baseline is always predicting a
                  home win. Accuracy is the least interesting number here —
                  football is genuinely high-variance, and bookmakers with far
                  richer data operate in a similar range. The meaningful gain is
                  in log-loss and ranked probability score, which measure whether
                  the stated probabilities are honest rather than whether the top
                  pick happened to land.
                </p>
              </div>
            </div>
          </Section>
        </div>
      </main>

      <footer className="border-pitch-line text-pitch-faint border-t px-6 py-8 text-xs leading-relaxed">
        <p className="max-w-2xl">
          The model knows goals, teams and dates. It does not know about
          injuries, suspensions, transfers or European fixture congestion, and
          newly promoted sides carry the least reliable ratings. These limits are
          stated rather than buried, because a forecasting system that overstates
          its reach is worse than one that is clear about where it stops.
        </p>
        <p className="mt-4">
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
