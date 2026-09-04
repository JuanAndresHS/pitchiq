"""
PitchIQ — Cross-league model.

Domestic ratings live on separate scales. A +0.5 attack rating in the Bundesliga
and a +0.5 in LaLiga are both "half a unit above that league's average", but
nothing in the domestic data says whether those averages are the same. European
fixtures are the only matches that connect them.

This script estimates one strength offset per league from those fixtures, with
the team ratings held fixed at what the domestic models produced. Two stages
rather than one joint fit: with 8 parameters and a few hundred European matches
the estimate is already well determined, and keeping the stages separate means a
team's rating still means what it meant — something measured over a full domestic
season, not something bent to fit six European nights.

    log(λ_home) = attack_i − defense_j + home_adv_eu + (strength_i − strength_j)
                  └──── fixed, from the domestic fits ────┘   └── estimated here ──┘

Clubs from leagues too small to model share one pooled group. Each appears once
or twice in four seasons, which cannot support a Norwegian or Cypriot league
factor, but collectively they describe a level. Inside that group every club is
treated identically — Celtic and Kairat get the same parameters — which is the
model's coarsest assumption and is reported as such.

Usage:
    python src/models/european_model.py
    python src/models/european_model.py --bootstrap 1000
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

from leagues import cup_codes, domestic_codes, get_league  # noqa: E402

PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
PREDICTIONS_DIR = PROJECT_ROOT / "data" / "predictions"

MAX_GOALS = 10
REST = "rest"
REST_LABEL = "Rest of Europe"

# Strengths are only identified relative to one another, so one league is pinned
# at zero and the others read as offsets from it.
REFERENCE = "pl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.european")


# --- Inputs ------------------------------------------------------------------


def load_competition(slug: str) -> pd.DataFrame:
    files = sorted(PROCESSED_DIR.glob(f"{slug}_matches_*.csv"))
    if not files:
        return pd.DataFrame()

    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    df["utc_date"] = pd.to_datetime(df["utc_date"], utc=True)
    return df.sort_values("utc_date").reset_index(drop=True)


def build_team_index() -> dict[str, dict]:
    """Every rated team, with its league and centred parameters.

    Both attack and defense are centred within their league. The domestic fit
    only constrains attack to sum to zero, so a league's mean defense carries
    part of its overall scoring level — exactly the quantity the league strength
    parameter is meant to hold. Leaving it in the team ratings would make the two
    unidentifiable.
    """
    index: dict[str, dict] = {}

    for code in domestic_codes():
        league = get_league(code)
        path = PREDICTIONS_DIR / league.slug / "team_ratings.csv"
        if not path.exists():
            logger.warning("No ratings for %s — skipped.", league.name)
            continue

        ratings = pd.read_csv(path)
        mean_attack = ratings["attack"].mean()
        mean_defense = ratings["defense"].mean()

        for row in ratings.itertuples():
            index[row.team] = {
                "league": league.slug,
                "attack": float(row.attack) - mean_attack,
                "defense": float(row.defense) - mean_defense,
            }

    return index


def resolve(team: str, index: dict[str, dict]) -> dict:
    """A rated team, or a pooled placeholder for everyone else."""
    entry = index.get(team)
    if entry is not None:
        return entry
    return {"league": REST, "attack": 0.0, "defense": 0.0}


# --- Model -------------------------------------------------------------------


def score_matrix(lam_home: float, lam_away: float, rho: float) -> np.ndarray:
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


def prepare(matches: pd.DataFrame, index: dict[str, dict]) -> dict:
    """Turn European fixtures into the arrays the likelihood needs."""
    rows = []

    for match in matches.itertuples():
        home = resolve(match.home_team, index)
        away = resolve(match.away_team, index)

        # Meetings inside the pooled group carry no information about relative
        # strength: both sides sit at the same offset, which cancels.
        if home["league"] == REST and away["league"] == REST:
            continue

        rows.append(
            {
                "home_goals": int(match.home_goals),
                "away_goals": int(match.away_goals),
                "home_league": home["league"],
                "away_league": away["league"],
                "home_effect": home["attack"] + away["defense"] * -1,
                "away_effect": away["attack"] + home["defense"] * -1,
            }
        )

    frame = pd.DataFrame(rows)
    groups = sorted(set(frame["home_league"]) | set(frame["away_league"]))

    # The reference sits at index 0 and is pinned to zero.
    if REFERENCE in groups:
        groups.remove(REFERENCE)
        groups.insert(0, REFERENCE)

    position = {group: i for i, group in enumerate(groups)}

    return {
        "groups": groups,
        "goals_home": frame["home_goals"].to_numpy(),
        "goals_away": frame["away_goals"].to_numpy(),
        "idx_home": frame["home_league"].map(position).to_numpy(),
        "idx_away": frame["away_league"].map(position).to_numpy(),
        "effect_home": frame["home_effect"].to_numpy(),
        "effect_away": frame["away_effect"].to_numpy(),
        "n": len(frame),
    }


def fit(data: dict, weights: np.ndarray | None = None) -> dict:
    """Estimate league strengths, European home advantage and rho."""
    n_groups = len(data["groups"])
    w = np.ones(data["n"]) if weights is None else weights

    def unpack(params):
        # First group is the reference, pinned at zero.
        strengths = np.concatenate([[0.0], params[: n_groups - 1]])
        return strengths, params[n_groups - 1], params[n_groups]

    def negative_log_likelihood(params):
        strengths, home_adv, rho = unpack(params)
        gap = strengths[data["idx_home"]] - strengths[data["idx_away"]]

        lam = np.exp(data["effect_home"] + home_adv + gap)
        mu = np.exp(data["effect_away"] - gap)

        x, y = data["goals_home"], data["goals_away"]
        tau = np.ones_like(lam)
        m00 = (x == 0) & (y == 0)
        m01 = (x == 0) & (y == 1)
        m10 = (x == 1) & (y == 0)
        m11 = (x == 1) & (y == 1)
        tau[m00] = (1 - lam * mu * rho)[m00]
        tau[m01] = (1 + lam * rho)[m01]
        tau[m10] = (1 + mu * rho)[m10]
        tau[m11] = 1 - rho
        tau = np.clip(tau, 1e-10, None)

        ll = (
            stats.poisson.logpmf(x, lam)
            + stats.poisson.logpmf(y, mu)
            + np.log(tau)
        )
        return -np.sum(w * ll)

    x0 = np.concatenate([np.zeros(n_groups - 1), [0.2], [0.0]])
    bounds = [(-1.5, 1.5)] * (n_groups - 1) + [(-1, 1), (-0.2, 0.2)]

    result = minimize(
        negative_log_likelihood, x0, method="L-BFGS-B", bounds=bounds,
        options={"maxiter": 2000},
    )

    strengths, home_adv, rho = unpack(result.x)

    return {
        "strengths": dict(zip(data["groups"], strengths)),
        "home_advantage": float(home_adv),
        "rho": float(rho),
        "converged": bool(result.success),
        "log_likelihood": float(-result.fun),
    }


def bootstrap(data: dict, draws: int, seed: int = 42) -> dict[str, tuple]:
    """Percentile intervals by resampling matches.

    With three meetings behind some pairs, a point estimate on its own would
    overstate what the data supports. The interval is the honest version.
    """
    rng = np.random.default_rng(seed)
    samples: dict[str, list[float]] = {g: [] for g in data["groups"]}

    for _ in range(draws):
        counts = rng.multinomial(data["n"], np.full(data["n"], 1 / data["n"]))
        try:
            estimate = fit(data, weights=counts.astype(float))
        except Exception:  # noqa: BLE001 — a failed draw is dropped, not fatal
            continue
        for group, value in estimate["strengths"].items():
            samples[group].append(value)

    return {
        group: (
            float(np.percentile(values, 2.5)),
            float(np.percentile(values, 97.5)),
        )
        for group, values in samples.items()
        if values
    }


# --- Forecasting -------------------------------------------------------------


def forecast(
    upcoming: pd.DataFrame, model: dict, index: dict[str, dict]
) -> pd.DataFrame:
    strengths = model["strengths"]
    rows = []

    for match in upcoming.itertuples():
        home = resolve(match.home_team, index)
        away = resolve(match.away_team, index)

        gap = strengths.get(home["league"], 0.0) - strengths.get(away["league"], 0.0)

        lam = float(np.exp(home["attack"] - away["defense"] + model["home_advantage"] + gap))
        mu = float(np.exp(away["attack"] - home["defense"] - gap))

        p_home, p_draw, p_away = outcome_probs(lam, mu, model["rho"])
        matrix = score_matrix(lam, mu, model["rho"])
        likely = np.unravel_index(matrix.argmax(), matrix.shape)

        rows.append(
            {
                "match_id": match.match_id,
                "league": "cl",
                "date": match.utc_date.date().isoformat(),
                "matchday": match.matchday if pd.notna(match.matchday) else 0,
                "stage": match.stage,
                "home_team": match.home_team,
                "away_team": match.away_team,
                "home_league": home["league"],
                "away_league": away["league"],
                "xg_home": round(lam, 2),
                "xg_away": round(mu, 2),
                "p_home_win": round(p_home, 4),
                "p_draw": round(p_draw, 4),
                "p_away_win": round(p_away, 4),
                "most_likely_score": f"{likely[0]}-{likely[1]}",
                "prediction": ["H", "D", "A"][int(np.argmax([p_home, p_draw, p_away]))],
                "confidence": round(max(p_home, p_draw, p_away), 4),
                # Forecasts involving a pooled club rest on a coarser assumption
                # and are flagged so nothing downstream treats them as equal.
                "pooled_side": (home["league"] == REST) or (away["league"] == REST),
            }
        )

    if not rows:
        return pd.DataFrame()

    return pd.DataFrame(rows).sort_values("date").reset_index(drop=True)


def update_prediction_log(forecasts: pd.DataFrame, out_dir: Path) -> int:
    """Append-only: a forecast already logged is never rewritten."""
    path = out_dir / "prediction_log.csv"

    existing = pd.read_csv(path) if path.exists() else pd.DataFrame()
    known = set(existing["match_id"]) if not existing.empty else set()

    fresh = forecasts[~forecasts["match_id"].isin(known)].copy()
    if fresh.empty:
        logger.info("  Prediction log unchanged (%s entries).", len(known))
        return 0

    fresh["forecast_made_at"] = datetime.now(timezone.utc).date().isoformat()
    combined = pd.concat([existing, fresh], ignore_index=True) if not existing.empty else fresh
    combined.to_csv(path, index=False)

    logger.info("  Logged %s new forecast(s); %s total.", len(fresh), len(combined))
    return len(fresh)


# --- Entrypoint --------------------------------------------------------------


def label(group: str) -> str:
    if group == REST:
        return REST_LABEL
    for code in domestic_codes():
        if get_league(code).slug == group:
            return get_league(code).name
    return group


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit the cross-league model.")
    parser.add_argument("--competition", default=cup_codes()[0] if cup_codes() else "CL")
    parser.add_argument(
        "--bootstrap",
        type=int,
        default=500,
        help="Resamples for confidence intervals. 0 to skip.",
    )
    args = parser.parse_args()

    competition = get_league(args.competition)
    matches = load_competition(competition.slug)

    if matches.empty:
        logger.error(
            "No data for %s. Run: python src/ingestion/fetch_matches.py --league %s",
            competition.name,
            competition.code,
        )
        return 1

    index = build_team_index()
    logger.info("Rated teams: %s across %s leagues.", len(index), len(domestic_codes()))

    played = matches[
        (matches["status"] == "FINISHED")
        & matches["home_goals"].notna()
        & matches["away_goals"].notna()
    ].copy()
    upcoming = matches[matches["status"] != "FINISHED"].copy()

    # Same guard as the domestic script: fixtures left un-finished from an
    # earlier season would sort ahead of everything real.
    if not upcoming.empty:
        horizon = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=1)
        upcoming = upcoming[upcoming["utc_date"] >= horizon].copy()

    data = prepare(played, index)
    logger.info(
        "Fitting on %s of %s finished matches (%s excluded as same-group).",
        data["n"],
        len(played),
        len(played) - data["n"],
    )

    if data["n"] < 100:
        logger.error("Too few usable matches to estimate league strength.")
        return 1

    model = fit(data)
    logger.info(
        "Converged: %s | European home advantage %.3f (%.3fx) | rho %+.4f",
        model["converged"],
        model["home_advantage"],
        np.exp(model["home_advantage"]),
        model["rho"],
    )

    intervals: dict[str, tuple] = {}
    if args.bootstrap > 0:
        logger.info("Bootstrapping %s resamples...", args.bootstrap)
        intervals = bootstrap(data, args.bootstrap)

    print(f"\n{'=' * 70}")
    print(f"LEAGUE STRENGTH — relative to {label(REFERENCE)}")
    print("=" * 70)
    print(f"{'League':<20}{'strength':>10}{'goal ratio':>12}   95% interval")
    print("-" * 70)

    ordered = sorted(model["strengths"].items(), key=lambda kv: -kv[1])
    for group, value in ordered:
        ratio = np.exp(value)
        if group in intervals:
            low, high = intervals[group]
            span = f"[{low:+.3f}, {high:+.3f}]"
        else:
            span = "—"
        print(f"{label(group):<20}{value:>+10.3f}{ratio:>12.3f}   {span}")

    print("-" * 70)
    print(
        "A strength of +0.20 means a team from that league scores about "
        f"{np.exp(0.2):.2f}x\nas often as an equivalently-rated team from "
        f"{label(REFERENCE)}, all else equal."
    )

    out_dir = PREDICTIONS_DIR / competition.slug
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "competition": competition.slug,
        "reference": REFERENCE,
        "reference_name": label(REFERENCE),
        "matches_fitted": data["n"],
        "home_advantage": round(float(np.exp(model["home_advantage"])), 4),
        "home_advantage_log": round(model["home_advantage"], 4),
        "rho": round(model["rho"], 4),
        "bootstrap_draws": args.bootstrap,
        "strengths": [
            {
                "league": group,
                "name": label(group),
                "strength": round(value, 4),
                "goal_ratio": round(float(np.exp(value)), 4),
                "ci_low": round(intervals[group][0], 4) if group in intervals else None,
                "ci_high": round(intervals[group][1], 4) if group in intervals else None,
                "pooled": group == REST,
            }
            for group, value in ordered
        ],
        "fitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out_dir / "league_strengths.json").write_text(json.dumps(payload, indent=2))
    logger.info("Saved league strengths.")

    if upcoming.empty:
        logger.warning("No upcoming fixtures to forecast.")
    else:
        forecasts = forecast(upcoming, model, index)
        if forecasts.empty:
            logger.warning("No forecastable fixtures.")
        else:
            forecasts.to_csv(out_dir / "upcoming_forecasts.csv", index=False)
            pooled = int(forecasts["pooled_side"].sum())
            logger.info(
                "  Saved %s forecasts (%s involve a pooled club).",
                len(forecasts),
                pooled,
            )
            update_prediction_log(forecasts, out_dir)

    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())