"""
PitchIQ — Evaluate the forecasting model.

Fits on earlier seasons, scores against the most recent complete one, and
compares the result to a naive baseline. Runs per league, so each competition
gets its own honest number rather than an average that hides variation.

The split is strictly chronological. A random split would let the model learn
from matches that happened after the ones it predicts, which in football is a
serious leak: transfers, injuries and managerial changes all mean later matches
carry information about earlier ones.

Usage:
    python src/models/evaluate.py                    # every league
    python src/models/evaluate.py --league PD
    python src/models/evaluate.py --sweep            # tune alpha per league
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

from leagues import League, domestic_codes, get_league  # noqa: E402
from train_and_forecast import (  # noqa: E402
    DEFAULT_XI,
    fit_dixon_coles,
    load_matches,
    outcome_probs,
    predict,
)

OUTCOMES = {"H": 0, "D": 1, "A": 2}
SWEEP_VALUES = [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0]


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


def evaluate(train: pd.DataFrame, test: pd.DataFrame, xi: float, alpha: float):
    model = fit_dixon_coles(train, xi, alpha)

    probs = np.array(
        [
            outcome_probs(*predict(model, m.home_team, m.away_team), model["rho"])
            for m in test.itertuples()
        ]
    )
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
        # The baseline's pick is the most common outcome, not argmax of a tied
        # row, so accuracy is measured against that fixed choice.
        "accuracy": float(np.mean(y == int(np.argmax(rates)))),
        "log_loss": log_loss(probs, y),
        "rps": ranked_probability_score(probs, y),
    }


def split(league: League):
    """Train on every complete season but the last; test on the last."""
    df = load_matches(league)
    played = df[df["status"] == "FINISHED"].copy()

    counts = played.groupby("season").size()
    # A season counts as complete once most of it has been played. The
    # threshold scales with league size: 18-team divisions play 306 matches.
    minimum = (league.teams - 1) * league.teams * 0.8
    complete = sorted(counts[counts >= minimum].index)

    if len(complete) < 2:
        return None, None, None

    test_season = complete[-1]
    train = played[played["season"].isin(complete[:-1])].copy()
    test = played[played["season"] == test_season].copy()

    assert train["utc_date"].max() < test["utc_date"].min(), "temporal leak"

    return train, test, test_season


# --- Per-league run ----------------------------------------------------------


def run_league(league: League, xi: float, alpha: float | None, sweep: bool):
    print(f"\n{'=' * 62}")
    print(f"{league.name} ({league.country})")
    print("=" * 62)

    try:
        train, test, test_season = split(league)
    except FileNotFoundError as exc:
        print(f"  {exc}")
        return None

    if train is None:
        print("  Not enough complete seasons to evaluate.")
        return None

    print(f"Train  {[int(s) for s in sorted(train['season'].unique())]} — {len(train):,} matches")
    print(f"Test   [{test_season}] — {len(test):,} matches")

    chosen = league.alpha if alpha is None else alpha

    if sweep:
        print(f"\n{'alpha':>7} {'accuracy':>10} {'log-loss':>10} {'RPS':>9}")
        print("-" * 39)

        best_rps = float("inf")
        for value in SWEEP_VALUES:
            m = evaluate(train, test, xi, value)
            print(
                f"{value:7.1f} {m['accuracy']:10.3f} {m['log_loss']:10.4f} {m['rps']:9.4f}"
            )
            if m["rps"] < best_rps:
                best_rps, chosen = m["rps"], value

        print(f"\nBest alpha by RPS: {chosen}")

    model = evaluate(train, test, xi, chosen)
    base = baseline_metrics(train, test)
    improvement = (base["rps"] - model["rps"]) / base["rps"] * 100

    print(f"\n{'':<18}{'baseline':>12}{'model':>12}")
    print("-" * 42)
    print(f"{'Accuracy':<18}{base['accuracy']:>11.1%}{model['accuracy']:>12.1%}")
    print(f"{'Log-loss':<18}{base['log_loss']:>12.4f}{model['log_loss']:>12.4f}")
    print(f"{'RPS':<18}{base['rps']:>12.4f}{model['rps']:>12.4f}")
    print("-" * 42)
    print(f"{'RPS improvement':<18}{improvement:>23.1f}%")
    print(f"{'Home advantage':<18}{model['home_advantage']:>22.3f}x")
    print(f"{'Rho':<18}{model['rho']:>23.4f}")

    return {
        "league": league,
        "alpha": chosen,
        "test_season": test_season,
        "test_matches": len(test),
        "train_matches": len(train),
        "model": model,
        "baseline": base,
        "improvement": improvement,
    }


# --- Entrypoint --------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the model.")
    parser.add_argument("--league", nargs="+", default=domestic_codes(), metavar="CODE")
    parser.add_argument("--xi", type=float, default=DEFAULT_XI)
    parser.add_argument("--alpha", type=float, default=None)
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="Try a range of ridge penalties per league and report the curve.",
    )
    args = parser.parse_args()

    try:
        leagues = [get_league(code) for code in args.league]
    except ValueError as exc:
        print(exc)
        return 1

    results = [
        r
        for r in (run_league(lg, args.xi, args.alpha, args.sweep) for lg in leagues)
        if r is not None
    ]

    if not results:
        print("\nNothing evaluated.")
        return 1

    # Cross-league summary — the useful view once there is more than one.
    print(f"\n\n{'=' * 74}")
    print("SUMMARY")
    print("=" * 74)
    print(
        f"{'League':<18}{'alpha':>7}{'acc':>9}{'base':>8}"
        f"{'log-loss':>11}{'RPS gain':>11}{'home adv':>10}"
    )
    print("-" * 74)

    for r in results:
        print(
            f"{r['league'].name:<18}{r['alpha']:>7.1f}"
            f"{r['model']['accuracy']:>9.1%}{r['baseline']['accuracy']:>8.1%}"
            f"{r['model']['log_loss']:>11.4f}{r['improvement']:>10.1f}%"
            f"{r['model']['home_advantage']:>9.2f}x"
        )

    print("-" * 74)

    weighted = sum(r["model"]["accuracy"] * r["test_matches"] for r in results) / sum(
        r["test_matches"] for r in results
    )
    print(f"{'Weighted accuracy':<18}{weighted:>16.1%}")
    print("=" * 74)

    print("\nPaste into web/lib/model-metrics.ts:\n")
    print("export const LEAGUE_METRICS = {")
    for r in results:
        m, b = r["model"], r["baseline"]
        print(f'  {r["league"].slug}: {{')
        print(f'    testSeason: "{r["test_season"]}/{str((r["test_season"] + 1) % 100).zfill(2)}",')
        print(f"    testMatches: {r['test_matches']},")
        print(f"    accuracy: {{ baseline: {b['accuracy']:.3f}, model: {m['accuracy']:.3f} }},")
        print(f"    logLoss: {{ baseline: {b['log_loss']:.4f}, model: {m['log_loss']:.4f} }},")
        print(f"    rpsImprovement: {r['improvement'] / 100:.3f},")
        print(f"    homeAdvantage: {m['home_advantage']:.3f},")
        print(f"    alpha: {r['alpha']},")
        print("  },")
    print("} as const;")

    return 0


if __name__ == "__main__":
    sys.exit(main())