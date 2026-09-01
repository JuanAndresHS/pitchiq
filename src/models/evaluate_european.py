"""
PitchIQ — Evaluate the cross-league model.

Scoring the European model is harder than scoring a domestic one, because its
inputs come from two places. A naive evaluation would take the team ratings as
they stand today — fit on every domestic season, including ones played after the
European matches being predicted — and quietly hand the model information it
could not have had.

So this refits everything behind a cutoff. Domestic ratings are re-estimated
using only matches played before the test season began, league strengths are fit
only on earlier European matches, and the test season is forecast from that.
Slower than reusing the saved ratings, and the only version worth reporting.

Results are broken out by whether both clubs were individually rated or one came
from the pooled group, because those are different claims with different
reliability.

Usage:
    python src/models/evaluate_european.py
    python src/models/evaluate_european.py --season 2024
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from european_model import (  # noqa: E402
    REFERENCE,
    REST,
    fit,
    label,
    load_competition,
    outcome_probs,
    prepare,
    resolve,
)
from leagues import cup_codes, domestic_codes, get_league  # noqa: E402
from train_and_forecast import fit_dixon_coles  # noqa: E402
from train_and_forecast import load_matches as load_domestic  # noqa: E402

OUTCOMES = {"H": 0, "D": 1, "A": 2}
DEFAULT_XI = 0.002


# --- Metrics -----------------------------------------------------------------


def log_loss(probs: np.ndarray, y: np.ndarray) -> float:
    picked = probs[np.arange(len(y)), y]
    return float(-np.mean(np.log(np.clip(picked, 1e-15, None))))


def ranked_probability_score(probs: np.ndarray, y: np.ndarray) -> float:
    onehot = np.zeros_like(probs)
    onehot[np.arange(len(y)), y] = 1
    cum_p, cum_o = np.cumsum(probs, axis=1), np.cumsum(onehot, axis=1)
    return float(np.mean(np.sum((cum_p - cum_o) ** 2, axis=1) / (probs.shape[1] - 1)))


def accuracy(probs: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean(probs.argmax(axis=1) == y))


def summarise(probs: np.ndarray, y: np.ndarray) -> dict:
    return {
        "n": len(y),
        "accuracy": accuracy(probs, y),
        "log_loss": log_loss(probs, y),
        "rps": ranked_probability_score(probs, y),
    }


# --- Point-in-time ratings ---------------------------------------------------


def ratings_before(cutoff: pd.Timestamp) -> dict[str, dict]:
    """Refit every domestic league using only matches played before the cutoff.

    This is the expensive part of an honest evaluation. Reusing the saved
    ratings would let a team's European forecast benefit from domestic results
    that had not happened yet.
    """
    index: dict[str, dict] = {}

    for code in domestic_codes():
        league = get_league(code)

        try:
            df = load_domestic(league)
        except FileNotFoundError:
            continue

        played = df[(df["status"] == "FINISHED") & (df["utc_date"] < cutoff)].copy()
        if len(played) < 100:
            continue

        model = fit_dixon_coles(played, DEFAULT_XI, league.alpha)

        attack = np.asarray(model["attack"])
        defense = np.asarray(model["defense"])
        mean_attack, mean_defense = attack.mean(), defense.mean()

        for i, team in enumerate(model["teams"]):
            index[team] = {
                "league": league.slug,
                "attack": float(attack[i] - mean_attack),
                "defense": float(defense[i] - mean_defense),
            }

    return index


# --- Evaluation --------------------------------------------------------------


def forecast_probs(matches: pd.DataFrame, model: dict, index: dict) -> np.ndarray:
    strengths = model["strengths"]
    rows = []

    for match in matches.itertuples():
        home = resolve(match.home_team, index)
        away = resolve(match.away_team, index)
        gap = strengths.get(home["league"], 0.0) - strengths.get(away["league"], 0.0)

        lam = float(
            np.exp(home["attack"] - away["defense"] + model["home_advantage"] + gap)
        )
        mu = float(np.exp(away["attack"] - home["defense"] - gap))
        rows.append(outcome_probs(lam, mu, model["rho"]))

    return np.array(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the cross-league model.")
    parser.add_argument("--competition", default=cup_codes()[0] if cup_codes() else "CL")
    parser.add_argument(
        "--season",
        type=int,
        default=None,
        help="Season to hold out. Defaults to the most recent complete one.",
    )
    args = parser.parse_args()

    competition = get_league(args.competition)
    matches = load_competition(competition.slug)

    if matches.empty:
        print(f"No data for {competition.name}.")
        return 1

    played = matches[
        (matches["status"] == "FINISHED")
        & matches["home_goals"].notna()
        & matches["away_goals"].notna()
    ].copy()

    counts = played.groupby("season").size()
    # A European season is complete once most of it has been played; the exact
    # count varies with format changes, so this is deliberately loose.
    complete = sorted(counts[counts >= 100].index)

    if len(complete) < 2:
        print(f"Need at least two complete seasons; found {len(complete)}.")
        return 1

    test_season = args.season or complete[-1]
    if test_season not in complete:
        print(f"Season {test_season} is not complete. Available: {complete}")
        return 1

    test = played[played["season"] == test_season].copy()
    train = played[played["season"] < test_season].copy()

    if train.empty:
        print("No earlier seasons to train on.")
        return 1

    cutoff = test["utc_date"].min()

    print(f"{'=' * 70}")
    print(f"{competition.name} — held-out {test_season}")
    print("=" * 70)
    print(f"Train   seasons {sorted(int(s) for s in train['season'].unique())} — {len(train)} matches")
    print(f"Test    season  {test_season} — {len(test)} matches")
    print(f"Cutoff  {cutoff.date()} (domestic ratings refit to this date)")

    print("\nRefitting domestic models behind the cutoff...")
    index = ratings_before(cutoff)
    print(f"  {len(index)} teams rated from pre-cutoff data.")

    train_data = prepare(train, index)
    print(f"  Fitting league strengths on {train_data['n']} European matches.")
    model = fit(train_data)

    print(f"\nLeague strength, relative to {label(REFERENCE)}:")
    for group, value in sorted(model["strengths"].items(), key=lambda kv: -kv[1]):
        print(f"  {label(group):<20}{value:>+8.3f}")
    print(f"\n  European home advantage {np.exp(model['home_advantage']):.3f}x")

    # --- Score -------------------------------------------------------------
    y = test["result"].map(OUTCOMES).to_numpy()
    probs = forecast_probs(test, model, index)

    # Baseline: outcome frequencies from the training seasons. European football
    # draws less often than domestic, so a domestic baseline would flatter this.
    rates = (
        train["result"].value_counts(normalize=True).reindex(["H", "D", "A"]).to_numpy()
    )
    base_probs = np.tile(rates, (len(test), 1))

    model_metrics = summarise(probs, y)
    base_metrics = summarise(base_probs, y)
    base_metrics["accuracy"] = float(np.mean(y == int(np.argmax(rates))))

    print(f"\n{'-' * 70}")
    print(f"{'':<18}{'baseline':>12}{'model':>12}")
    print("-" * 42)
    print(f"{'Accuracy':<18}{base_metrics['accuracy']:>11.1%}{model_metrics['accuracy']:>12.1%}")
    print(f"{'Log-loss':<18}{base_metrics['log_loss']:>12.4f}{model_metrics['log_loss']:>12.4f}")
    print(f"{'RPS':<18}{base_metrics['rps']:>12.4f}{model_metrics['rps']:>12.4f}")
    print("-" * 42)

    improvement = (base_metrics["rps"] - model_metrics["rps"]) / base_metrics["rps"] * 100
    print(f"{'RPS improvement':<18}{improvement:>23.1f}%")

    # --- Split by how much the model actually knew --------------------------
    pooled_mask = np.array(
        [
            resolve(m.home_team, index)["league"] == REST
            or resolve(m.away_team, index)["league"] == REST
            for m in test.itertuples()
        ]
    )

    print(f"\n{'=' * 70}")
    print("BY CONFIDENCE IN THE INPUTS")
    print("=" * 70)

    for mask, name in [(~pooled_mask, "Both clubs rated"), (pooled_mask, "One club pooled")]:
        if mask.sum() == 0:
            continue
        section = summarise(probs[mask], y[mask])
        print(
            f"{name:<20}n={section['n']:<5}"
            f"acc {section['accuracy']:>6.1%}   "
            f"log-loss {section['log_loss']:.4f}   "
            f"RPS {section['rps']:.4f}"
        )

    if pooled_mask.sum() and (~pooled_mask).sum():
        rated = summarise(probs[~pooled_mask], y[~pooled_mask])
        pooled = summarise(probs[pooled_mask], y[pooled_mask])
        gap = pooled["rps"] - rated["rps"]
        print(
            f"\n  Pooled fixtures score {gap:+.4f} RPS versus fully rated ones."
        )
        print(
            "  Treating every club from a smaller league as identical is the\n"
            "  model's coarsest assumption, and this is what it costs."
        )

    print(f"\n{'=' * 70}")
    print("Paste into web/lib/model-metrics.ts:\n")
    print("export const EUROPEAN_METRICS = {")
    print(f'  testSeason: "{test_season}/{str((test_season + 1) % 100).zfill(2)}",')
    print(f"  testMatches: {model_metrics['n']},")
    print(f"  trainMatches: {train_data['n']},")
    print(
        f"  accuracy: {{ baseline: {base_metrics['accuracy']:.3f}, "
        f"model: {model_metrics['accuracy']:.3f} }},"
    )
    print(
        f"  logLoss: {{ baseline: {base_metrics['log_loss']:.4f}, "
        f"model: {model_metrics['log_loss']:.4f} }},"
    )
    print(f"  rpsImprovement: {improvement / 100:.3f},")
    print(f"  homeAdvantage: {np.exp(model['home_advantage']):.3f},")
    print("} as const;")

    return 0


if __name__ == "__main__":
    sys.exit(main())
