/**
 * Data access for PitchIQ.
 *
 * Reads the CSVs produced by the Python pipeline. Everything here runs on the
 * server at build/request time, so the browser never downloads the raw data.
 *
 * The CSVs are the contract between the Python side and the web app: Python
 * trains and forecasts offline, TypeScript only reads the artifacts. That keeps
 * the deployment a plain Next.js app with no Python runtime.
 *
 * Every function takes a league slug. Leagues are modelled separately — attack
 * and defense ratings are only comparable within a competition — so nothing
 * here ever mixes them.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DATA_ROOT = path.join(process.cwd(), "data");
const PROCESSED = path.join(DATA_ROOT, "processed");
const PREDICTIONS = path.join(DATA_ROOT, "predictions");

// --- Types -------------------------------------------------------------------

export type Match = {
  matchId: number;
  league: string;
  season: number;
  matchday: number;
  /** Cups only: LEAGUE_STAGE, LAST_16, FINAL and so on. */
  stage: string | null;
  date: string;
  status: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number | null;
  awayGoals: number | null;
  result: "H" | "D" | "A" | null;
};

export type Forecast = {
  matchId: number;
  date: string;
  matchday: number;
  homeTeam: string;
  awayTeam: string;
  xgHome: number;
  xgAway: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  likelyScore: string;
  prediction: "H" | "D" | "A";
  confidence: number;
  /** Cup fixtures only: the round, and whether either club came from the
   *  pooled group rather than a modelled league. */
  stage?: string;
  pooled?: boolean;
  homeLeague?: string;
  awayLeague?: string;
};

export type LeagueStrength = {
  league: string;
  name: string;
  strength: number;
  goalRatio: number;
  ciLow: number | null;
  ciHigh: number | null;
  pooled: boolean;
};

export type EuropeanModel = {
  reference: string;
  referenceName: string;
  matchesFitted: number;
  homeAdvantage: number;
  rho: number;
  bootstrapDraws: number;
  strengths: LeagueStrength[];
  fittedAt: string;
};

export type TeamRating = {
  team: string;
  attack: number;
  defense: number;
  overall: number;
  matches: number;
};

export type TableRow = {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: string;
};

export type ScoredResult = {
  matchId: number;
  date: string;
  matchday: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  result: "H" | "D" | "A";
  predicted: "H" | "D" | "A" | null;
  probabilityOfActual: number | null;
  hit: boolean | null;
};

export type ModelParams = {
  league: string;
  leagueName: string;
  homeAdvantage: number;
  rho: number;
  xi: number;
  alpha: number;
  teams: number;
  matchesFitted: number;
  seasons: number;
  goalsPerMatch: number;
  homeWinRate: number;
  drawRate: number;
  awayWinRate: number;
  fittedAt: string;
};

export type PerformanceGap = {
  team: string;
  tablePosition: number;
  modelRank: number;
  gap: number;
  points: number;
  played: number;
};

// --- CSV parsing -------------------------------------------------------------

/**
 * Minimal RFC-4180 parser. Written by hand rather than pulled from a package
 * because the only thing it needs to survive is quoted fields containing
 * commas, and a dependency for thirty lines is not worth the install.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];

  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((key, i) => [key.trim(), r[i]])));
}

const num = (value: string | undefined): number | null => {
  if (value === undefined || value === "" || value === "nan") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// --- Loaders -----------------------------------------------------------------

// Cached per league. A request may touch the same league several times and the
// files do not change between reads within a single render.
const matchCache = new Map<string, Match[]>();

export async function getMatches(league: string): Promise<Match[]> {
  const cached = matchCache.get(league);
  if (cached) return cached;
  if (!existsSync(PROCESSED)) return [];

  const files = (await readdir(PROCESSED)).filter(
    (f) => f.startsWith(`${league}_matches_`) && f.endsWith(".csv"),
  );

  const all: Match[] = [];

  for (const file of files) {
    const text = await readFile(path.join(PROCESSED, file), "utf8");

    for (const r of parseCsv(text)) {
      const result = r.result as Match["result"];
      all.push({
        matchId: num(r.match_id) ?? 0,
        league,
        season: num(r.season) ?? 0,
        matchday: num(r.matchday) ?? 0,
        stage: r.stage || null,
        date: (r.utc_date ?? "").slice(0, 10),
        status: r.status ?? "",
        homeTeam: r.home_team ?? "",
        awayTeam: r.away_team ?? "",
        homeGoals: num(r.home_goals),
        awayGoals: num(r.away_goals),
        result: result === "H" || result === "D" || result === "A" ? result : null,
      });
    }
  }

  all.sort((a, b) => a.date.localeCompare(b.date));
  matchCache.set(league, all);
  return all;
}

export async function getForecasts(league: string): Promise<Forecast[]> {
  const file = path.join(PREDICTIONS, league, "upcoming_forecasts.csv");
  if (!existsSync(file)) return [];

  const text = await readFile(file, "utf8");

  return parseCsv(text)
    .map((r) => ({
      matchId: num(r.match_id) ?? 0,
      date: (r.date ?? "").slice(0, 10),
      matchday: num(r.matchday) ?? 0,
      homeTeam: r.home_team ?? "",
      awayTeam: r.away_team ?? "",
      xgHome: num(r.xg_home) ?? 0,
      xgAway: num(r.xg_away) ?? 0,
      pHome: num(r.p_home_win) ?? 0,
      pDraw: num(r.p_draw) ?? 0,
      pAway: num(r.p_away_win) ?? 0,
      likelyScore: r.most_likely_score ?? "",
      prediction: (r.prediction as Forecast["prediction"]) ?? "H",
      confidence: num(r.confidence) ?? 0,
      stage: r.stage || undefined,
      pooled: r.pooled_side ? r.pooled_side.toLowerCase() === "true" : undefined,
      homeLeague: r.home_league || undefined,
      awayLeague: r.away_league || undefined,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getTeamRatings(league: string): Promise<TeamRating[]> {
  const file = path.join(PREDICTIONS, league, "team_ratings.csv");
  if (!existsSync(file)) return [];

  const text = await readFile(file, "utf8");

  return parseCsv(text)
    .map((r) => ({
      team: r.team ?? "",
      attack: num(r.attack) ?? 0,
      defense: num(r.defense) ?? 0,
      overall: num(r.overall) ?? 0,
      matches: num(r.matches) ?? 0,
    }))
    .sort((a, b) => b.overall - a.overall);
}

/**
 * The parameters the model actually estimated, written by the training script.
 *
 * Read from disk rather than hardcoded so the site can never drift from the
 * model. Home advantage and rho describe the competition rather than any squad,
 * which is why — unlike team ratings — they are meaningful to compare across
 * leagues.
 */
export async function getModelParams(
  league: string,
): Promise<ModelParams | null> {
  const file = path.join(PREDICTIONS, league, "model_params.json");
  if (!existsSync(file)) return null;

  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return {
      league: raw.league,
      leagueName: raw.league_name,
      homeAdvantage: raw.home_advantage,
      rho: raw.rho,
      xi: raw.xi,
      alpha: raw.alpha,
      teams: raw.teams,
      matchesFitted: raw.matches_fitted,
      seasons: raw.seasons,
      goalsPerMatch: raw.goals_per_match,
      homeWinRate: raw.home_win_rate,
      drawRate: raw.draw_rate,
      awayWinRate: raw.away_win_rate,
      fittedAt: raw.fitted_at,
    };
  } catch {
    return null;
  }
}

/**
 * Relative league strength, estimated from European fixtures.
 *
 * Domestic ratings live on separate scales — a +0.5 in the Bundesliga and a
 * +0.5 in LaLiga are each "half a unit above that league's average", and
 * nothing in domestic data says whether those averages match. This is the
 * calibration between them, and the only place in the project where a
 * cross-league comparison is defensible.
 */
export async function getLeagueStrengths(): Promise<EuropeanModel | null> {
  const file = path.join(PREDICTIONS, "cl", "league_strengths.json");
  if (!existsSync(file)) return null;

  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return {
      reference: raw.reference,
      referenceName: raw.reference_name,
      matchesFitted: raw.matches_fitted,
      homeAdvantage: raw.home_advantage,
      rho: raw.rho,
      bootstrapDraws: raw.bootstrap_draws,
      strengths: (raw.strengths ?? []).map(
        (s: Record<string, unknown>): LeagueStrength => ({
          league: s.league as string,
          name: s.name as string,
          strength: s.strength as number,
          goalRatio: s.goal_ratio as number,
          ciLow: (s.ci_low as number | null) ?? null,
          ciHigh: (s.ci_high as number | null) ?? null,
          pooled: Boolean(s.pooled),
        }),
      ),
      fittedAt: raw.fitted_at,
    };
  } catch {
    return null;
  }
}

type LoggedForecast = {
  predicted: "H" | "D" | "A";
  pHome: number;
  pDraw: number;
  pAway: number;
};

/**
 * The append-only forecast log, keyed by match.
 *
 * Separate from getForecasts(): that file only holds unplayed fixtures and is
 * rewritten every run, so a match disappears from it the moment it kicks off.
 * The log keeps the call that stood beforehand, which is the only version worth
 * grading.
 */
async function getPredictionLog(
  league: string,
): Promise<Map<number, LoggedForecast>> {
  const file = path.join(PREDICTIONS, league, "prediction_log.csv");
  if (!existsSync(file)) return new Map();

  const text = await readFile(file, "utf8");
  const log = new Map<number, LoggedForecast>();

  for (const row of parseCsv(text)) {
    const matchId = num(row.match_id);
    const predicted = row.prediction as LoggedForecast["predicted"];
    if (matchId === null || !["H", "D", "A"].includes(predicted)) continue;

    log.set(matchId, {
      predicted,
      pHome: num(row.p_home_win) ?? 0,
      pDraw: num(row.p_draw) ?? 0,
      pAway: num(row.p_away_win) ?? 0,
    });
  }

  return log;
}

// --- Derived views -----------------------------------------------------------

export async function getCurrentSeason(league: string): Promise<number> {
  const matches = await getMatches(league);
  return matches.reduce((max, m) => Math.max(max, m.season), 0);
}

/** League table computed from finished matches, plus each team's recent form. */
export async function getStandings(
  league: string,
  season?: number,
): Promise<TableRow[]> {
  const matches = await getMatches(league);
  const target = season ?? (await getCurrentSeason(league));

  const played = matches.filter(
    (m) => m.status === "FINISHED" && m.season === target,
  );

  const teams = new Map<string, TableRow>();

  const ensure = (name: string): TableRow => {
    if (!teams.has(name)) {
      teams.set(name, {
        position: 0,
        team: name,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
        form: "",
      });
    }
    return teams.get(name)!;
  };

  for (const m of played) {
    if (m.homeGoals === null || m.awayGoals === null) continue;

    const home = ensure(m.homeTeam);
    const away = ensure(m.awayTeam);

    home.played++;
    away.played++;
    home.goalsFor += m.homeGoals;
    home.goalsAgainst += m.awayGoals;
    away.goalsFor += m.awayGoals;
    away.goalsAgainst += m.homeGoals;

    if (m.result === "H") {
      home.won++;
      away.lost++;
      home.points += 3;
      home.form += "W";
      away.form += "L";
    } else if (m.result === "A") {
      away.won++;
      home.lost++;
      away.points += 3;
      away.form += "W";
      home.form += "L";
    } else {
      home.drawn++;
      away.drawn++;
      home.points++;
      away.points++;
      home.form += "D";
      away.form += "D";
    }
  }

  const table = [...teams.values()].map((row) => ({
    ...row,
    goalDifference: row.goalsFor - row.goalsAgainst,
    form: row.form.slice(-5),
  }));

  table.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor ||
      a.team.localeCompare(b.team),
  );

  return table.map((row, i) => ({ ...row, position: i + 1 }));
}

/** Fixtures for the next matchday that still has unplayed games. */
export async function getNextMatchday(league: string): Promise<{
  matchday: number | null;
  fixtures: Forecast[];
}> {
  const forecasts = await getForecasts(league);
  if (forecasts.length === 0) return { matchday: null, fixtures: [] };

  const matchday = forecasts[0].matchday;
  return {
    matchday,
    fixtures: forecasts.filter((f) => f.matchday === matchday),
  };
}

/** Scores logged forecasts against results that have since come in. */
export async function getTrackRecord(league: string): Promise<{
  evaluated: number;
  correct: number;
  accuracy: number | null;
}> {
  const [matches, log] = await Promise.all([
    getMatches(league),
    getPredictionLog(league),
  ]);

  const results = new Map(
    matches
      .filter((m) => m.status === "FINISHED" && m.result !== null)
      .map((m) => [m.matchId, m.result]),
  );

  let evaluated = 0;
  let correct = 0;

  for (const [matchId, forecast] of log) {
    const actual = results.get(matchId);
    if (!actual) continue;
    evaluated++;
    if (actual === forecast.predicted) correct++;
  }

  return {
    evaluated,
    correct,
    accuracy: evaluated > 0 ? correct / evaluated : null,
  };
}

/** Summary figures for the dashboard header. */
export async function getSummary(league: string) {
  const [matches, forecasts, season] = await Promise.all([
    getMatches(league),
    getForecasts(league),
    getCurrentSeason(league),
  ]);

  const played = matches.filter((m) => m.status === "FINISHED");
  const goals = played.reduce(
    (sum, m) => sum + (m.homeGoals ?? 0) + (m.awayGoals ?? 0),
    0,
  );
  const homeWins = played.filter((m) => m.result === "H").length;

  return {
    season,
    matchesAnalysed: played.length,
    forecastsOpen: forecasts.length,
    goalsPerMatch: played.length ? goals / played.length : 0,
    homeWinRate: played.length ? homeWins / played.length : 0,
    lastUpdated: played.length ? played[played.length - 1].date : null,
  };
}

/**
 * Finished matches from the matchday currently in play, each paired with the
 * forecast that stood before it.
 *
 * Falls back to the most recently completed matchday when the current one has
 * not started yet, so the section is never empty mid-season.
 */
export async function getRecentResults(league: string): Promise<{
  matchday: number | null;
  results: ScoredResult[];
  scored: number;
  correct: number;
}> {
  const [matches, forecasts, log] = await Promise.all([
    getMatches(league),
    getForecasts(league),
    getPredictionLog(league),
  ]);

  const played = matches.filter(
    (m) =>
      m.status === "FINISHED" &&
      m.result !== null &&
      m.homeGoals !== null &&
      m.awayGoals !== null,
  );

  if (played.length === 0) {
    return { matchday: null, results: [], scored: 0, correct: 0 };
  }

  const currentSeason = Math.max(...played.map((m) => m.season));
  const seasonPlayed = played.filter((m) => m.season === currentSeason);

  const inPlay = forecasts[0]?.matchday ?? null;
  const hasResults =
    inPlay !== null && seasonPlayed.some((m) => m.matchday === inPlay);

  const matchday = hasResults
    ? inPlay
    : Math.max(...seasonPlayed.map((m) => m.matchday));

  const selected = seasonPlayed
    .filter((m) => m.matchday === matchday)
    .sort((a, b) => b.date.localeCompare(a.date));

  let scored = 0;
  let correct = 0;

  const results: ScoredResult[] = selected.map((m) => {
    const forecast = log.get(m.matchId);
    const result = m.result as "H" | "D" | "A";

    let probabilityOfActual: number | null = null;
    let hit: boolean | null = null;

    if (forecast) {
      probabilityOfActual =
        result === "H"
          ? forecast.pHome
          : result === "D"
            ? forecast.pDraw
            : forecast.pAway;
      hit = forecast.predicted === result;
      scored++;
      if (hit) correct++;
    }

    return {
      matchId: m.matchId,
      date: m.date,
      matchday: m.matchday,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeGoals: m.homeGoals as number,
      awayGoals: m.awayGoals as number,
      result,
      predicted: forecast?.predicted ?? null,
      probabilityOfActual,
      hit,
    };
  });

  return { matchday, results, scored, correct };
}

// --- Cup rounds --------------------------------------------------------------

export type Round = { stage: string | null; matchday: number | null };

const sameRound = (a: Round, b: Round) =>
  a.stage === b.stage && a.matchday === b.matchday;

/**
 * The next round of a cup.
 *
 * A league identifies a round by matchday alone. A cup cannot: every league-phase
 * fixture shares one stage and is separated by matchday, while knockout ties
 * share a stage and have no meaningful matchday. Only the pair identifies a
 * round, and using matchday alone lumps all eight league-phase rounds together.
 */
export async function getNextCupRound(league: string): Promise<{
  round: Round | null;
  fixtures: Forecast[];
}> {
  const forecasts = await getForecasts(league);
  if (forecasts.length === 0) return { round: null, fixtures: [] };

  const round: Round = {
    stage: forecasts[0].stage ?? null,
    matchday: forecasts[0].matchday || null,
  };

  return {
    round,
    fixtures: forecasts.filter((f) =>
      sameRound({ stage: f.stage ?? null, matchday: f.matchday || null }, round),
    ),
  };
}

/**
 * The most recently completed round of a cup, scored against what was forecast.
 *
 * Anchored on the latest date played rather than on the upcoming round's
 * matchday: a new season's opening fixtures would otherwise match last season's
 * first league-phase round and hide the final that came after it.
 */
export async function getRecentCupRound(league: string): Promise<{
  round: Round | null;
  results: ScoredResult[];
  scored: number;
  correct: number;
}> {
  const [matches, log] = await Promise.all([
    getMatches(league),
    getPredictionLog(league),
  ]);

  const played = matches.filter(
    (m) =>
      m.status === "FINISHED" &&
      m.result !== null &&
      m.homeGoals !== null &&
      m.awayGoals !== null,
  );

  if (played.length === 0) {
    return { round: null, results: [], scored: 0, correct: 0 };
  }

  const latest = played[played.length - 1];
  const round: Round = {
    stage: latest.stage,
    matchday: latest.matchday || null,
  };

  const selected = played
    .filter(
      (m) =>
        m.season === latest.season &&
        sameRound({ stage: m.stage, matchday: m.matchday || null }, round),
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  let scored = 0;
  let correct = 0;

  const results: ScoredResult[] = selected.map((m) => {
    const forecast = log.get(m.matchId);
    const result = m.result as "H" | "D" | "A";

    let probabilityOfActual: number | null = null;
    let hit: boolean | null = null;

    if (forecast) {
      probabilityOfActual =
        result === "H"
          ? forecast.pHome
          : result === "D"
            ? forecast.pDraw
            : forecast.pAway;
      hit = forecast.predicted === result;
      scored++;
      if (hit) correct++;
    }

    return {
      matchId: m.matchId,
      date: m.date,
      matchday: m.matchday,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeGoals: m.homeGoals as number,
      awayGoals: m.awayGoals as number,
      result,
      predicted: forecast?.predicted ?? null,
      probabilityOfActual,
      hit,
    };
  });

  return { round, results, scored, correct };
}

/** Human-readable name for a cup round. */
export function roundLabel(round: Round | null): string {
  if (!round) return "Next fixtures";

  const stages: Record<string, string> = {
    LEAGUE_STAGE: "League phase",
    GROUP_STAGE: "Group stage",
    PLAYOFFS: "Play-offs",
    LAST_16: "Round of 16",
    QUARTER_FINALS: "Quarter-finals",
    SEMI_FINALS: "Semi-finals",
    FINAL: "Final",
    THIRD_PLACE: "Third place",
  };

  const stage = round.stage
    ? (stages[round.stage] ?? round.stage.replace(/_/g, " ").toLowerCase())
    : "Fixtures";

  // Matchday only disambiguates within a phase that has several.
  const numbered = round.stage === "LEAGUE_STAGE" || round.stage === "GROUP_STAGE";
  return numbered && round.matchday
    ? `${stage}, matchday ${round.matchday}`
    : stage;
}

// --- Fixture appeal ----------------------------------------------------------

async function getFinalPositions(
  league: string,
): Promise<Map<number, Map<string, number>>> {
  const matches = await getMatches(league);
  const seasons = [...new Set(matches.map((m) => m.season))].sort();
  const result = new Map<number, Map<string, number>>();

  for (const season of seasons) {
    const played = matches.filter(
      (m) => m.season === season && m.status === "FINISHED",
    );
    // A season counts as complete once most of it is played. 18-team divisions
    // play 306 matches, so the threshold has to sit below that.
    if (played.length < 280) continue;

    const table = await getStandings(league, season);
    result.set(season, new Map(table.map((row) => [row.team, row.position])));
  }

  return result;
}

/**
 * How big a club is, on a 0-1 scale where 1 is a title contender.
 *
 * Blends where a team sits now with where it has finished in previous seasons.
 * The current season is weighted by how much of it has been played: after three
 * matchdays the table is mostly noise, so history carries the estimate until
 * enough games have accumulated to trust it.
 */
async function getTeamStature(league: string): Promise<Map<string, number>> {
  const [current, history] = await Promise.all([
    getStandings(league),
    getFinalPositions(league),
  ]);

  const toScore = (position: number, size: number) =>
    size <= 1 ? 0.5 : 1 - (position - 1) / (size - 1);

  const matchesPlayed = current.length
    ? Math.max(...current.map((r) => r.played))
    : 0;
  const currentWeight = Math.min(matchesPlayed / 10, 1) * 0.5;

  const currentScores = new Map(
    current.map((row) => [row.team, toScore(row.position, current.length)]),
  );

  const stature = new Map<string, number>();
  const teams = new Set([
    ...currentScores.keys(),
    ...[...history.values()].flatMap((m) => [...m.keys()]),
  ]);

  for (const team of teams) {
    const past: number[] = [];

    for (const table of history.values()) {
      const position = table.get(team);
      past.push(position !== undefined ? toScore(position, table.size) : 0.05);
    }

    const historyScore =
      past.length > 0 ? past.reduce((a, b) => a + b, 0) / past.length : 0.5;
    const currentScore = currentScores.get(team) ?? historyScore;

    stature.set(
      team,
      currentWeight * currentScore + (1 - currentWeight) * historyScore,
    );
  }

  return stature;
}

/**
 * Pick the most appealing fixture from a set.
 *
 * Two things make a match worth watching: both sides being good, and the two
 * being closely matched. A first-versus-last game scores badly on the second
 * even though it scores well on the first, which is the intended behaviour —
 * the point is to surface a genuine contest, not a likely thrashing.
 */
export async function getFeaturedFixture(
  league: string,
  fixtures: Forecast[],
): Promise<Forecast | null> {
  if (fixtures.length === 0) return null;

  const stature = await getTeamStature(league);
  const fallback = 0.3;

  let best = fixtures[0];
  let bestScore = -Infinity;

  for (const fixture of fixtures) {
    const home = stature.get(fixture.homeTeam) ?? fallback;
    const away = stature.get(fixture.awayTeam) ?? fallback;

    const score = 0.65 * ((home + away) / 2) + 0.35 * (1 - Math.abs(home - away));

    if (score > bestScore) {
      bestScore = score;
      best = fixture;
    }
  }

  return best;
}

/**
 * Where the table and the model disagree.
 *
 * League position reflects what happened; the model's rating reflects a squad's
 * accumulated strength across four seasons. A side sitting 17th with a top-half
 * rating is historically better than its points suggest and a reasonable bet to
 * climb — that disagreement is the most forward-looking thing the model
 * produces, and it is invisible in a standings table.
 */
export async function getPerformanceGaps(
  league: string,
  limit = 6,
): Promise<PerformanceGap[]> {
  const [standings, ratings] = await Promise.all([
    getStandings(league),
    getTeamRatings(league),
  ]);

  if (standings.length === 0 || ratings.length === 0) return [];

  const active = new Set(standings.map((row) => row.team));

  const modelRank = new Map(
    ratings
      .filter((r) => active.has(r.team))
      .sort((a, b) => b.overall - a.overall)
      .map((r, i) => [r.team, i + 1]),
  );

  const gaps: PerformanceGap[] = [];

  for (const row of standings) {
    const rank = modelRank.get(row.team);
    if (rank === undefined) continue;

    gaps.push({
      team: row.team,
      tablePosition: row.position,
      modelRank: rank,
      gap: row.position - rank,
      points: row.points,
      played: row.played,
    });
  }

  return gaps
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, limit)
    .sort((a, b) => b.gap - a.gap);
}

// --- Display helpers ---------------------------------------------------------

/**
 * Strip club suffixes, prefixes and founding years so long names fit.
 *
 * Order matters: years come off before suffixes, or "Bologna FC 1909" loses the
 * year and keeps the FC.
 */
export function shortName(team: string): string {
  return team
    // Founding years and the numbers clubs carry in their legal names.
    .replace(/\s+(1[89]\d{2}|0[0-9])$/, "")
    // Leading ordinals, as in "1. FC Heidenheim".
    .replace(/^\d+\.\s+/, "")
    // Trailing club-type suffixes.
    .replace(
      /\s+(FC|CF|AC|SC|BC|SS|AS|US|UD|SD|CD|CA|RC|SV|VfL|VfB|TSG|FSV|AFC|Calcio|Fussball-Club)$/,
      "",
    )
    // Leading ones.
    .replace(
      /^(FC|CF|AC|SC|AS|SS|US|AFC|RC|CA|CD|SD|SV|VfL|VfB|TSG|FSV|OGC|RCD|ACF|SSC|CFC)\s+/,
      "",
    )
    .replace(" & Hove Albion", "")
    .replace(" Hotspur", "")
    .replace(" Wanderers", "")
    .replace(" Milano", "")
    .replace(" de Madrid", "")
    .replace("Olympique de ", "")
    .replace(" Alsace", "")
    .replace(" United", " Utd")
    .trim();
}