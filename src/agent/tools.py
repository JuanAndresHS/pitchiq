"""
PitchIQ — Agent tools.

Each public function here is exposed to Claude as a callable tool. They are the
only way the agent can obtain facts: it cannot recall standings or invent a
prediction, it has to ask the data.

Design notes:
- Every function returns a JSON-serializable dict, never a DataFrame.
- Team names are resolved fuzzily, because people type "Arsenal", not "Arsenal FC".
- Failures return {"error": ...} instead of raising, so the agent can recover
  and explain the problem rather than crashing the conversation.
"""

from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data" / "processed"
PREDICTIONS_DIR = PROJECT_ROOT / "data" / "predictions"

_cache: dict[str, pd.DataFrame] = {}


# --- Data access -------------------------------------------------------------


def _load_matches() -> pd.DataFrame:
    """Load and cache every ingested match."""
    if "matches" not in _cache:
        files = sorted(DATA_DIR.glob("pl_matches_*.csv"))
        if not files:
            raise FileNotFoundError(f"No match files found in {DATA_DIR}")
        df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
        df["utc_date"] = pd.to_datetime(df["utc_date"], utc=True)
        _cache["matches"] = df.sort_values("utc_date").reset_index(drop=True)
    return _cache["matches"]


def _load_forecasts() -> pd.DataFrame:
    if "forecasts" not in _cache:
        path = PREDICTIONS_DIR / "upcoming_forecasts.csv"
        if not path.exists():
            raise FileNotFoundError(
                "No forecasts found. Run notebooks/02_outcome_model.ipynb first."
            )
        _cache["forecasts"] = pd.read_csv(path, parse_dates=["date"])
    return _cache["forecasts"]


def _load_ratings() -> pd.DataFrame:
    if "ratings" not in _cache:
        path = PREDICTIONS_DIR / "team_ratings.csv"
        if not path.exists():
            raise FileNotFoundError("No ratings found. Run the model notebook first.")
        _cache["ratings"] = pd.read_csv(path)
    return _cache["ratings"]


def _all_teams() -> list[str]:
    df = _load_matches()
    return sorted(set(df["home_team"]) | set(df["away_team"]))


def _resolve_team(name: str) -> str | None:
    """Map a loosely typed team name onto the canonical one.

    Handles the three ways people actually refer to clubs: the full official
    name, the common short name, and a near-miss typo.
    """
    teams = _all_teams()
    query = name.strip().lower()

    for team in teams:
        if team.lower() == query:
            return team

    # Substring match — "arsenal" inside "Arsenal FC", "spurs" is handled below.
    partial = [t for t in teams if query in t.lower()]
    if len(partial) == 1:
        return partial[0]

    aliases = {
        "spurs": "Tottenham Hotspur FC",
        "man city": "Manchester City FC",
        "man utd": "Manchester United FC",
        "man united": "Manchester United FC",
        "united": "Manchester United FC",
        "city": "Manchester City FC",
        "wolves": "Wolverhampton Wanderers FC",
        "newcastle": "Newcastle United FC",
        "brighton": "Brighton & Hove Albion FC",
        "forest": "Nottingham Forest FC",
        "palace": "Crystal Palace FC",
        "villa": "Aston Villa FC",
        "hammers": "West Ham United FC",
        "gunners": "Arsenal FC",
        "reds": "Liverpool FC",
        "blues": "Chelsea FC",
        "toffees": "Everton FC",
        "cherries": "AFC Bournemouth",
    }
    if query in aliases and aliases[query] in teams:
        return aliases[query]

    close = difflib.get_close_matches(name, teams, n=1, cutoff=0.6)
    return close[0] if close else None


def _not_found(name: str) -> dict[str, Any]:
    return {
        "error": f"Team '{name}' not found.",
        "available_teams": _all_teams(),
    }


# --- Tools -------------------------------------------------------------------


def get_standings(season: int | None = None) -> dict[str, Any]:
    """Current league table, computed from finished matches.

    Args:
        season: Season start year. Defaults to the most recent one.
    """
    df = _load_matches()
    played = df[df["status"] == "FINISHED"]

    if season is None:
        season = int(played["season"].max())
    played = played[played["season"] == season]

    if played.empty:
        return {"error": f"No finished matches for season {season}."}

    rows = []
    for team in sorted(set(played["home_team"]) | set(played["away_team"])):
        home = played[played["home_team"] == team]
        away = played[played["away_team"] == team]

        wins = (home["result"] == "H").sum() + (away["result"] == "A").sum()
        draws = (home["result"] == "D").sum() + (away["result"] == "D").sum()
        losses = (home["result"] == "A").sum() + (away["result"] == "H").sum()
        scored = home["home_goals"].sum() + away["away_goals"].sum()
        conceded = home["away_goals"].sum() + away["home_goals"].sum()

        rows.append({
            "team": team,
            "played": int(len(home) + len(away)),
            "won": int(wins), "drawn": int(draws), "lost": int(losses),
            "goals_for": int(scored), "goals_against": int(conceded),
            "goal_difference": int(scored - conceded),
            "points": int(wins * 3 + draws),
        })

    table = pd.DataFrame(rows).sort_values(
        ["points", "goal_difference", "goals_for"], ascending=False
    ).reset_index(drop=True)
    table.insert(0, "position", range(1, len(table) + 1))

    return {
        "season": season,
        "matches_played": int(len(played)),
        "last_updated": played["utc_date"].max().strftime("%Y-%m-%d"),
        "table": table.to_dict("records"),
    }


def get_team_form(team: str, last_n: int = 5) -> dict[str, Any]:
    """Recent results for a team, most recent first.

    Args:
        team: Team name, in any common form.
        last_n: How many recent matches to return (1-20).
    """
    resolved = _resolve_team(team)
    if resolved is None:
        return _not_found(team)

    last_n = max(1, min(int(last_n), 20))
    df = _load_matches()
    played = df[df["status"] == "FINISHED"]
    matches = played[
        (played["home_team"] == resolved) | (played["away_team"] == resolved)
    ].tail(last_n).iloc[::-1]

    if matches.empty:
        return {"error": f"No finished matches found for {resolved}."}

    history, points = [], 0
    for m in matches.itertuples():
        is_home = m.home_team == resolved
        opponent = m.away_team if is_home else m.home_team
        scored = m.home_goals if is_home else m.away_goals
        conceded = m.away_goals if is_home else m.home_goals

        if scored > conceded:
            outcome, pts = "W", 3
        elif scored == conceded:
            outcome, pts = "D", 1
        else:
            outcome, pts = "L", 0
        points += pts

        history.append({
            "date": m.utc_date.strftime("%Y-%m-%d"),
            "opponent": opponent,
            "venue": "home" if is_home else "away",
            "score": f"{int(scored)}-{int(conceded)}",
            "outcome": outcome,
        })

    return {
        "team": resolved,
        "matches_analysed": len(history),
        "form_string": "".join(h["outcome"] for h in history),
        "points_taken": points,
        "points_available": len(history) * 3,
        "goals_scored": int(sum(int(h["score"].split("-")[0]) for h in history)),
        "goals_conceded": int(sum(int(h["score"].split("-")[1]) for h in history)),
        "matches": history,
    }


def get_match_prediction(home_team: str, away_team: str) -> dict[str, Any]:
    """Model forecast for a specific upcoming fixture.

    Args:
        home_team: The home side.
        away_team: The away side.
    """
    home = _resolve_team(home_team)
    away = _resolve_team(away_team)
    if home is None:
        return _not_found(home_team)
    if away is None:
        return _not_found(away_team)

    try:
        forecasts = _load_forecasts()
    except FileNotFoundError as exc:
        return {"error": str(exc)}

    match = forecasts[
        (forecasts["home_team"] == home) & (forecasts["away_team"] == away)
    ]
    if match.empty:
        return {
            "error": f"No upcoming fixture found for {home} vs {away}.",
            "hint": "This fixture may already have been played, or may not be scheduled.",
        }

    row = match.iloc[0]
    return {
        "fixture": f"{home} vs {away}",
        "date": str(row["date"])[:10],
        "matchday": int(row["matchday"]),
        "expected_goals": {"home": float(row["xg_home"]), "away": float(row["xg_away"])},
        "probabilities": {
            "home_win": float(row["p_home_win"]),
            "draw": float(row["p_draw"]),
            "away_win": float(row["p_away_win"]),
        },
        "most_likely_score": str(row["most_likely_score"]),
        "model_pick": {"H": "home win", "D": "draw", "A": "away win"}[row["prediction"]],
        "confidence": float(row["confidence"]),
    }


def get_upcoming_fixtures(team: str | None = None, limit: int = 10) -> dict[str, Any]:
    """Scheduled fixtures with model forecasts attached.

    Args:
        team: Optional filter for a single team.
        limit: Maximum fixtures to return (1-20).
    """
    try:
        forecasts = _load_forecasts()
    except FileNotFoundError as exc:
        return {"error": str(exc)}

    limit = max(1, min(int(limit), 20))
    subset = forecasts.copy()
    resolved = None

    if team:
        resolved = _resolve_team(team)
        if resolved is None:
            return _not_found(team)
        subset = subset[
            (subset["home_team"] == resolved) | (subset["away_team"] == resolved)
        ]

    if subset.empty:
        return {"error": "No upcoming fixtures found."}

    subset = subset.sort_values("date").head(limit)
    fixtures = [{
        "date": str(r.date)[:10],
        "matchday": int(r.matchday),
        "fixture": f"{r.home_team} vs {r.away_team}",
        "probabilities": {
            "home_win": float(r.p_home_win),
            "draw": float(r.p_draw),
            "away_win": float(r.p_away_win),
        },
        "most_likely_score": str(r.most_likely_score),
    } for r in subset.itertuples()]

    return {"team_filter": resolved, "count": len(fixtures), "fixtures": fixtures}


def get_team_ratings(top_n: int = 20) -> dict[str, Any]:
    """Model-estimated attack and defense strength for every team.

    Higher attack means the team scores more; higher defense means it concedes
    less. Both are on a log scale centred near zero.

    Args:
        top_n: How many teams to return, strongest first (1-30).
    """
    try:
        ratings = _load_ratings()
    except FileNotFoundError as exc:
        return {"error": str(exc)}

    top_n = max(1, min(int(top_n), 30))
    subset = ratings.sort_values("overall", ascending=False).head(top_n)

    return {
        "explanation": "Attack and defense parameters from the Dixon-Coles model. "
                       "Values are log-scale; 0 is league average.",
        "teams": [{
            "rank": i + 1,
            "team": r.team,
            "attack": round(float(r.attack), 3),
            "defense": round(float(r.defense), 3),
            "overall": round(float(r.overall), 3),
        } for i, r in enumerate(subset.itertuples())],
    }


def get_head_to_head(team_a: str, team_b: str, limit: int = 10) -> dict[str, Any]:
    """Historical results between two teams.

    Args:
        team_a: First team.
        team_b: Second team.
        limit: Maximum past meetings to return (1-20).
    """
    a, b = _resolve_team(team_a), _resolve_team(team_b)
    if a is None:
        return _not_found(team_a)
    if b is None:
        return _not_found(team_b)

    limit = max(1, min(int(limit), 20))
    df = _load_matches()
    played = df[df["status"] == "FINISHED"]
    meetings = played[
        ((played["home_team"] == a) & (played["away_team"] == b))
        | ((played["home_team"] == b) & (played["away_team"] == a))
    ].tail(limit).iloc[::-1]

    if meetings.empty:
        return {"error": f"No recorded meetings between {a} and {b} in the dataset."}

    a_wins = b_wins = draws = 0
    results = []
    for m in meetings.itertuples():
        if m.result == "D":
            draws += 1
            winner = "draw"
        else:
            won = m.home_team if m.result == "H" else m.away_team
            winner = won
            if won == a:
                a_wins += 1
            else:
                b_wins += 1
        results.append({
            "date": m.utc_date.strftime("%Y-%m-%d"),
            "fixture": f"{m.home_team} vs {m.away_team}",
            "score": f"{int(m.home_goals)}-{int(m.away_goals)}",
            "winner": winner,
        })

    return {
        "teams": [a, b],
        "meetings_analysed": len(results),
        "summary": {f"{a} wins": a_wins, "draws": draws, f"{b} wins": b_wins},
        "matches": results,
    }


def evaluate_model_accuracy() -> dict[str, Any]:
    """Score past forecasts against what actually happened.

    This is the project's honesty check: it compares stored predictions with
    real results, so the agent can report a live track record rather than the
    accuracy claimed at training time.
    """
    try:
        forecasts = _load_forecasts()
    except FileNotFoundError as exc:
        return {"error": str(exc)}

    df = _load_matches()
    played = df[df["status"] == "FINISHED"][["match_id", "result", "home_goals", "away_goals"]]
    merged = forecasts.merge(played, on="match_id", how="inner")

    if merged.empty:
        return {
            "status": "no_data",
            "message": "None of the forecast fixtures have been played yet. "
                       "The track record will build up as the season progresses.",
        }

    merged["correct"] = merged["prediction"] == merged["result"]
    by_pick = merged.groupby("prediction")["correct"].agg(["size", "sum"])

    return {
        "matches_evaluated": int(len(merged)),
        "correct_predictions": int(merged["correct"].sum()),
        "accuracy": round(float(merged["correct"].mean()), 4),
        "average_confidence": round(float(merged["confidence"].mean()), 4),
        "breakdown_by_pick": {
            {"H": "home win", "D": "draw", "A": "away win"}[k]: {
                "predicted": int(v["size"]), "correct": int(v["sum"])
            } for k, v in by_pick.iterrows()
        },
        "note": "Accuracy on a small sample is noisy. Interpret with care until "
                "several matchweeks have accumulated.",
    }


# --- Tool schemas for the Claude API -----------------------------------------

TOOL_SCHEMAS = [
    {
        "name": "get_standings",
        "description": (
            "Get the Premier League table for a season, computed from finished "
            "matches. Use for questions about positions, points, or who is top."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "season": {
                    "type": "integer",
                    "description": "Season start year, e.g. 2025 for 2025/26. "
                                   "Omit for the current season.",
                }
            },
        },
    },
    {
        "name": "get_team_form",
        "description": (
            "Get a team's recent results and form. Use for questions about how a "
            "team has been playing lately, streaks, or recent performance."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "team": {"type": "string", "description": "Team name."},
                "last_n": {
                    "type": "integer",
                    "description": "Number of recent matches (default 5, max 20).",
                },
            },
            "required": ["team"],
        },
    },
    {
        "name": "get_match_prediction",
        "description": (
            "Get the model's probabilistic forecast for a specific upcoming "
            "fixture, including win/draw/loss probabilities and expected goals."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "home_team": {"type": "string", "description": "Home team."},
                "away_team": {"type": "string", "description": "Away team."},
            },
            "required": ["home_team", "away_team"],
        },
    },
    {
        "name": "get_upcoming_fixtures",
        "description": (
            "List scheduled fixtures with their forecasts. Use for questions "
            "about what is coming up, optionally filtered to one team."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "team": {"type": "string", "description": "Optional team filter."},
                "limit": {"type": "integer", "description": "Max fixtures (default 10)."},
            },
        },
    },
    {
        "name": "get_team_ratings",
        "description": (
            "Get model-estimated attack and defense strength for teams. Use when "
            "comparing how strong teams are, independent of current league position."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "top_n": {"type": "integer", "description": "How many teams (default 20)."}
            },
        },
    },
    {
        "name": "get_head_to_head",
        "description": "Get historical results between two specific teams.",
        "input_schema": {
            "type": "object",
            "properties": {
                "team_a": {"type": "string", "description": "First team."},
                "team_b": {"type": "string", "description": "Second team."},
                "limit": {"type": "integer", "description": "Max meetings (default 10)."},
            },
            "required": ["team_a", "team_b"],
        },
    },
    {
        "name": "evaluate_model_accuracy",
        "description": (
            "Check how the model's past predictions performed against real "
            "results. Use when asked how accurate or reliable the model is."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]

TOOL_REGISTRY = {
    "get_standings": get_standings,
    "get_team_form": get_team_form,
    "get_match_prediction": get_match_prediction,
    "get_upcoming_fixtures": get_upcoming_fixtures,
    "get_team_ratings": get_team_ratings,
    "get_head_to_head": get_head_to_head,
    "evaluate_model_accuracy": evaluate_model_accuracy,
}


def execute_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a tool call, converting any failure into a readable error."""
    func = TOOL_REGISTRY.get(name)
    if func is None:
        return {"error": f"Unknown tool: {name}"}
    try:
        return func(**arguments)
    except TypeError as exc:
        return {"error": f"Invalid arguments for {name}: {exc}"}
    except Exception as exc:  # noqa: BLE001 - the agent should see any failure
        return {"error": f"{type(exc).__name__}: {exc}"}
