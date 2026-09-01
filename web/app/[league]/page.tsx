import type { Metadata } from "next";
import { notFound } from "next/navigation";

import Chat from "@/components/Chat";
import FeaturedForecast from "@/components/FeaturedForecast";
import FixtureList from "@/components/FixtureList";
import LeagueNav from "@/components/LeagueNav";
import PerformanceGaps from "@/components/PerformanceGaps";
import ResultsList from "@/components/ResultsList";
import StandingsTable from "@/components/StandingsTable";
import { LEAGUE_METRICS } from "@/lib/model-metrics";
import { LEAGUES, getLeagueByRoute } from "@/lib/leagues";
import {
  getFeaturedFixture,
  getNextMatchday,
  getPerformanceGaps,
  getRecentResults,
  getStandings,
  getSummary,
  getTeamRatings,
  getTrackRecord,
} from "@/lib/data";

export const revalidate = 3600;

/** Pre-render all five leagues at build time. */
export function generateStaticParams() {
  return LEAGUES.map((league) => ({ league: league.route }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ league: string }>;
}): Promise<Metadata> {
  const { league: route } = await params;
  const league = getLeagueByRoute(route);
  if (!league) return {};

  const title = `${league.name} forecasts — PitchIQ`;
  const description = `Probabilistic match forecasts for the ${league.name}, from a Dixon-Coles model. Updated daily, with an assistant you can ask in plain language.`;

  return {
    title,
    description,
    openGraph: { title, description, url: `/${league.route}` },
    twitter: { title, description },
  };
}

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

export default async function LeaguePage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: route } = await params;
  const league = getLeagueByRoute(route);
  if (!league) notFound();

  const slug = league.slug;

  const [summary, standings, nextMatchday, ratings, track, recent, gaps] =
    await Promise.all([
      getSummary(slug),
      getStandings(slug),
      getNextMatchday(slug),
      getTeamRatings(slug),
      getTrackRecord(slug),
      getRecentResults(slug),
      getPerformanceGaps(slug, 6),
    ]);

  const featured = await getFeaturedFixture(slug, nextMatchday.fixtures);
  const rest = nextMatchday.fixtures.filter(
    (f) => f.matchId !== featured?.matchId,
  );

  const metrics = LEAGUE_METRICS[slug];
  const seasonLabel = summary.season
    ? `${summary.season}/${String((summary.season + 1) % 100).padStart(2, "0")}`
    : "—";

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const topRated = ratings.slice(0, 8);

  return (
    /* data-league scopes this league's palette onto everything inside; the
       tokens in globals.css do the rest, with no conditional class anywhere. */
    <div data-league={slug} className="bg-pitch-void min-h-screen">
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
            <a href="#results" className="hover:text-pitch-text">
              Results
            </a>
            <a href="#model" className="hover:text-pitch-text">
              How it works
            </a>
          </nav>
        </div>

        <p className="text-pitch-dim mt-5 max-w-xl leading-relaxed">
          Probabilistic forecasts for Europe&apos;s five biggest leagues, from
          Dixon–Coles models fit season by season. Every fixture is a
          distribution, not a prediction.
        </p>

        <div className="mt-6">
          <LeagueNav current={league} />
        </div>
      </header>

      <main>
        <div className="border-pitch-line border-b px-6 py-10">
          <FeaturedForecast fixture={featured} />
        </div>

        <div className="space-y-14 px-6 py-10">
          <Chat league={league} />

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

          {rest.length > 0 && (
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
          )}

          {recent.results.length > 0 && (
            <Section
              id="results"
              title={
                recent.matchday
                  ? `Matchday ${recent.matchday} results`
                  : "Recent results"
              }
              meta={
                recent.scored > 0
                  ? `${recent.correct} of ${recent.scored} called`
                  : undefined
              }
            >
              <ResultsList results={recent.results} />

              <p className="text-pitch-faint mt-4 max-w-2xl text-xs leading-relaxed">
                Each forecast was logged before kick-off and is scored here
                against what happened. A model that says 60% should be wrong four
                times in ten — so the number that matters is the probability it
                gave the actual outcome, not the tally of hits.
              </p>
            </Section>
          )}

          <div className="grid gap-10 lg:grid-cols-[1.5fr_1fr]">
            <Section
              title="Table"
              meta={
                summary.lastUpdated ? `Updated ${summary.lastUpdated}` : undefined
              }
            >
              <StandingsTable rows={standings} />
            </Section>

            <div className="space-y-10">
              <Section title="Strongest sides" meta="Model rating">
                {topRated.length === 0 ? (
                  <p className="text-pitch-dim py-8 text-sm">
                    No ratings yet for this league.
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
                  Combined attack and defense strength estimated by the model.
                  Zero is league average, so this is independent of current
                  position — and only comparable within {league.name}.
                </p>
              </Section>

              <Section title="Table vs model" meta="Position gap">
                <PerformanceGaps gaps={gaps} />
              </Section>
            </div>
          </div>

          <Section id="model" title="How it works" meta="Data to forecast">
            <div className="text-pitch-dim space-y-6 text-sm leading-relaxed">
              <div className="grid gap-6 sm:grid-cols-3">
                <div>
                  <h3 className="text-pitch-text font-display mb-1.5 text-base">
                    Ingest
                  </h3>
                  <p>
                    A scheduled job pulls results for all five leagues from
                    football-data.org twice a day, validates them, and commits
                    the clean data. The dataset grows without anyone touching it.
                  </p>
                </div>
                <div>
                  <h3 className="text-pitch-text font-display mb-1.5 text-base">
                    Model
                  </h3>
                  <p>
                    Each league is fit separately, because attack and defense
                    ratings are only comparable within a competition. Goal counts
                    are statistically consistent with a Poisson distribution,
                    which makes Dixon–Coles a justified choice rather than an
                    arbitrary one.
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

              {metrics && (
                <div>
                  <h3 className="text-pitch-text font-display mt-8 mb-3 text-base">
                    Does it actually work — {league.name}
                  </h3>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Metric
                      label="Accuracy"
                      value={pct(metrics.accuracy.model)}
                      note={`baseline ${pct(metrics.accuracy.baseline)}`}
                    />
                    <Metric
                      label="Log-loss"
                      value={metrics.logLoss.model.toFixed(3)}
                      note={`baseline ${metrics.logLoss.baseline.toFixed(3)}`}
                    />
                    <Metric
                      label="RPS gain"
                      value={`${(metrics.rpsImprovement * 100).toFixed(1)}%`}
                      note="over baseline"
                    />
                    <Metric
                      label="Home advantage"
                      value={`${metrics.homeAdvantage.toFixed(2)}×`}
                      note="goal rate"
                    />
                  </div>

                  <p className="mt-4 max-w-2xl">
                    Measured on the {metrics.testSeason} season, held out
                    entirely from training. The baseline is always predicting a
                    home win. Accuracy is the least interesting number here —
                    football is genuinely high-variance, and bookmakers with far
                    richer data operate in a similar range. The meaningful gain
                    is in log-loss and ranked probability score, which measure
                    whether the stated probabilities are honest rather than
                    whether the top pick happened to land.
                  </p>

                  <p className="mt-4 max-w-2xl">
                    Difficulty varies by league. The Premier League is the
                    hardest of the five to forecast and the Bundesliga the
                    easiest, which matches how competitive each is: a division
                    with one dominant side is more predictable than one where
                    anyone beats anyone.
                  </p>
                </div>
              )}
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
          with any league or club.{" "}
          <a
            href="https://github.com/JuanAndresHS/pitchiq"
            className="text-pitch-dim underline underline-offset-2"
          >
            Source on GitHub
          </a>
        </p>
        </footer>
      </div>
    </div>
  );
}
