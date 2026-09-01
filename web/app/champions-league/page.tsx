import type { Metadata } from "next";

import Chat from "@/components/Chat";
import FeaturedForecast from "@/components/FeaturedForecast";
import FixtureList from "@/components/FixtureList";
import LeagueNav from "@/components/LeagueNav";
import LeagueStrengthChart from "@/components/LeagueStrengthChart";
import ResultsList from "@/components/ResultsList";
import { EUROPEAN_METRICS } from "@/lib/model-metrics";
import { CHAMPIONS_LEAGUE } from "@/lib/leagues";
import {
  getForecasts,
  getLeagueStrengths,
  getNextCupRound,
  getRecentCupRound,
  getSummary,
  getTrackRecord,
  roundLabel,
} from "@/lib/data";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Champions League forecasts",
  description:
    "Probabilistic forecasts for the Champions League, built by calibrating five domestic rating scales against each other using European fixtures.",
};

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

export default async function ChampionsLeaguePage() {
  const league = CHAMPIONS_LEAGUE;

  const [summary, forecasts, european, track, next, recent] = await Promise.all([
    getSummary(league.slug),
    getForecasts(league.slug),
    getLeagueStrengths(),
    getTrackRecord(league.slug),
    getNextCupRound(league.slug),
    getRecentCupRound(league.slug),
  ]);

  // The most lopsided call makes the clearest hero here: knockout football
  // produces genuine mismatches, and hiding that would be coy.
  const featured =
    [...next.fixtures].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const rest = next.fixtures.filter((f) => f.matchId !== featured?.matchId);

  const pooledCount = forecasts.filter((f) => f.pooled).length;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  const seasonLabel = summary.season
    ? `${summary.season}/${String((summary.season + 1) % 100).padStart(2, "0")}`
    : "—";

  return (
    <div data-league={league.slug} className="bg-pitch-void min-h-screen">
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
              <a href="#strength" className="hover:text-pitch-text">
                League strength
              </a>
              <a href="#model" className="hover:text-pitch-text">
                How it works
              </a>
            </nav>
          </div>

          <p className="text-pitch-dim mt-5 max-w-2xl leading-relaxed">
            Champions League forecasts. Domestic ratings live on separate scales,
            so predicting a match between two leagues means first working out how
            those scales relate — which only European fixtures can answer.
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
                  label="Calibration matches"
                  value={
                    european ? european.matchesFitted.toLocaleString("en-GB") : "—"
                  }
                  note="cross-league meetings"
                />
                <Metric
                  label={track.evaluated > 0 ? "Live accuracy" : "Open forecasts"}
                  value={
                    track.accuracy !== null
                      ? `${Math.round(track.accuracy * 100)}%`
                      : forecasts.length.toLocaleString("en-GB")
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
                title={roundLabel(next.round)}
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
                title={`${roundLabel(recent.round)} results`}
                meta={
                  recent.scored > 0
                    ? `${recent.correct} of ${recent.scored} called`
                    : undefined
                }
              >
                <ResultsList results={recent.results} />
              </Section>
            )}

            <Section
              id="strength"
              title="How the leagues compare"
              meta={
                european
                  ? `${european.matchesFitted} European matches`
                  : undefined
              }
            >
              <LeagueStrengthChart
                strengths={european?.strengths ?? []}
                referenceName={european?.referenceName ?? "Premier League"}
              />
            </Section>

            <Section id="model" title="How it works" meta="Two models, in order">
              <div className="text-pitch-dim space-y-6 text-sm leading-relaxed">
                <div className="grid gap-6 sm:grid-cols-3">
                  <div>
                    <h3 className="text-pitch-text font-display mb-1.5 text-base">
                      Rate each league
                    </h3>
                    <p>
                      Seven domestic models — the five shown on this site plus
                      Portugal and the Netherlands — give every club an attack
                      and defense rating. Each is centred on its own league&apos;s
                      average, which says nothing about how those averages
                      compare.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-pitch-text font-display mb-1.5 text-base">
                      Calibrate the scales
                    </h3>
                    <p>
                      With team ratings held fixed, one strength offset per league
                      is estimated from the European matches where clubs from
                      different leagues actually met. That is the only evidence
                      linking the scales, and there is not much of it — hence the
                      confidence intervals above.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-pitch-text font-display mb-1.5 text-base">
                      Forecast
                    </h3>
                    <p>
                      A fixture combines both clubs&apos; ratings, the gap between
                      their leagues, and a European home advantage of{" "}
                      {european ? `${european.homeAdvantage.toFixed(2)}×` : "—"} —
                      noticeably larger than any domestic one.
                    </p>
                  </div>
                </div>

                {EUROPEAN_METRICS && (
                  <div>
                    <h3 className="text-pitch-text font-display mt-8 mb-3 text-base">
                      Does it actually work
                    </h3>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Metric
                        label="Accuracy"
                        value={pct(EUROPEAN_METRICS.accuracy.model)}
                        note={`baseline ${pct(EUROPEAN_METRICS.accuracy.baseline)}`}
                      />
                      <Metric
                        label="Log-loss"
                        value={EUROPEAN_METRICS.logLoss.model.toFixed(3)}
                        note={`baseline ${EUROPEAN_METRICS.logLoss.baseline.toFixed(3)}`}
                      />
                      <Metric
                        label="RPS gain"
                        value={`${(EUROPEAN_METRICS.rpsImprovement * 100).toFixed(1)}%`}
                        note="over baseline"
                      />
                      <Metric
                        label="Home advantage"
                        value={`${EUROPEAN_METRICS.homeAdvantage.toFixed(2)}×`}
                        note="goal rate"
                      />
                    </div>

                    <p className="mt-4 max-w-2xl">
                      Measured on the {EUROPEAN_METRICS.testSeason} season with
                      every domestic rating refit behind that season&apos;s start
                      date. Reusing today&apos;s ratings would have handed the
                      model results that had not happened yet.
                    </p>

                    <p className="mt-4 max-w-2xl">
                      The raw accuracy looks higher than the domestic pages, but
                      it is not a fairer model — European draws are rarer and the
                      mismatches larger, so the baseline is higher too. The gain
                      over that baseline is what compares.
                    </p>

                    <p className="mt-4 max-w-2xl">
                      Fixtures involving a club from outside the seven modelled
                      leagues score{" "}
                      {(EUROPEAN_METRICS.pooledRpsPenalty * 1000).toFixed(1)}{" "}
                      thousandths worse on RPS. Those clubs share a single set of
                      parameters, so Celtic and Kairat look identical to the
                      model. It is the coarsest assumption here, and{" "}
                      {pooledCount} of {forecasts.length} open forecasts rest on
                      it.
                    </p>
                  </div>
                )}
              </div>
            </Section>
          </div>
        </main>

        <footer className="border-pitch-line text-pitch-faint border-t px-6 py-8 text-xs leading-relaxed">
          <p className="max-w-2xl">
            League strength here means the strength of the clubs that qualified,
            not of the division as a whole. Entry quotas differ — England sends
            five, the Netherlands one or two — so a league&apos;s figure reflects
            who it sends as much as how good it is.
          </p>
          <p className="mt-4">
            Data from football-data.org. An independent project, not affiliated
            with UEFA, any league or any club.{" "}
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
