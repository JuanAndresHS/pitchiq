"""
PitchIQ — Train the Dixon-Coles model and forecast upcoming fixtures.

Runs once per league. Each competition gets its own fit: attack and defense
parameters are only comparable within a league, since a +0.5 attack rating in
the Bundesliga does not mean the same thing as a +0.5 in LaLiga. Cross-league
comparison needs matches that connect them, which domestic fixtures never
provide.

Outputs, per league, in data/predictions/<slug>/:

  team_ratings.csv         current attack/defense parameters
  upcoming_forecasts.csv   forecasts for every unplayed fixture, refreshed
  prediction_log.csv       append-only record of the forecast that stood
                           before each match was played

The log is the important one. Overwriting forecasts every run would erase the
evidence needed to score them afterwards, which quietly turns a live track
record into an unfalsifiable claim. Once a match_id appears in the log its row
is never rewritten.

Usage:
    python src/models/train_and_forecast.py                 # every league
    python src/models/train_and_forecast.py --league PD SA
    python src/models/train_and_forecast.py --alpha 5 --xi 0.003
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import minimize

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from leagues import League, domestic_codes, get_league  # noqa: E402

PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
PREDICTIONS_DIR = PROJECT_ROOT / "data" / "predictions"

MAX_GOALS = 10
DEFAULT_XI = 0.002  # time decay; ~347 day half-life
MIN_MATCHES = 100  # below this a fit is not worth trusting

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.model")


# --- Load --------------------------------------------------------------------


def load_matches(league: League) -> pd.DataFrame:
    """Every ingested match for one league, across all seasons."""
    files = sorted(PROCESSED_DIR.glob(f"{league.slug}_matches_*.csv"))
    if not files:
        raise FileNotFoundError(
            f"No match files for {league.name} in {PROCESSED_DIR}"
        )

    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    df["utc_date"] = pd.to_datetime(df["utc_date"], utc=True)
    return df.sort_values("utc_date").reset_index(drop=True)


# --- Model -------------------------------------------------------------------


def score_matrix(lam_home: float, lam_away: float, rho: float) -> np.ndarray:
    """Joint probability of every scoreline, with the Dixon-Coles correction."""
    p_home = stats.poisson.pmf(np.arange(MAX_GOALS + 1), lam_home)
    p_away = stats.poisson.pmf(np.arange(MAX_GOALS + 1), lam_away)
    matrix = np.outer(p_home, p_away)

    if rho != 0.0:
        matrix[0, 0] *= 1 - lam_home * lam_away * rho
        matrix[0, 1] *= 1 + lam_home * rho
        matrix[1, 0] *= 1 + lam_away * rho
        matrix[1, 1] *= 1 - rho
        matrix = np.clip(matrix, 1e-12, None)
        matrix /= matrix.sum()

    return matrix


def outcome_probs(lam_home: float, lam_away: float, rho: float):
    m = score_matrix(lam_home, lam_away, rho)
    return float(np.tril(m, -1).sum()), float(np.trace(m)), float(np.triu(m, 1).sum())


def fit_dixon_coles(played: pd.DataFrame, xi: float, alpha: float):
    """Penalised maximum likelihood fit.

    The ridge term on attack and defense is what keeps a newly promoted side
    with two matches from topping the ratings. With little data the likelihood
    barely constrains a team's parameters, so the optimiser is free to push them
    to whatever fits those two results exactly — the penalty pulls them back
    towards league average until real evidence accumulates.

    alpha was selected by held-out validation rather than by eye: log-loss and
    ranked probability score both improve up to roughly 3 and degrade beyond it.
    """
    teams = sorted(set(played["home_team"]) | set(played["away_team"]))
    index = {team: i for i, team in enumerate(teams)}
    n = len(teams)

    goals_home = played["home_goals"].astype(int).to_numpy()
    goals_away = played["away_goals"].astype(int).to_numpy()
    idx_home = played["home_team"].map(index).to_numpy()
    idx_away = played["away_team"].map(index).to_numpy()

    reference = played["utc_date"].max()
    days_ago = (reference - played["utc_date"]).dt.days.to_numpy()
    weights = np.exp(-xi * days_ago) if xi > 0 else np.ones_like(days_ago, dtype=float)

    def tau(x, y, lam, mu, rho):
        t = np.ones_like(lam, dtype=float)
        m00 = (x == 0) & (y == 0)
        m01 = (x == 0) & (y == 1)
        m10 = (x == 1) & (y == 0)
        m11 = (x == 1) & (y == 1)
        t[m00] = (1 - lam * mu * rho)[m00]
        t[m01] = (1 + lam * rho)[m01]
        t[m10] = (1 + mu * rho)[m10]
        t[m11] = 1 - rho
        return np.clip(t, 1e-10, None)

    def unpack(params):
        free = params[: n - 1]
        attack = np.concatenate([free, [-free.sum()]])  # identifiability
        return attack, params[n - 1 : 2 * n - 1], params[2 * n - 1], params[2 * n]

    def penalised_negative_log_likelihood(params):
        attack, defense, home_adv, rho = unpack(params)
        lam = np.exp(attack[idx_home] - defense[idx_away] + home_adv)
        mu = np.exp(attack[idx_away] - defense[idx_home])
        ll = (
            stats.poisson.logpmf(goals_home, lam)
            + stats.poisson.logpmf(goals_away, mu)
            + np.log(tau(goals_home, goals_away, lam, mu, rho))
        )
        penalty = (
            alpha * (np.sum(attack**2) + np.sum(defense**2)) if alpha > 0 else 0.0
        )
        return -np.sum(weights * ll) + penalty

    x0 = np.concatenate([np.zeros(n - 1), np.zeros(n), [0.25], [-0.05]])
    bounds = [(-3, 3)] * (n - 1) + [(-3, 3)] * n + [(-1, 1), (-0.2, 0.2)]

    result = minimize(
        penalised_negative_log_likelihood,
        x0,
        method="L-BFGS-B",
        bounds=bounds,
        options={"maxiter": 3000},
    )

    if not result.success:
        logger.warning("Optimiser did not fully converge: %s", result.message)

    attack, defense, home_adv, rho = unpack(result.x)
    return {
        "teams": teams,
        "index": index,
        "attack": attack,
        "defense": defense,
        "home_advantage": float(home_adv),
        "rho": float(rho),
    }


def predict(model: dict, home_team: str, away_team: str) -> tuple[float, float]:
    """Expected goals. Unseen teams get replacement-level parameters."""
    i = model["index"].get(home_team)
    j = model["index"].get(away_team)
    attack, defense = model["attack"], model["defense"]

    a_h = attack[i] if i is not None else attack.mean()
    d_h = defense[i] if i is not None else defense.mean()
    a_a = attack[j] if j is not None else attack.mean()
    d_a = defense[j] if j is not None else defense.mean()

    return (
        float(np.exp(a_h - d_a + model["home_advantage"])),
        float(np.exp(a_a - d_h)),
    )


# --- Outputs -----------------------------------------------------------------


def build_forecasts(
    model: dict, upcoming: pd.DataFrame, league: League
) -> pd.DataFrame:
    rows = []

    for match in upcoming.itertuples():
        lam, mu = predict(model, match.home_team, match.away_team)
        p_home, p_draw, p_away = outcome_probs(lam, mu, model["rho"])
        matrix = score_matrix(lam, mu, model["rho"])
        likely = np.unravel_index(matrix.argmax(), matrix.shape)

        rows.append(
            {
                "match_id": match.match_id,
                "league": league.slug,
                "date": match.utc_date.date().isoformat(),
                "matchday": match.matchday,
                "home_team": match.home_team,
                "away_team": match.away_team,
                "xg_home": round(lam, 2),
                "xg_away": round(mu, 2),
                "p_home_win": round(p_home, 4),
                "p_draw": round(p_draw, 4),
                "p_away_win": round(p_away, 4),
                "most_likely_score": f"{likely[0]}-{likely[1]}",
                "prediction": ["H", "D", "A"][
                    int(np.argmax([p_home, p_draw, p_away]))
                ],
                "confidence": round(max(p_home, p_draw, p_away), 4),
            }
        )

    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def update_prediction_log(forecasts: pd.DataFrame, out_dir: Path) -> int:
    """Record forecasts for matches not already logged. Never rewrites a row.

    A forecast is only meaningful evidence if it was fixed before the match was
    played. Re-forecasting a match after the fact and then scoring it would be
    marking your own homework.
    """
    path = out_dir / "prediction_log.csv"

    if path.exists():
        existing = pd.read_csv(path)
        known = set(existing["match_id"])
    else:
        existing = pd.DataFrame()
        known = set()

    fresh = forecasts[~forecasts["match_id"].isin(known)].copy()

    if fresh.empty:
        logger.info("  Prediction log unchanged (%s entries).", len(known))
        return 0

    fresh["forecast_made_at"] = datetime.now(timezone.utc).date().isoformat()

    combined = (
        pd.concat([existing, fresh], ignore_index=True)
        if not existing.empty
        else fresh
    )
    combined.to_csv(path, index=False)

    logger.info("  Logged %s new forecast(s); %s total.", len(fresh), len(combined))
    return len(fresh)


def report_track_record(played: pd.DataFrame, out_dir: Path) -> None:
    """Score logged forecasts against results that have since come in."""
    path = out_dir / "prediction_log.csv"
    if not path.exists():
        return

    log = pd.read_csv(path)
    scored = log.merge(played[["match_id", "result"]], on="match_id", how="inner")

    if scored.empty:
        logger.info("  Track record: nothing logged has been played yet.")
        return

    correct = (scored["prediction"] == scored["result"]).sum()
    logger.info(
        "  Track record: %s/%s correct (%.1f%%).",
        correct,
        len(scored),
        correct / len(scored) * 100,
    )


# --- Per-league run ----------------------------------------------------------


def run_league(league: League, xi: float, alpha: float | None) -> bool:
    """Fit and forecast one league.

    alpha defaults to the value tuned for this competition; passing one on the
    command line overrides it for every league, which is what you want when
    experimenting but not in the pipeline.
    """
    penalty = league.alpha if alpha is None else alpha
    logger.info("--- %s (alpha=%s) ---", league.name, penalty)

    try:
        df = load_matches(league)
    except FileNotFoundError as exc:
        logger.warning("  %s", exc)
        return False

    played = df[df["status"] == "FINISHED"].copy()
    upcoming = df[df["status"] != "FINISHED"].copy()

    if len(played) < MIN_MATCHES:
        logger.warning(
            "  Only %s finished matches — need at least %s to fit.",
            len(played),
            MIN_MATCHES,
        )
        return False

    logger.info(
        "  Fitting on %s matches across %s seasons.",
        len(played),
        played["season"].nunique(),
    )

    model = fit_dixon_coles(played, xi, penalty)

    logger.info(
        "  Home advantage %.3f (%.3fx) | rho %+.4f | %s teams",
        model["home_advantage"],
        np.exp(model["home_advantage"]),
        model["rho"],
        len(model["teams"]),
    )

    out_dir = PREDICTIONS_DIR / league.slug
    out_dir.mkdir(parents=True, exist_ok=True)

    # Match counts travel with the ratings so downstream consumers can tell a
    # settled rating from one built on three games.
    appearances = pd.concat([played["home_team"], played["away_team"]]).value_counts()

    ratings = (
        pd.DataFrame(
            {
                "team": model["teams"],
                "attack": model["attack"],
                "defense": model["defense"],
            }
        )
        .assign(
            overall=lambda d: d["attack"] + d["defense"],
            matches=lambda d: d["team"].map(appearances).fillna(0).astype(int),
        )
        .sort_values("overall", ascending=False)
        .round(4)
    )
    ratings.to_csv(out_dir / "team_ratings.csv", index=False)

    # The fitted parameters, so downstream consumers read what the model
    # actually estimated rather than a number copied into a config by hand.
    # Home advantage and rho are the two that carry meaning on their own, and
    # unlike team ratings they *are* comparable across leagues: both describe
    # the competition, not a squad.
    params = {
        "league": league.slug,
        "league_name": league.name,
        "home_advantage": round(float(np.exp(model["home_advantage"])), 4),
        "home_advantage_log": round(model["home_advantage"], 4),
        "rho": round(model["rho"], 4),
        "xi": xi,
        "alpha": penalty,
        "teams": len(model["teams"]),
        "matches_fitted": int(len(played)),
        "seasons": int(played["season"].nunique()),
        "goals_per_match": round(
            float((played["home_goals"] + played["away_goals"]).mean()), 3
        ),
        "home_win_rate": round(float((played["result"] == "H").mean()), 4),
        "draw_rate": round(float((played["result"] == "D").mean()), 4),
        "away_win_rate": round(float((played["result"] == "A").mean()), 4),
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out_dir / "model_params.json").write_text(json.dumps(params, indent=2))

    strongest = ratings.iloc[0]
    logger.info(
        "  Ratings saved. Strongest: %s (%+.2f, %s matches).",
        strongest["team"],
        strongest["overall"],
        strongest["matches"],
    )

    if upcoming.empty:
        logger.warning("  No upcoming fixtures to forecast.")
    else:
        forecasts = build_forecasts(model, upcoming, league)
        forecasts.to_csv(out_dir / "upcoming_forecasts.csv", index=False)
        logger.info("  Saved %s forecasts.", len(forecasts))
        update_prediction_log(forecasts, out_dir)

    report_track_record(played, out_dir)
    return True


# --- Entrypoint --------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and forecast.")
    parser.add_argument(
        "--league",
        nargs="+",
        default=domestic_codes(),
        metavar="CODE",
        help=f"Which leagues to model. Default: all ({', '.join(domestic_codes())}).",
    )
    parser.add_argument(
        "--xi",
        type=float,
        default=DEFAULT_XI,
        help="Time decay rate. Higher discounts older matches faster.",
    )
    parser.add_argument(
        "--alpha",
        type=float,
        default=None,
        help="Override the per-league ridge penalty for every league.",
    )
    args = parser.parse_args()

    try:
        leagues = [get_league(code) for code in args.league]
    except ValueError as exc:
        logger.error("%s", exc)
        return 1

    logger.info(
        "Parameters: xi=%s, alpha=%s",
        args.xi,
        "per-league" if args.alpha is None else args.alpha,
    )

    succeeded = [lg.name for lg in leagues if run_league(lg, args.xi, args.alpha)]
    failed = [lg.name for lg in leagues if lg.name not in succeeded]

    logger.info("Done. %s modelled, %s skipped.", len(succeeded), len(failed))
    if failed:
        logger.warning("Skipped: %s", ", ".join(failed))

    return 0 if succeeded else 1


if __name__ == "__main__":
    sys.exit(main())