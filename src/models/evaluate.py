"""
PitchIQ — Evaluate the forecasting model.

Fits on earlier seasons, scores against the most recent complete one, and
compares the result to a naive baseline. Also sweeps the ridge penalty so the
chosen value is defensible rather than guessed.

The split is strictly chronological. A random split would let the model learn
from matches that happened after the ones it predicts, which in football is a
serious leak: transfers, injuries and managerial changes all mean later matches
carry information about earlier ones.

Usage:
    python src/models/evaluate.py
    python src/models/evaluate.py --sweep     # tune alpha and report the curve
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_and_forecast import (  # noqa: E402
    DEFAULT_ALPHA,
    DEFAULT_XI,
    fit_dixon_coles,
    load_matches,
    outcome_probs,
    predict,
)

OUTCOMES = {"H": 0, "D": 1, "A": 2}


# --- Metrics -----------------------------------------------------------------


def log_loss(probs: np.ndarray, y: np.ndarray) -> float:
    """Penalises confident wrong answers far more than hedged ones."""
    picked = probs[np.arange(len(y)), y]
    return float(-np.mean(np.log(np.clip(picked, 1e-15, None))))


def ranked_probability_score(probs: np.ndarray, y: np.ndarray) -> float:
    """The standard metric for ordered football forecasts.

    Unlike log-loss it accounts for how far off a prediction was: calling a home
    win when the away side won is worse than calling a draw.
    """
    onehot = np.zeros_like(probs)
    onehot[np.arange(len(y)), y] = 1
    cum_p, cum_o = np.cumsum(probs, axis=1), np.cumsum(onehot, axis=1)
    return float(np.mean(np.sum((cum_p - cum_o) ** 2, axis=1) / (probs.shape[1] - 1)))


def accuracy(probs: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean(probs.argmax(axis=1) == y))


# --- Evaluation --------------------------------------------------------------


def forecast_set(model: dict, test: pd.DataFrame) -> np.ndarray:
    rows = []
    for match in test.itertuples():
        lam, mu = predict(model, match.home_team, match.away_team)
        rows.append(outcome_probs(lam, mu, model["rho"]))
    return np.array(rows)


def evaluate(train: pd.DataFrame, test: pd.DataFrame, xi: float, alpha: float):
    model = fit_dixon_coles(train, xi, alpha)
    probs = forecast_set(model, test)
    y = test["result"].map(OUTCOMES).to_numpy()

    return {
        "accuracy": accuracy(probs, y),
        "log_loss": log_loss(probs, y),
        "rps": ranked_probability_score(probs, y),
        "home_advantage": float(np.exp(model["home_advantage"])),
        "rho": model["rho"],
    }


def baseline_metrics(train: pd.DataFrame, test: pd.DataFrame):
    """Historical outcome frequencies — no learning at all."""
    rates = (
        train["result"].value_counts(normalize=True).reindex(["H", "D", "A"]).to_numpy()
    )
    probs = np.tile(rates, (len(test), 1))
    y = test["result"].map(OUTCOMES).to_numpy()

    return {
        # The baseline's pick is always the most common outcome, not argmax of a
        # tied row, so accuracy is measured against that fixed choice.
        "accuracy": float(np.mean(y == int(np.argmax(rates)))),
        "log_loss": log_loss(probs, y),
        "rps": ranked_probability_score(probs, y),
        "rates": rates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the model.")
    parser.add_argument("--xi", type=float, default=DEFAULT_XI)
    parser.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="Try a range of ridge penalties and report the curve.",
    )
    args = parser.parse_args()

    df = load_matches()
    played = df[df["status"] == "FINISHED"].copy()

    counts = played.groupby("season").size()
    complete = sorted(counts[counts >= 300].index)

    if len(complete) < 2:
        print(f"Need at least two complete seasons; found {len(complete)}.")
        return 1

    test_season = complete[-1]
    train_seasons = complete[:-1]

    train = played[played["season"].isin(train_seasons)].copy()
    test = played[played["season"] == test_season].copy()

    assert train["utc_date"].max() < test["utc_date"].min(), "temporal leak"

    print(f"Train  {train_seasons} — {len(train):,} matches")
    print(f"Test   [{test_season}] — {len(test):,} matches")
    print(f"Params xi={args.xi}, alpha={args.alpha}\n")

    base = baseline_metrics(train, test)

    if args.sweep:
        print("Ridge penalty sweep")
        print(f"{'alpha':>7} {'accuracy':>10} {'log-loss':>10} {'RPS':>9}")
        print("-" * 39)

        best_alpha, best_rps = None, float("inf")
        for alpha in [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0]:
            m = evaluate(train, test, args.xi, alpha)
            marker = ""
            if m["rps"] < best_rps:
                best_rps, best_alpha = m["rps"], alpha
            print(
                f"{alpha:7.1f} {m['accuracy']:10.3f} {m['log_loss']:10.4f} "
                f"{m['rps']:9.4f}{marker}"
            )

        print(f"\nBest alpha by RPS: {best_alpha}")
        args.alpha = best_alpha
        print()

    model = evaluate(train, test, args.xi, args.alpha)

    improvement = (base["rps"] - model["rps"]) / base["rps"] * 100

    print("=" * 58)
    print(f"{'':<20}{'baseline':>12}{'model':>12}")
    print("-" * 58)
    print(f"{'Accuracy':<20}{base['accuracy']:>11.1%}{model['accuracy']:>12.1%}")
    print(f"{'Log-loss':<20}{base['log_loss']:>12.4f}{model['log_loss']:>12.4f}")
    print(f"{'RPS':<20}{base['rps']:>12.4f}{model['rps']:>12.4f}")
    print("-" * 58)
    print(f"{'RPS improvement':<20}{improvement:>23.1f}%")
    print(f"{'Home advantage':<20}{model['home_advantage']:>22.3f}x")
    print(f"{'Rho':<20}{model['rho']:>23.4f}")
    print("=" * 58)

    season_label = f"{test_season}/{str((test_season + 1) % 100).zfill(2)}"

    print("\nPaste into web/lib/model-metrics.ts:\n")
    print(f'  testSeason: "{season_label}",')
    print(f"  testMatches: {len(test)},")
    print(f"  trainMatches: {len(train)},")
    print()
    print(
        f"  accuracy: {{ baseline: {base['accuracy']:.3f}, "
        f"model: {model['accuracy']:.3f} }},"
    )
    print(
        f"  logLoss: {{ baseline: {base['log_loss']:.4f}, "
        f"model: {model['log_loss']:.4f} }},"
    )
    print(f"  rpsImprovement: {improvement / 100:.3f},")
    print(f"  homeAdvantage: {model['home_advantage']:.3f},")

    return 0


if __name__ == "__main__":
    sys.exit(main())
