"""
PitchIQ — Train the Dixon-Coles model and forecast upcoming fixtures.

Extracted from notebooks/02_outcome_model.ipynb so the pipeline can retrain
without a human opening Jupyter. The notebook remains the place where the model
is explained and evaluated; this is the place where it runs.

Outputs three files in data/predictions/:

  team_ratings.csv         current attack/defense parameters
  upcoming_forecasts.csv   forecasts for every unplayed fixture, refreshed
  prediction_log.csv       append-only record of the forecast that stood
                           before each match was played

The log is the important one. Overwriting forecasts every run would erase the
evidence needed to score them afterwards, which quietly turns a live track
record into an unfalsifiable claim. Once a match_id appears in the log its row
is never rewritten.

Usage:
    python src/models/train_and_forecast.py
    python src/models/train_and_forecast.py --alpha 5 --xi 0.003
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import minimize

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
PREDICTIONS_DIR = PROJECT_ROOT / "data" / "predictions"

MAX_GOALS = 10
DEFAULT_XI = 0.002  # time decay; ~347 day half-life
DEFAULT_ALPHA = 8.0  # ridge penalty; selected on a held-out season

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.model")


# --- Load --------------------------------------------------------------------


def load_matches() -> pd.DataFrame:
    files = sorted(PROCESSED_DIR.glob("pl_matches_*.csv"))
    if not files:
        raise FileNotFoundError(f"No match files in {PROCESSED_DIR}")

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
    ranked probability score both improve up to roughly 8 and degrade beyond it,
    so this shrinks overfitting *and* forecasts better.
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


def build_forecasts(model: dict, upcoming: pd.DataFrame) -> pd.DataFrame:
    rows = []

    for match in upcoming.itertuples():
        lam, mu = predict(model, match.home_team, match.away_team)
        p_home, p_draw, p_away = outcome_probs(lam, mu, model["rho"])
        matrix = score_matrix(lam, mu, model["rho"])
        likely = np.unravel_index(matrix.argmax(), matrix.shape)

        rows.append(
            {
                "match_id": match.match_id,
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


def update_prediction_log(forecasts: pd.DataFrame) -> int:
    """Record forecasts for matches not already logged. Never rewrites a row.

    A forecast is only meaningful evidence if it was fixed before the match was
    played. Re-forecasting a match after the fact and then scoring it would be
    marking your own homework.
    """
    path = PREDICTIONS_DIR / "prediction_log.csv"

    if path.exists():
        existing = pd.read_csv(path)
        known = set(existing["match_id"])
    else:
        existing = pd.DataFrame()
        known = set()

    fresh = forecasts[~forecasts["match_id"].isin(known)].copy()

    if fresh.empty:
        logger.info("Prediction log unchanged (%s entries).", len(known))
        return 0

    fresh["forecast_made_at"] = datetime.now(timezone.utc).date().isoformat()

    combined = (
        pd.concat([existing, fresh], ignore_index=True)
        if not existing.empty
        else fresh
    )
    combined.to_csv(path, index=False)

    logger.info("Logged %s new forecast(s); %s total.", len(fresh), len(combined))
    return len(fresh)


def report_track_record(played: pd.DataFrame) -> None:
    """Score logged forecasts against results that have since come in."""
    path = PREDICTIONS_DIR / "prediction_log.csv"
    if not path.exists():
        return

    log = pd.read_csv(path)
    results = played[["match_id", "result"]]
    scored = log.merge(results, on="match_id", how="inner")

    if scored.empty:
        logger.info("Track record: no logged forecasts have been played yet.")
        return

    correct = (scored["prediction"] == scored["result"]).sum()
    logger.info(
        "Track record: %s/%s correct (%.1f%%) over %s scored matches.",
        correct,
        len(scored),
        correct / len(scored) * 100,
        len(scored),
    )


# --- Entrypoint --------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and forecast.")
    parser.add_argument(
        "--xi",
        type=float,
        default=DEFAULT_XI,
        help="Time decay rate. Higher discounts older matches faster.",
    )
    parser.add_argument(
        "--alpha",
        type=float,
        default=DEFAULT_ALPHA,
        help="Ridge penalty on team parameters. Higher shrinks ratings towards "
        "league average, which matters most for teams with few matches.",
    )
    args = parser.parse_args()

    try:
        df = load_matches()
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return 1

    played = df[df["status"] == "FINISHED"].copy()
    upcoming = df[df["status"] != "FINISHED"].copy()

    if len(played) < 100:
        logger.error("Only %s finished matches — too few to fit.", len(played))
        return 1

    logger.info(
        "Fitting on %s matches across %s seasons (xi=%s, alpha=%s).",
        len(played),
        played["season"].nunique(),
        args.xi,
        args.alpha,
    )

    model = fit_dixon_coles(played, args.xi, args.alpha)

    logger.info(
        "Home advantage %.3f (%.3fx) | rho %.4f | %s teams",
        model["home_advantage"],
        np.exp(model["home_advantage"]),
        model["rho"],
        len(model["teams"]),
    )

    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)

    # Match counts travel with the ratings so downstream consumers can tell a
    # settled rating from one built on three games.
    appearances = pd.concat(
        [played["home_team"], played["away_team"]]
    ).value_counts()

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
    ratings.to_csv(PREDICTIONS_DIR / "team_ratings.csv", index=False)

    strongest = ratings.iloc[0]
    logger.info(
        "Saved ratings for %s teams. Strongest: %s (%.2f, %s matches).",
        len(ratings),
        strongest["team"],
        strongest["overall"],
        strongest["matches"],
    )

    if upcoming.empty:
        logger.warning("No upcoming fixtures to forecast.")
    else:
        forecasts = build_forecasts(model, upcoming)
        forecasts.to_csv(PREDICTIONS_DIR / "upcoming_forecasts.csv", index=False)
        logger.info("Saved %s forecasts.", len(forecasts))
        update_prediction_log(forecasts)

    report_track_record(played)
    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
