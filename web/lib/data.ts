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

/** Scores stored forecasts against results that have since come in. */
export async function getTrackRecord(): Promise<{
  evaluated: number;
  correct: number;
  accuracy: number | null;
}> {
  const [matches, forecasts] = await Promise.all([getMatches(), getForecasts()]);

  const results = new Map(
    matches
      .filter((m) => m.status === "FINISHED" && m.result !== null)
      .map((m) => [m.matchId, m.result]),
  );

  let evaluated = 0;
  let correct = 0;

  for (const f of forecasts) {
    const actual = results.get(f.matchId);
    if (!actual) continue;
    evaluated++;
    if (actual === f.prediction) correct++;
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
