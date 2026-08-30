/**
 * Agent tools.
 *
 * The web counterpart of src/agent/tools.py. These are the only way the model
 * can obtain facts — it cannot recall a standing or invent a forecast, it has
 * to ask the data.
 *
 * Most of the work is already done by lib/data.ts; this layer adds team-name
 * resolution, argument shaping, and the schema the model sees.
 */

import {
  getForecasts,
  getMatches,
  getStandings,
  getTeamRatings,
  getTrackRecord,
  type Match,
} from "./data";

type ToolResult = Record<string, unknown>;

// --- Team name resolution ----------------------------------------------------

const ALIASES: Record<string, string> = {
  spurs: "Tottenham Hotspur FC",
  "man city": "Manchester City FC",
  "man utd": "Manchester United FC",
  "man united": "Manchester United FC",
  united: "Manchester United FC",
  city: "Manchester City FC",
  wolves: "Wolverhampton Wanderers FC",
  brighton: "Brighton & Hove Albion FC",
  forest: "Nottingham Forest FC",
  palace: "Crystal Palace FC",
  villa: "Aston Villa FC",
  hammers: "West Ham United FC",
  gunners: "Arsenal FC",
  reds: "Liverpool FC",
  blues: "Chelsea FC",
  toffees: "Everton FC",
  cherries: "AFC Bournemouth",
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

async function allTeams(): Promise<string[]> {
  const matches = await getMatches();
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m.homeTeam);
    names.add(m.awayTeam);
  }
  return [...names].sort();
}

/**
 * Map a loosely typed name onto the canonical one. People write "Arsenal",
 * "man city" or "Chelse" — handling that here rather than in the prompt means
 * it works identically no matter which model is driving.
 */
async function resolveTeam(input: string): Promise<string | null> {
  const teams = await allTeams();
  const query = input.trim().toLowerCase();
  if (!query) return null;

  const exact = teams.find((t) => t.toLowerCase() === query);
  if (exact) return exact;

  const partial = teams.filter((t) => t.toLowerCase().includes(query));
  if (partial.length === 1) return partial[0];

  const alias = ALIASES[query];
  if (alias && teams.includes(alias)) return alias;

  let best: string | null = null;
  let bestScore = Infinity;
  for (const team of teams) {
    const score = distance(query, team.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = team;
    }
  }

  return bestScore <= Math.max(3, query.length * 0.4) ? best : null;
}

async function notFound(name: string): Promise<ToolResult> {
  return { error: `Team '${name}' not found.`, available_teams: await allTeams() };
}

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

// --- Tools -------------------------------------------------------------------

async function getStandingsTool(args: { season?: number }): Promise<ToolResult> {
  const table = await getStandings(args.season);
  if (table.length === 0) return { error: "No finished matches for that season." };

  return {
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

async function getTeamFormTool(args: {
  team: string;
  last_n?: number;
}): Promise<ToolResult> {
  const team = await resolveTeam(args.team);
  if (!team) return notFound(args.team);

  const lastN = clamp(args.last_n, 5, 1, 20);
  const matches = await getMatches();

  const played = matches
    .filter(
      (m: Match) =>
        m.status === "FINISHED" && (m.homeTeam === team || m.awayTeam === team),
    )
    .slice(-lastN)
    .reverse();

  if (played.length === 0) return { error: `No finished matches for ${team}.` };

  let points = 0;
  let scored = 0;
  let conceded = 0;

  const history = played.map((m) => {
    const isHome = m.homeTeam === team;
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
    team,
    matches_analysed: history.length,
    form_string: history.map((h) => h.outcome).join(""),
    points_taken: points,
    points_available: history.length * 3,
    goals_scored: scored,
    goals_conceded: conceded,
    matches: history,
  };
}

async function getMatchPredictionTool(args: {
  home_team: string;
  away_team: string;
}): Promise<ToolResult> {
  const home = await resolveTeam(args.home_team);
  if (!home) return notFound(args.home_team);
  const away = await resolveTeam(args.away_team);
  if (!away) return notFound(args.away_team);

  const forecasts = await getForecasts();
  const match = forecasts.find(
    (f) => f.homeTeam === home && f.awayTeam === away,
  );

  if (!match) {
    return {
      error: `No upcoming fixture found for ${home} vs ${away}.`,
      hint: "It may already have been played, or may not be scheduled.",
    };
  }

  return {
    fixture: `${home} vs ${away}`,
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

async function getUpcomingFixturesTool(args: {
  team?: string;
  limit?: number;
}): Promise<ToolResult> {
  const limit = clamp(args.limit, 10, 1, 20);
  let forecasts = await getForecasts();
  let resolved: string | null = null;

  if (args.team) {
    resolved = await resolveTeam(args.team);
    if (!resolved) return notFound(args.team);
    forecasts = forecasts.filter(
      (f) => f.homeTeam === resolved || f.awayTeam === resolved,
    );
  }

  if (forecasts.length === 0) return { error: "No upcoming fixtures found." };

  return {
    team_filter: resolved,
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

async function getTeamRatingsTool(args: { top_n?: number }): Promise<ToolResult> {
  const ratings = await getTeamRatings();
  if (ratings.length === 0) return { error: "No ratings available." };

  const topN = clamp(args.top_n, 20, 1, 30);

  return {
    explanation:
      "Attack and defense parameters from the Dixon-Coles model. Log scale, 0 is league average.",
    teams: ratings.slice(0, topN).map((r, i) => ({
      rank: i + 1,
      team: r.team,
      attack: Number(r.attack.toFixed(3)),
      defense: Number(r.defense.toFixed(3)),
      overall: Number(r.overall.toFixed(3)),
    })),
  };
}

async function getHeadToHeadTool(args: {
  team_a: string;
  team_b: string;
  limit?: number;
}): Promise<ToolResult> {
  const a = await resolveTeam(args.team_a);
  if (!a) return notFound(args.team_a);
  const b = await resolveTeam(args.team_b);
  if (!b) return notFound(args.team_b);

  const limit = clamp(args.limit, 10, 1, 20);
  const matches = await getMatches();

  const meetings = matches
    .filter(
      (m) =>
        m.status === "FINISHED" &&
        ((m.homeTeam === a && m.awayTeam === b) ||
          (m.homeTeam === b && m.awayTeam === a)),
    )
    .slice(-limit)
    .reverse();

  if (meetings.length === 0) {
    return { error: `No recorded meetings between ${a} and ${b}.` };
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
      if (winner === a) aWins++;
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
    teams: [a, b],
    meetings_analysed: results.length,
    summary: { [`${a} wins`]: aWins, draws, [`${b} wins`]: bWins },
    matches: results,
  };
}

async function evaluateModelAccuracyTool(): Promise<ToolResult> {
  const track = await getTrackRecord();

  if (track.evaluated === 0) {
    return {
      status: "no_data",
      message:
        "None of the forecast fixtures have been played yet. The track record builds up as the season progresses.",
    };
  }

  return {
    matches_evaluated: track.evaluated,
    correct_predictions: track.correct,
    accuracy: track.accuracy,
    note: "Accuracy on a small sample is noisy. Interpret with care until several matchweeks have accumulated.",
  };
}

// --- Registry and schemas ----------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const REGISTRY: Record<string, (args: any) => Promise<ToolResult>> = {
  get_standings: getStandingsTool,
  get_team_form: getTeamFormTool,
  get_match_prediction: getMatchPredictionTool,
  get_upcoming_fixtures: getUpcomingFixturesTool,
  get_team_ratings: getTeamRatingsTool,
  get_head_to_head: getHeadToHeadTool,
  evaluate_model_accuracy: evaluateModelAccuracyTool,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const TOOL_SCHEMAS = [
  {
    type: "function",
    name: "get_standings",
    description:
      "Get the Premier League table for a season, computed from finished matches. Use for questions about positions, points, or who is top.",
    parameters: {
      type: "object",
      properties: {
        season: {
          type: "integer",
          description:
            "Season start year, e.g. 2025 for 2025/26. Omit for the current season.",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_team_form",
    description:
      "Get a team's recent results and form. Use for questions about how a team has been playing lately, streaks, or recent performance.",
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
    type: "function",
    name: "get_match_prediction",
    description:
      "Get the model's probabilistic forecast for a specific upcoming fixture, including win/draw/loss probabilities and expected goals.",
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
    type: "function",
    name: "get_upcoming_fixtures",
    description:
      "List scheduled fixtures with their forecasts. Use for questions about what is coming up, optionally filtered to one team.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Optional team filter." },
        limit: { type: "integer", description: "Max fixtures (default 10)." },
      },
    },
  },
  {
    type: "function",
    name: "get_team_ratings",
    description:
      "Get model-estimated attack and defense strength for teams. Use when comparing how strong teams are, independent of current league position.",
    parameters: {
      type: "object",
      properties: {
        top_n: { type: "integer", description: "How many teams (default 20)." },
      },
    },
  },
  {
    type: "function",
    name: "get_head_to_head",
    description: "Get historical results between two specific teams.",
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
    type: "function",
    name: "evaluate_model_accuracy",
    description:
      "Check how the model's past predictions performed against real results. Use when asked how accurate or reliable the model is.",
    parameters: { type: "object", properties: {} },
  },
];

/** Dispatch a tool call, turning any failure into something the model can read. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = REGISTRY[name];
  if (!tool) return { error: `Unknown tool: ${name}` };

  try {
    return await tool(args ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Tool ${name} failed: ${message}` };
  }
}
