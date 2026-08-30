/**
 * Data access for PitchIQ.
 *
 * Reads the CSVs produced by the Python pipeline. Everything here runs on the
 * server at build/request time, so the browser never downloads the raw data.
 *
 * The CSVs are the contract between the Python side and the web app: Python
 * trains and forecasts offline, TypeScript only reads the artifacts. That
 * keeps the deployment a plain static Next.js app with no Python runtime.
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
  season: number;
  matchday: number;
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
};

export type TeamRating = {
  team: string;
  attack: number;
  defense: number;
  overall: number;
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

let matchCache: Match[] | null = null;

export async function getMatches(): Promise<Match[]> {
  if (matchCache) return matchCache;
  if (!existsSync(PROCESSED)) return [];

  const files = (await readdir(PROCESSED)).filter(
    (f) => f.startsWith("pl_matches_") && f.endsWith(".csv"),
  );

  const all: Match[] = [];

  for (const file of files) {
    const text = await readFile(path.join(PROCESSED, file), "utf8");

    for (const r of parseCsv(text)) {
      const result = r.result as Match["result"];
      all.push({
        matchId: num(r.match_id) ?? 0,
        season: num(r.season) ?? 0,
        matchday: num(r.matchday) ?? 0,
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
  matchCache = all;
  return all;
}

export async function getForecasts(): Promise<Forecast[]> {
  const file = path.join(PREDICTIONS, "upcoming_forecasts.csv");
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
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getTeamRatings(): Promise<TeamRating[]> {
  const file = path.join(PREDICTIONS, "team_ratings.csv");
  if (!existsSync(file)) return [];

  const text = await readFile(file, "utf8");

  return parseCsv(text)
    .map((r) => ({
      team: r.team ?? "",
      attack: num(r.attack) ?? 0,
      defense: num(r.defense) ?? 0,
      overall: num(r.overall) ?? 0,
    }))
    .sort((a, b) => b.overall - a.overall);
}

// --- Derived views -----------------------------------------------------------

export async function getCurrentSeason(): Promise<number> {
  const matches = await getMatches();
  return matches.reduce((max, m) => Math.max(max, m.season), 0);
}

/** League table computed from finished matches, plus each team's recent form. */
export async function getStandings(season?: number): Promise<TableRow[]> {
  const matches = await getMatches();
  const target = season ?? (await getCurrentSeason());

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
export async function getNextMatchday(): Promise<{
  matchday: number | null;
  fixtures: Forecast[];
}> {
  const forecasts = await getForecasts();
  if (forecasts.length === 0) return { matchday: null, fixtures: [] };

  const matchday = forecasts[0].matchday;
  return {
    matchday,
    fixtures: forecasts.filter((f) => f.matchday === matchday),
  };
}

/** Scores logged forecasts against results that have since come in. */
export async function getTrackRecord(): Promise<{
  evaluated: number;
  correct: number;
  accuracy: number | null;
}> {
  const empty = { evaluated: 0, correct: 0, accuracy: null };

  const file = path.join(PREDICTIONS, "prediction_log.csv");
  if (!existsSync(file)) return empty;

  const [text, matches] = await Promise.all([
    readFile(file, "utf8"),
    getMatches(),
  ]);

  const results = new Map(
    matches
      .filter((m) => m.status === "FINISHED" && m.result !== null)
      .map((m) => [m.matchId, m.result]),
  );

  let evaluated = 0;
  let correct = 0;

  for (const row of parseCsv(text)) {
    const matchId = num(row.match_id);
    if (matchId === null) continue;

    const actual = results.get(matchId);
    if (!actual) continue;

    evaluated++;
    if (actual === row.prediction) correct++;
  }

  return {
    evaluated,
    correct,
    accuracy: evaluated > 0 ? correct / evaluated : null,
  };
}

/** Summary figures for the dashboard header. */
export async function getSummary() {
  const [matches, forecasts, season] = await Promise.all([
    getMatches(),
    getForecasts(),
    getCurrentSeason(),
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

/** Strip the club suffix so long names fit in the layout. */
export function shortName(team: string): string {
  return team
    .replace(/\s+FC$/, "")
    .replace(/^AFC\s+/, "")
    .replace(/\s+AFC$/, "")
    .replace(" & Hove Albion", "")
    .replace(" Hotspur", "")
    .replace(" Wanderers", "")
    .replace(" United", " Utd");
}
// --- Fixture appeal ----------------------------------------------------------

/**
 * Final league position for every team in every completed season.
 *
 * A season counts as complete at 300+ matches, which excludes the season in
 * progress without hardcoding a date.
 */
async function getFinalPositions(): Promise<Map<number, Map<string, number>>> {
  const matches = await getMatches();
  const seasons = [...new Set(matches.map((m) => m.season))].sort();
  const result = new Map<number, Map<string, number>>();

  for (const season of seasons) {
    const played = matches.filter(
      (m) => m.season === season && m.status === "FINISHED",
    );
    if (played.length < 300) continue;

    const table = await getStandings(season);
    result.set(season, new Map(table.map((row) => [row.team, row.position])));
  }

  return result;
}

/**
 * How big a club is, on a 0–1 scale where 1 is a title contender.
 *
 * Blends where a team sits now with where it has finished in previous seasons.
 * The current season is weighted by how much of it has been played: after three
 * matchdays the table is mostly noise, so history carries the estimate until
 * enough games have accumulated to trust it.
 */
async function getTeamStature(): Promise<Map<string, number>> {
  const [current, history] = await Promise.all([
    getStandings(),
    getFinalPositions(),
  ]);

  // Position 1 → 1.0, position 20 → 0.0. Teams absent from a season (promoted
  // or relegated) score just below the bottom of that table rather than being
  // dropped, so their absence counts as weakness rather than as no data.
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
      past.push(
        position !== undefined
          ? toScore(position, table.size)
          : 0.05, // absent from the division that season
      );
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
  fixtures: Forecast[],
): Promise<Forecast | null> {
  if (fixtures.length === 0) return null;

  const stature = await getTeamStature();
  const fallback = 0.3; // a team with no record at all

  let best = fixtures[0];
  let bestScore = -Infinity;

  for (const fixture of fixtures) {
    const home = stature.get(fixture.homeTeam) ?? fallback;
    const away = stature.get(fixture.awayTeam) ?? fallback;

    const quality = (home + away) / 2;
    const balance = 1 - Math.abs(home - away);

    const score = 0.65 * quality + 0.35 * balance;

    if (score > bestScore) {
      bestScore = score;
      best = fixture;
    }
  }

  return best;
}