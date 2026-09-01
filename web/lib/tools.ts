/**
 * Agent tools.
 *
 * The web counterpart of src/agent/tools.py. These are the only way the model
 * can obtain facts — it cannot recall a standing or invent a forecast, it has
 * to ask the data.
 *
 * Every tool takes an optional league. The page the visitor is on supplies a
 * default, so "who is top of the table?" works without them naming a
 * competition, while "how is Bayern doing?" can cross over on its own.
 */

import {
  getForecasts,
  getMatches,
  getModelParams,
  getStandings,
  getTeamRatings,
  getTrackRecord,
  type Match,
} from "./data";
import { LEAGUES, resolveLeague, type League } from "./leagues";

type ToolResult = Record<string, unknown>;

// --- League and team resolution ----------------------------------------------

const ALIASES: Record<string, string> = {
  // England
  spurs: "Tottenham Hotspur FC",
  "man city": "Manchester City FC",
  "man utd": "Manchester United FC",
  "man united": "Manchester United FC",
  wolves: "Wolverhampton Wanderers FC",
  brighton: "Brighton & Hove Albion FC",
  forest: "Nottingham Forest FC",
  palace: "Crystal Palace FC",
  villa: "Aston Villa FC",
  gunners: "Arsenal FC",
  // Spain
  barca: "FC Barcelona",
  barça: "FC Barcelona",
  atleti: "Club Atlético de Madrid",
  atletico: "Club Atlético de Madrid",
  madrid: "Real Madrid CF",
  // Italy
  inter: "FC Internazionale Milano",
  juve: "Juventus FC",
  milan: "AC Milan",
  // Germany
  bayern: "FC Bayern München",
  dortmund: "Borussia Dortmund",
  bvb: "Borussia Dortmund",
  gladbach: "Borussia Mönchengladbach",
  // France
  psg: "Paris Saint-Germain FC",
  om: "Olympique de Marseille",
  ol: "Olympique Lyonnais",
};

/** Levenshtein distance, used only as a last resort for typos. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }

  return prev[b.length];
}

async function teamsIn(slug: string): Promise<string[]> {
  const matches = await getMatches(slug);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m.homeTeam);
    names.add(m.awayTeam);
  }
  return [...names].sort();
}

/**
 * Find a team, searching the current league first and then the others.
 *
 * Searching beyond the current league is deliberate: someone reading the LaLiga
 * page may still ask about Bayern, and answering is better than a not-found.
 */
async function findTeam(
  input: string,
  preferred: string,
): Promise<{ team: string; league: string } | null> {
  const query = input.trim().toLowerCase();
  if (!query) return null;

  const order = [preferred, ...LEAGUES.map((l) => l.slug).filter((s) => s !== preferred)];

  const alias = ALIASES[query];

  for (const pass of ["exact", "alias", "partial"] as const) {
    for (const slug of order) {
      const teams = await teamsIn(slug);

      if (pass === "exact") {
        const hit = teams.find((t) => t.toLowerCase() === query);
        if (hit) return { team: hit, league: slug };
      }

      if (pass === "alias" && alias) {
        const hit = teams.find((t) => t === alias);
        if (hit) return { team: hit, league: slug };
      }

      if (pass === "partial") {
        const hits = teams.filter((t) => t.toLowerCase().includes(query));
        if (hits.length === 1) return { team: hits[0], league: slug };
      }
    }
  }

  // Fuzzy fallback, current league only — matching a typo across five leagues
  // produces more confusion than help.
  const teams = await teamsIn(preferred);
  let best: string | null = null;
  let bestScore = Infinity;

  for (const team of teams) {
    const score = distance(query, team.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = team;
    }
  }

  return best && bestScore <= Math.max(3, query.length * 0.4)
    ? { team: best, league: preferred }
    : null;
}

function leagueName(slug: string): string {
  return LEAGUES.find((l) => l.slug === slug)?.name ?? slug;
}

/** The league a tool should act on: the one named, else the page's. */
function targetLeague(named: string | undefined, fallback: string): League | null {
  if (!named) return LEAGUES.find((l) => l.slug === fallback) ?? null;
  return resolveLeague(named);
}

async function teamNotFound(name: string, slug: string): Promise<ToolResult> {
  return {
    error: `Team '${name}' not found in any covered league.`,
    searched: LEAGUES.map((l) => l.name),
    teams_in_current_league: await teamsIn(slug),
  };
}

function leagueNotFound(name: string): ToolResult {
  return {
    error: `League '${name}' is not covered.`,
    available_leagues: LEAGUES.map((l) => l.name),
  };
}

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

// --- Tools -------------------------------------------------------------------

async function getStandingsTool(
  args: { league?: string; season?: number },
  context: string,
): Promise<ToolResult> {
  const league = targetLeague(args.league, context);
  if (!league) return leagueNotFound(args.league!);

  const table = await getStandings(league.slug, args.season);
  if (table.length === 0) return { error: `No finished matches for ${league.name}.` };

  return {
    league: league.name,
    matches_played: table.reduce((sum, r) => sum + r.played, 0) / 2,
    table: table.map((r) => ({
      position: r.position,
      team: r.team,
      played: r.played,
      won: r.won,
      drawn: r.drawn,
      lost: r.lost,
      goal_difference: r.goalDifference,
      points: r.points,
      form: r.form,
    })),
  };
}

async function getTeamFormTool(
  args: { team: string; last_n?: number },
  context: string,
): Promise<ToolResult> {
  const found = await findTeam(args.team, context);
  if (!found) return teamNotFound(args.team, context);

  const lastN = clamp(args.last_n, 5, 1, 20);
  const matches = await getMatches(found.league);

  const played = matches
    .filter(
      (m: Match) =>
        m.status === "FINISHED" &&
        (m.homeTeam === found.team || m.awayTeam === found.team),
    )
    .slice(-lastN)
    .reverse();

  if (played.length === 0) return { error: `No finished matches for ${found.team}.` };

  let points = 0;
  let scored = 0;
  let conceded = 0;

  const history = played.map((m) => {
    const isHome = m.homeTeam === found.team;
    const forGoals = (isHome ? m.homeGoals : m.awayGoals) ?? 0;
    const againstGoals = (isHome ? m.awayGoals : m.homeGoals) ?? 0;

    scored += forGoals;
    conceded += againstGoals;

    const outcome =
      forGoals > againstGoals ? "W" : forGoals === againstGoals ? "D" : "L";
    points += outcome === "W" ? 3 : outcome === "D" ? 1 : 0;

    return {
      date: m.date,
      opponent: isHome ? m.awayTeam : m.homeTeam,
      venue: isHome ? "home" : "away",
      score: `${forGoals}-${againstGoals}`,
      outcome,
    };
  });

  return {
    team: found.team,
    league: leagueName(found.league),
    matches_analysed: history.length,
    form_string: history.map((h) => h.outcome).join(""),
    points_taken: points,
    points_available: history.length * 3,
    goals_scored: scored,
    goals_conceded: conceded,
    matches: history,
  };
}

async function getMatchPredictionTool(
  args: { home_team: string; away_team: string },
  context: string,
): Promise<ToolResult> {
  const home = await findTeam(args.home_team, context);
  if (!home) return teamNotFound(args.home_team, context);
  const away = await findTeam(args.away_team, context);
  if (!away) return teamNotFound(args.away_team, context);

  if (home.league !== away.league) {
    return {
      error: `${home.team} and ${away.team} play in different leagues.`,
      note: "Only domestic fixtures are modelled. Cross-league matches would need European results to calibrate against, which this dataset does not include.",
    };
  }

  const forecasts = await getForecasts(home.league);
  const match = forecasts.find(
    (f) => f.homeTeam === home.team && f.awayTeam === away.team,
  );

  if (!match) {
    return {
      error: `No upcoming fixture found for ${home.team} vs ${away.team}.`,
      hint: "It may already have been played, or may not be scheduled.",
    };
  }

  return {
    league: leagueName(home.league),
    fixture: `${home.team} vs ${away.team}`,
    date: match.date,
    matchday: match.matchday,
    expected_goals: { home: match.xgHome, away: match.xgAway },
    probabilities: {
      home_win: match.pHome,
      draw: match.pDraw,
      away_win: match.pAway,
    },
    most_likely_score: match.likelyScore,
    model_pick: { H: "home win", D: "draw", A: "away win" }[match.prediction],
    confidence: match.confidence,
  };
}

async function getUpcomingFixturesTool(
  args: { team?: string; league?: string; limit?: number },
  context: string,
): Promise<ToolResult> {
  const limit = clamp(args.limit, 10, 1, 20);

  let slug = context;
  let teamName: string | null = null;

  if (args.team) {
    const found = await findTeam(args.team, context);
    if (!found) return teamNotFound(args.team, context);
    slug = found.league;
    teamName = found.team;
  } else if (args.league) {
    const league = resolveLeague(args.league);
    if (!league) return leagueNotFound(args.league);
    slug = league.slug;
  }

  let forecasts = await getForecasts(slug);
  if (teamName) {
    forecasts = forecasts.filter(
      (f) => f.homeTeam === teamName || f.awayTeam === teamName,
    );
  }

  if (forecasts.length === 0) return { error: "No upcoming fixtures found." };

  return {
    league: leagueName(slug),
    team_filter: teamName,
    count: Math.min(forecasts.length, limit),
    fixtures: forecasts.slice(0, limit).map((f) => ({
      date: f.date,
      matchday: f.matchday,
      fixture: `${f.homeTeam} vs ${f.awayTeam}`,
      probabilities: {
        home_win: f.pHome,
        draw: f.pDraw,
        away_win: f.pAway,
      },
      most_likely_score: f.likelyScore,
    })),
  };
}

async function getTeamRatingsTool(
  args: { league?: string; top_n?: number },
  context: string,
): Promise<ToolResult> {
  const league = targetLeague(args.league, context);
  if (!league) return leagueNotFound(args.league!);

  const ratings = await getTeamRatings(league.slug);
  if (ratings.length === 0) return { error: `No ratings for ${league.name}.` };

  const topN = clamp(args.top_n, 20, 1, 30);

  return {
    league: league.name,
    explanation:
      "Attack and defense parameters from the Dixon-Coles model. Log scale, 0 is league average. Only comparable within this league — a rating in one competition says nothing about another.",
    teams: ratings.slice(0, topN).map((r, i) => ({
      rank: i + 1,
      team: r.team,
      attack: Number(r.attack.toFixed(3)),
      defense: Number(r.defense.toFixed(3)),
      overall: Number(r.overall.toFixed(3)),
      matches_behind_rating: r.matches,
    })),
  };
}

async function getHeadToHeadTool(
  args: { team_a: string; team_b: string; limit?: number },
  context: string,
): Promise<ToolResult> {
  const a = await findTeam(args.team_a, context);
  if (!a) return teamNotFound(args.team_a, context);
  const b = await findTeam(args.team_b, context);
  if (!b) return teamNotFound(args.team_b, context);

  if (a.league !== b.league) {
    return {
      error: `${a.team} and ${b.team} play in different leagues.`,
      note: "Only domestic fixtures are in the dataset, so they have no recorded meetings here.",
    };
  }

  const limit = clamp(args.limit, 10, 1, 20);
  const matches = await getMatches(a.league);

  const meetings = matches
    .filter(
      (m) =>
        m.status === "FINISHED" &&
        ((m.homeTeam === a.team && m.awayTeam === b.team) ||
          (m.homeTeam === b.team && m.awayTeam === a.team)),
    )
    .slice(-limit)
    .reverse();

  if (meetings.length === 0) {
    return { error: `No recorded meetings between ${a.team} and ${b.team}.` };
  }

  let aWins = 0;
  let bWins = 0;
  let draws = 0;

  const results = meetings.map((m) => {
    let winner: string;
    if (m.result === "D") {
      draws++;
      winner = "draw";
    } else {
      winner = m.result === "H" ? m.homeTeam : m.awayTeam;
      if (winner === a.team) aWins++;
      else bWins++;
    }
    return {
      date: m.date,
      fixture: `${m.homeTeam} vs ${m.awayTeam}`,
      score: `${m.homeGoals}-${m.awayGoals}`,
      winner,
    };
  });

  return {
    league: leagueName(a.league),
    teams: [a.team, b.team],
    meetings_analysed: results.length,
    summary: { [`${a.team} wins`]: aWins, draws, [`${b.team} wins`]: bWins },
    matches: results,
  };
}

async function evaluateModelAccuracyTool(
  args: { league?: string },
  context: string,
): Promise<ToolResult> {
  // With no league named, report every one — "how accurate is the model?" is
  // usually a question about the whole system.
  const slugs = args.league
    ? [resolveLeague(args.league)?.slug]
    : LEAGUES.map((l) => l.slug);

  if (slugs[0] === undefined) return leagueNotFound(args.league!);

  const rows = [];
  let totalEvaluated = 0;
  let totalCorrect = 0;

  for (const slug of slugs as string[]) {
    const track = await getTrackRecord(slug);
    totalEvaluated += track.evaluated;
    totalCorrect += track.correct;

    rows.push({
      league: leagueName(slug),
      matches_evaluated: track.evaluated,
      correct: track.correct,
      accuracy: track.accuracy,
    });
  }

  if (totalEvaluated === 0) {
    return {
      status: "no_data",
      message:
        "No logged forecasts have been played yet. The live track record builds up as the season progresses. Historical evaluation on held-out seasons is reported on the page instead.",
      current_league: leagueName(context),
    };
  }

  return {
    by_league: rows,
    overall: {
      matches_evaluated: totalEvaluated,
      correct: totalCorrect,
      accuracy: totalCorrect / totalEvaluated,
    },
    note: "Accuracy on a small sample is noisy. Interpret with care until several matchweeks have accumulated.",
  };
}

async function compareLeaguesTool(): Promise<ToolResult> {
  const rows = [];

  for (const league of LEAGUES) {
    const params = await getModelParams(league.slug);
    if (!params) continue;

    rows.push({
      league: league.name,
      country: league.country,
      home_advantage: params.homeAdvantage,
      home_win_rate: params.homeWinRate,
      draw_rate: params.drawRate,
      away_win_rate: params.awayWinRate,
      goals_per_match: params.goalsPerMatch,
      rho: params.rho,
      teams: params.teams,
      matches_fitted: params.matchesFitted,
    });
  }

  if (rows.length === 0) return { error: "No fitted models available." };

  const byHome = [...rows].sort((a, b) => b.home_advantage - a.home_advantage);
  const byGoals = [...rows].sort((a, b) => b.goals_per_match - a.goals_per_match);

  return {
    leagues: rows,
    highlights: {
      strongest_home_advantage: byHome[0].league,
      weakest_home_advantage: byHome[byHome.length - 1].league,
      most_goals: byGoals[0].league,
      fewest_goals: byGoals[byGoals.length - 1].league,
    },
    notes: [
      "home_advantage is the multiplier on a team's goal rate when playing at home. It describes the competition rather than any squad, so comparing it across leagues is valid.",
      "rho is the Dixon-Coles correction for low-scoring matches. Dixon and Coles (1997) found it positive in English data; a negative value points the other way.",
      "Team attack and defense ratings are NOT comparable across leagues and are not included here.",
    ],
  };
}

// --- Registry and schemas ----------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const REGISTRY: Record<
  string,
  (args: any, context: string) => Promise<ToolResult>
> = {
  get_standings: getStandingsTool,
  get_team_form: getTeamFormTool,
  get_match_prediction: getMatchPredictionTool,
  get_upcoming_fixtures: getUpcomingFixturesTool,
  get_team_ratings: getTeamRatingsTool,
  get_head_to_head: getHeadToHeadTool,
  evaluate_model_accuracy: evaluateModelAccuracyTool,
  compare_leagues: compareLeaguesTool,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const LEAGUE_PARAM = {
  type: "string",
  description:
    "Which league. Accepts a name or country: Premier League, LaLiga, Serie A, Bundesliga, Ligue 1. Omit to use the one the user is currently viewing.",
};

export const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    name: "get_standings",
    description:
      "Get the league table for a competition, computed from finished matches. Use for questions about positions, points, or who is top.",
    parameters: {
      type: "object",
      properties: {
        league: LEAGUE_PARAM,
        season: {
          type: "integer",
          description: "Season start year, e.g. 2025 for 2025/26. Omit for current.",
        },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_team_form",
    description:
      "Get a team's recent results and form. Searches every covered league, so the team need not be in the one being viewed.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team name." },
        last_n: {
          type: "integer",
          description: "Number of recent matches (default 5, max 20).",
        },
      },
      required: ["team"],
    },
  },
  {
    type: "function" as const,
    name: "get_match_prediction",
    description:
      "Get the model's probabilistic forecast for a specific upcoming fixture, including win/draw/loss probabilities and expected goals. Both teams must be in the same league.",
    parameters: {
      type: "object",
      properties: {
        home_team: { type: "string", description: "Home team." },
        away_team: { type: "string", description: "Away team." },
      },
      required: ["home_team", "away_team"],
    },
  },
  {
    type: "function" as const,
    name: "get_upcoming_fixtures",
    description:
      "List scheduled fixtures with their forecasts, optionally filtered to one team or league.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Optional team filter." },
        league: LEAGUE_PARAM,
        limit: { type: "integer", description: "Max fixtures (default 10)." },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_team_ratings",
    description:
      "Get model-estimated attack and defense strength for a league's teams. Ratings are only comparable within a league, never across them.",
    parameters: {
      type: "object",
      properties: {
        league: LEAGUE_PARAM,
        top_n: { type: "integer", description: "How many teams (default 20)." },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_head_to_head",
    description:
      "Get historical results between two teams. They must play in the same league.",
    parameters: {
      type: "object",
      properties: {
        team_a: { type: "string", description: "First team." },
        team_b: { type: "string", description: "Second team." },
        limit: { type: "integer", description: "Max meetings (default 10)." },
      },
      required: ["team_a", "team_b"],
    },
  },
  {
    type: "function" as const,
    name: "compare_leagues",
    description:
      "Compare the five leagues against each other: home advantage, goals per match, outcome rates, and fitted model parameters. Use for any question that spans competitions — which league has the strongest home advantage, which is highest scoring, where draws are most common. Takes no arguments and always covers all five.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function" as const,
    name: "evaluate_model_accuracy",
    description:
      "Check how the model's logged forecasts performed against real results. Reports every league unless one is named.",
    parameters: {
      type: "object",
      properties: { league: LEAGUE_PARAM },
    },
  },
];

/** Dispatch a tool call, turning any failure into something the model can read. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: string,
): Promise<ToolResult> {
  const tool = REGISTRY[name];
  if (!tool) return { error: `Unknown tool: ${name}` };

  try {
    return await tool(args ?? {}, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Tool ${name} failed: ${message}` };
  }
}
