import Link from "next/link";
import type { Metadata } from "next";

import Chat from "@/components/Chat";

import { LEAGUES, type League } from "@/lib/leagues";
import { LEAGUE_METRICS, OVERALL_ACCURACY } from "@/lib/model-metrics";
import {
  getForecasts,
  getSummary,
  getTeamRatings,
  getTrackRecord,
  shortName,
} from "@/lib/data";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "PitchIQ — Football forecasts for Europe's five biggest leagues",
  description:
    "Probabilistic match forecasts for the Premier League, LaLiga, Serie A, Bundesliga and Ligue 1, from Dixon-Coles models updated daily.",
};

type Card = {
  league: League;
  matches: number;
  openForecasts: number;
  strongest: string | null;
  nextFixture: { home: string; away: string; pHome: number; pDraw: number; pAway: number } | null;
  track: { evaluated: number; correct: number };
};

async function buildCard(league: League): Promise<Card> {
  const [summary, ratings, forecasts, track] = await Promise.all([
    getSummary(league.slug),
    getTeamRatings(league.slug),
    getForecasts(league.slug),
    getTrackRecord(league.slug),
  ]);

  const next = forecasts[0] ?? null;

  return {
    league,
    matches: summary.matchesAnalysed,
    openForecasts: summary.forecastsOpen,
    strongest: ratings[0] ? shortName(ratings[0].team) : null,
    nextFixture: next
      ? {
          home: shortName(next.homeTeam),
          away: shortName(next.awayTeam),
          pHome: next.pHome,
          pDraw: next.pDraw,
          pAway: next.pAway,
        }
      : null,
    track: { evaluated: track.evaluated, correct: track.correct },
  };
}

function LeagueCard({ card }: { card: Card }) {
  const { league, nextFixture } = card;
  const metrics = LEAGUE_METRICS[league.slug];

  return (
    // The card carries its own palette scope, so every token inside resolves to
    // that league's colours without a single conditional class.
    <Link
      href={`/${league.route}`}
      data-league={league.slug}
      className="bg-pitch-deep border-pitch-line hover:border-outcome-draw group block rounded-xl border p-6 transition-colors"
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl leading-none">{league.name}</h2>
        <span className="text-pitch-faint text-[11px] tracking-wider">
          {league.code}
        </span>
      </div>

      <p className="text-pitch-dim mb-5 text-sm leading-snug">
        {league.tagline}
      </p>

      {nextFixture && (
        <div className="mb-5">
          <p className="text-pitch-faint mb-2 text-xs">Next up</p>
          <p className="font-display mb-2 truncate text-base">
            {nextFixture.home}
            <span className="text-pitch-faint px-2 text-sm">v</span>
            {nextFixture.away}
          </p>
          <div
            className="flex h-2 overflow-hidden rounded-full"
            role="img"
            aria-label={`${Math.round(nextFixture.pHome * 100)} percent home win, ${Math.round(nextFixture.pDraw * 100)} percent draw, ${Math.round(nextFixture.pAway * 100)} percent away win`}
          >
            <span
              className="bg-outcome-home"
              style={{ width: `${nextFixture.pHome * 100}%` }}
            />
            <span
              className="bg-outcome-draw"
              style={{ width: `${nextFixture.pDraw * 100}%` }}
            />
            <span
              className="bg-outcome-away"
              style={{ width: `${nextFixture.pAway * 100}%` }}
            />
          </div>
        </div>
      )}

      <dl className="text-pitch-faint grid grid-cols-3 gap-3 text-xs">
        <div>
          <dt>Matches</dt>
          <dd className="text-pitch-text tnum font-display mt-0.5 text-lg leading-none">
            {card.matches.toLocaleString("en-GB")}
          </dd>
        </div>
        <div>
          <dt>Accuracy</dt>
          <dd className="text-pitch-text tnum font-display mt-0.5 text-lg leading-none">
            {metrics ? `${(metrics.accuracy.model * 100).toFixed(0)}%` : "—"}
          </dd>
        </div>
        <div>
          <dt>{card.track.evaluated > 0 ? "Called" : "Open"}</dt>
          <dd className="text-pitch-text tnum font-display mt-0.5 text-lg leading-none">
            {card.track.evaluated > 0
              ? `${card.track.correct}/${card.track.evaluated}`
              : card.openForecasts}
          </dd>
        </div>
      </dl>

      <p className="text-outcome-draw mt-5 text-sm opacity-0 transition-opacity group-hover:opacity-100">
        Open {league.shortName} →
      </p>
    </Link>
  );
}

export default async function HomePage() {
  const cards = await Promise.all(LEAGUES.map(buildCard));

  const totalMatches = cards.reduce((sum, c) => sum + c.matches, 0);
  const totalOpen = cards.reduce((sum, c) => sum + c.openForecasts, 0);

  return (
    <div data-league="home" className="bg-pitch-deep min-h-screen">
      <div className="mx-auto max-w-5xl px-6">
        <header className="border-pitch-line border-b pt-16 pb-10">
          <h1 className="font-display text-6xl leading-[0.85] tracking-tight sm:text-8xl">
            PitchIQ
          </h1>

          <p className="text-pitch-dim mt-6 max-w-2xl text-lg leading-relaxed">
            Probabilistic match forecasts for Europe&apos;s five biggest
            leagues. Every fixture is a distribution, not a prediction — and
            every forecast is logged before kick-off so it can be scored
            afterwards.
          </p>

          <dl className="text-pitch-faint mt-8 flex flex-wrap gap-x-10 gap-y-4 text-xs">
            <div>
              <dt>Leagues covered</dt>
              <dd className="font-display text-pitch-text tnum mt-1 text-2xl leading-none">
                {LEAGUES.length}
              </dd>
            </div>
            <div>
              <dt>Matches analysed</dt>
              <dd className="font-display text-pitch-text tnum mt-1 text-2xl leading-none">
                {totalMatches.toLocaleString("en-GB")}
              </dd>
            </div>
            <div>
              <dt>Open forecasts</dt>
              <dd className="font-display text-pitch-text tnum mt-1 text-2xl leading-none">
                {totalOpen.toLocaleString("en-GB")}
              </dd>
            </div>
            <div>
              <dt>Weighted accuracy</dt>
              <dd className="font-display text-pitch-text tnum mt-1 text-2xl leading-none">
                {(OVERALL_ACCURACY * 100).toFixed(1)}%
              </dd>
            </div>
          </dl>
        </header>

        <main className="py-10">
          {/* The assistant leads: it is what separates this from a stats site,
              and burying it under the grid hides the most interesting part. */}
          <Chat />

          <h2 className="font-display mt-14 mb-4 text-xl leading-none">
            Choose a league
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {cards.map((card) => (
              <LeagueCard key={card.league.slug} card={card} />
            ))}
          </div>

          <section className="border-pitch-line mt-14 border-t pt-8">
            <h2 className="font-display mb-4 text-xl leading-none">
              How it works
            </h2>

            <div className="text-pitch-dim grid gap-6 text-sm leading-relaxed sm:grid-cols-3">
              <p>
                A scheduled job pulls results for all five leagues twice a day,
                validates them, and retrains each model. Nobody touches it.
              </p>
              <p>
                Each league is fit separately with a Dixon–Coles model, because
                attack and defense ratings are only comparable within a
                competition — there are no matches connecting them.
              </p>
              <p>
                Every league page carries an assistant with tools that query the
                data directly. It cannot recall a standing or invent a
                probability; it has to ask.
              </p>
            </div>
          </section>
        </main>

        <footer className="border-pitch-line text-pitch-faint border-t py-8 text-xs leading-relaxed">
          <p className="max-w-2xl">
            The models know goals, teams and dates. They do not know about
            injuries, suspensions, transfers or European fixture congestion, and
            newly promoted sides carry the least reliable ratings.
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
