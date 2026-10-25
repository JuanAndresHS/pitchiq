"""
PitchIQ — Benchmark the model against the betting market.

The project's headline number — 51.2% accuracy, RPS 8-14% better than baseline —
is measured against a baseline that does no work at all: it predicts the
historical frequency of home wins, draws and away wins for every fixture. Beating
that proves the model learned something, but says nothing about whether what it
learned is any good.

The betting market is the honest yardstick. Closing odds aggregate team news,
lineups, injuries, weather and the judgement of people with money at stake. No
goals-only model is going to beat them. The useful question is how close it gets,
and that distance is a measurement of what the model does not know.

This runs offline, by hand, once or twice a season. It is deliberately NOT part
of the automated pipeline: it depends on a second data source, and nothing that
can break belongs on the path that keeps the site alive.

Data: football-data.co.uk publishes one CSV per division per season, including
closing odds. Free for non-commercial use. When that site is unreachable — it
was, from two different networks, the day this was written — the download falls
back to a GitHub mirror of the same files.

A mirror is somebody else's copy, so it is not taken on faith: every scoreline
it supplies is checked against our own independently ingested results, and the
agreement count is reported and stored alongside the metrics. Odds that came
with 380 verified scorelines are odds worth quoting.

Usage:
    python src/models/benchmark_market.py --download   # fetch the odds CSVs
    python src/models/benchmark_market.py --audit      # check name matching
    python src/models/benchmark_market.py              # the comparison
    python src/models/benchmark_market.py --league PD --devig power
"""

from __future__ import annotations

import argparse
import difflib
import json
import logging
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy import optimize

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from leagues import League, domestic_codes, get_league  # noqa: E402
from train_and_forecast import (  # noqa: E402
    DEFAULT_XI,
    fit_dixon_coles,
    outcome_probs,
    predict,
)
from evaluate import (  # noqa: E402
    OUTCOMES,
    accuracy,
    log_loss,
    ranked_probability_score,
    split,
)

ODDS_DIR = PROJECT_ROOT / "data" / "external" / "odds"
ALIAS_FILE = PROJECT_ROOT / "data" / "external" / "team_aliases.json"
OUTPUT_FILE = PROJECT_ROOT / "data" / "predictions" / "market_benchmark.json"

OFFICIAL_URL = "https://www.football-data.co.uk/mmz4281"

# A community mirror of the same files, laid out by league name rather than
# division code. Used when the official site cannot be reached; everything it
# supplies is verified against our own data before it counts.
MIRROR_URL = (
    "https://raw.githubusercontent.com/"
    "huhao930422-debug/football-odds-mirror/main/data"
)

# football-data.co.uk's division codes, against our own league codes.
DIVISIONS = {
    "PL": "E0",
    "PD": "SP1",
    "SA": "I1",
    "BL1": "D1",
    "FL1": "F1",
}

MIRROR_FOLDERS = {
    "PL": "premier-league",
    "PD": "la-liga",
    "SA": "serie-a",
    "BL1": "bundesliga",
    "FL1": "ligue-1",
}

# Odds columns, best first. Closing odds beat opening ones — they carry the
# team news — and Pinnacle beats the high-street books, which shade their prices
# towards where the public money is. Each season's file carries a slightly
# different set, so the first available triple wins rather than one hardcoded
# choice that breaks on an older file.
ODDS_PREFERENCE = [
    ("PSCH", "PSCD", "PSCA", "Pinnacle closing"),
    ("AvgCH", "AvgCD", "AvgCA", "market average closing"),
    ("B365CH", "B365CD", "B365CA", "Bet365 closing"),
    ("PSH", "PSD", "PSA", "Pinnacle opening"),
    ("AvgH", "AvgD", "AvgA", "market average opening"),
    ("B365H", "B365D", "B365A", "Bet365 opening"),
    ("BbAvH", "BbAvD", "BbAvA", "Betbrain average"),
]

# Words that say what kind of club something is, not which club it is. Stripped
# from both vocabularies before matching, since one source writes "Manchester
# City FC" and the other "Man City".
NOISE = {
    "fc", "cf", "ac", "sc", "bc", "ss", "as", "us", "ud", "sd", "cd", "ca",
    "rc", "sv", "vfl", "vfb", "tsg", "fsv", "afc", "ogc", "rcd", "acf", "ssc",
    "cfc", "sk", "fk", "club", "calcio", "futbol", "football", "balompie",
    "deportivo", "real", "de", "d", "the",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.benchmark")


# --- Download ----------------------------------------------------------------


def season_folder(season: int) -> str:
    """2025 (the 2025/26 season) becomes '2526', the site's folder name."""
    return f"{season % 100:02d}{(season + 1) % 100:02d}"


def sources_for(league: League, season: int, source: str) -> list[tuple[str, str]]:
    """Where to look for one league-season, best source first."""
    official = (
        "football-data.co.uk",
        f"{OFFICIAL_URL}/{season_folder(season)}/{DIVISIONS[league.code]}.csv",
    )
    mirror = (
        "GitHub mirror",
        f"{MIRROR_URL}/{MIRROR_FOLDERS[league.code]}/season-{season_folder(season)}.csv",
    )

    if source == "official":
        return [official]
    if source == "mirror":
        return [mirror]
    return [official, mirror]


def download(
    league: League, season: int, refresh: bool = False, source: str = "auto"
) -> Path | None:
    if league.code not in DIVISIONS:
        logger.warning("No odds coverage for %s — skipped.", league.name)
        return None

    ODDS_DIR.mkdir(parents=True, exist_ok=True)
    path = ODDS_DIR / f"{league.slug}_{season}.csv"

    if path.exists() and not refresh:
        logger.info("%s %s already downloaded.", league.name, season)
        return path

    for label, url in sources_for(league, season, source):
        logger.info("Trying %s: %s", label, url)
        try:
            # A browser-like agent: the official site serves a block page to
            # bare scrapers. The timeout is short because the fallback is the
            # point — waiting 30s on a host that is down helps nobody.
            response = requests.get(
                url,
                timeout=15,
                headers={"User-Agent": "Mozilla/5.0 (PitchIQ research)"},
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            logger.warning("%s unavailable: %s", label, type(exc).__name__)
            continue

        if b"HomeTeam" not in response.content[:2000]:
            logger.warning(
                "%s returned something that is not a match CSV — the season may "
                "not be published there yet.",
                label,
            )
            continue

        path.write_bytes(response.content)
        logger.info(
            "Saved %s (%.0f KB) from %s", path.name, len(response.content) / 1024, label
        )
        return path

    logger.error("No source had %s %s.", league.name, season)
    return None


# --- Team names --------------------------------------------------------------


def normalise(name: str) -> str:
    """Reduce a club name to the part that identifies it.

    Accents, punctuation, founding years and club-type words all differ between
    the two sources and none of them disambiguate anything.
    """
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\b(1[89]\d{2}|19\d{2}|20\d{2})\b", " ", text)

    tokens = [t for t in text.split() if t and t not in NOISE]
    return " ".join(tokens) if tokens else text.strip()


def prefix_score(short: str, long: str) -> float:
    """How well an abbreviated name maps onto a full one.

    "man city" against "manchester city": every token of the short name starts
    a token of the long one, in order. difflib alone rates that pairing poorly
    because it counts the missing letters; this is what rescues it.
    """
    short_tokens, long_tokens = short.split(), long.split()
    if not short_tokens or len(short_tokens) > len(long_tokens):
        return 0.0

    position = 0
    for token in short_tokens:
        while position < len(long_tokens) and not long_tokens[position].startswith(
            token
        ):
            position += 1
        if position == len(long_tokens):
            return 0.0
        position += 1

    # Full coverage of the long name scores higher than a partial hit.
    return 0.80 + 0.15 * (len(short_tokens) / len(long_tokens))


def resolve_names(
    market_names: list[str], our_names: list[str], aliases: dict[str, str]
) -> tuple[dict[str, str], list[str]]:
    """Map the market's team names onto ours.

    Returns the mapping and whatever it could not resolve. Manual aliases always
    win: once a name is pinned by hand it is never second-guessed.
    """
    lookup = {normalise(name): name for name in our_names}
    mapping: dict[str, str] = {}
    unresolved: list[str] = []

    for name in market_names:
        if name in aliases:
            mapping[name] = aliases[name]
            continue

        key = normalise(name)

        if key in lookup:
            mapping[name] = lookup[key]
            continue

        best, best_score = None, 0.0
        for candidate_key, candidate in lookup.items():
            score = max(
                difflib.SequenceMatcher(None, key, candidate_key).ratio(),
                prefix_score(key, candidate_key),
            )
            if score > best_score:
                best, best_score = candidate, score

        # 0.80 keeps "Ath Madrid" → "Atlético de Madrid" while refusing
        # "Ath Bilbao" → "Athletic Club", which shares a prefix and nothing else.
        if best is not None and best_score >= 0.80:
            mapping[name] = best
        else:
            unresolved.append(name)

    return mapping, unresolved


def load_aliases() -> dict[str, dict[str, str]]:
    if not ALIAS_FILE.exists():
        return {}
    try:
        return json.loads(ALIAS_FILE.read_text(encoding="utf8"))
    except json.JSONDecodeError as exc:
        logger.error("team_aliases.json is not valid JSON: %s", exc)
        return {}


def write_alias_stubs(league: League, unresolved: list[str]) -> None:
    """Leave blank entries for the names a human has to settle."""
    aliases = load_aliases()
    section = aliases.setdefault(league.slug, {})
    for name in unresolved:
        section.setdefault(name, "")

    ALIAS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ALIAS_FILE.write_text(
        json.dumps(aliases, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf8",
    )
    logger.info("Wrote %s stub(s) to %s", len(unresolved), ALIAS_FILE.name)


# --- Market probabilities ----------------------------------------------------


def pick_odds_columns(frame: pd.DataFrame) -> tuple[list[str], str, float] | None:
    """Choose the sharpest odds that actually priced the whole season.

    Presence of a column is not the same as coverage of it. Pinnacle stopped
    appearing in these files partway through 2025/26: the columns are still
    there, empty from January on. Preferring them on name alone silently halved
    the sample — the metrics still printed, computed on whichever fixtures
    happened to survive, which is the worst kind of bug because it looks fine.
    """
    best: tuple[list[str], str, float] | None = None

    for home, draw, away, label in ODDS_PREFERENCE:
        if not all(column in frame.columns for column in (home, draw, away)):
            continue

        covered = int(frame[[home, draw, away]].notna().all(axis=1).sum())
        share = covered / len(frame) if len(frame) else 0.0

        if share >= 0.95:
            return [home, draw, away], label, share

        if best is None or share > best[2]:
            best = ([home, draw, away], label, share)

    return best


def devig(odds: np.ndarray, method: str = "proportional") -> np.ndarray:
    """Turn decimal odds into probabilities that sum to one.

    Raw implied probabilities sum to about 1.05: the excess is the bookmaker's
    margin, and it has to come out before the prices can be compared with a
    model's.

    proportional — divide by the sum. Simple, and the usual choice. It assumes
        the margin is spread evenly, which is not quite true: books load more of
        it onto longshots, so this method flatters the outsider.
    power — find k with sum(p^k) = 1. Takes more margin off the longshots, which
        matches how prices are actually set, at the cost of a root-find per match.
    """
    raw = 1.0 / odds

    if method == "proportional":
        return raw / raw.sum(axis=1, keepdims=True)

    out = np.empty_like(raw)
    for i, row in enumerate(raw):
        try:
            k = optimize.brentq(lambda k: np.sum(row**k) - 1.0, 0.5, 3.0)
            out[i] = row**k
        except (ValueError, RuntimeError):
            out[i] = row / row.sum()
    return out


# --- Join --------------------------------------------------------------------


def prepare_market(
    path: Path, mapping: dict[str, str], devig_method: str
) -> tuple[pd.DataFrame, str] | None:
    frame = pd.read_csv(path, encoding="latin-1")
    frame = frame.dropna(subset=["HomeTeam", "AwayTeam"])

    chosen = pick_odds_columns(frame)
    if chosen is None:
        logger.error("%s carries no odds columns this script knows.", path.name)
        return None

    columns, label, share = chosen
    if share < 0.95:
        logger.warning(
            "Best available odds (%s) only price %.0f%% of the season.",
            label,
            share * 100,
        )
    frame = frame.dropna(subset=columns)

    odds = frame[columns].astype(float).to_numpy()
    if (odds <= 1.0).any():
        logger.warning("Dropping %s row(s) with impossible odds.", int((odds <= 1.0).any(axis=1).sum()))
        keep = (odds > 1.0).all(axis=1)
        frame, odds = frame[keep], odds[keep]

    probs = devig(odds, devig_method)

    out = pd.DataFrame(
        {
            "home_team": frame["HomeTeam"].map(mapping),
            "away_team": frame["AwayTeam"].map(mapping),
            "market_date": pd.to_datetime(
                frame["Date"], dayfirst=True, errors="coerce"
            ),
            # Carried purely so the scorelines can be checked against ours. The
            # odds are the only thing this file is trusted for.
            "market_home_goals": pd.to_numeric(
                frame.get("FTHG"), errors="coerce"
            ),
            "market_away_goals": pd.to_numeric(
                frame.get("FTAG"), errors="coerce"
            ),
            "p_home": probs[:, 0],
            "p_draw": probs[:, 1],
            "p_away": probs[:, 2],
        }
    ).dropna(subset=["home_team", "away_team"])

    return out, label


def verify_scorelines(merged: pd.DataFrame) -> tuple[int, int]:
    """Check the odds file's results against our own ingestion.

    Two independent paths to the same scoreline. Agreement does not prove the
    odds are genuine, but a file that gets 380 results right is not a fabricated
    one, and a disagreement means the join paired the wrong fixtures — which
    would quietly corrupt every number downstream.
    """
    checked = merged.dropna(subset=["market_home_goals", "market_away_goals"])
    if checked.empty:
        return 0, 0

    disagree = (
        checked["home_goals"].astype(float) != checked["market_home_goals"]
    ) | (checked["away_goals"].astype(float) != checked["market_away_goals"])

    return int(len(checked) - disagree.sum()), int(disagree.sum())


def join(test: pd.DataFrame, market: pd.DataFrame) -> pd.DataFrame:
    """Pair each test fixture with its market price.

    Joined on the two clubs rather than on the date: a league season plays each
    ordered pair exactly once, so the pairing is unique, and it survives the
    kick-off being moved — which happens often and would silently drop matches
    from a date-based join.
    """
    merged = test.merge(market, on=["home_team", "away_team"], how="inner")

    # A pairing that lands a fortnight from where we expected is a name
    # collision, not a rescheduled match.
    gap = (merged["utc_date"].dt.tz_localize(None) - merged["market_date"]).abs()
    suspicious = gap > pd.Timedelta(days=14)
    if suspicious.any():
        logger.warning(
            "Dropping %s fixture(s) whose dates disagree by more than a "
            "fortnight — likely a bad name match.",
            int(suspicious.sum()),
        )
        merged = merged[~suspicious]

    return merged


# --- Comparison --------------------------------------------------------------


def model_probabilities(
    train: pd.DataFrame, fixtures: pd.DataFrame, league: League
) -> np.ndarray:
    model = fit_dixon_coles(train, DEFAULT_XI, league.alpha)
    return np.array(
        [
            outcome_probs(*predict(model, row.home_team, row.away_team), model["rho"])
            for row in fixtures.itertuples()
        ]
    )


def metrics(probs: np.ndarray, y: np.ndarray) -> dict:
    return {
        "accuracy": accuracy(probs, y),
        "log_loss": log_loss(probs, y),
        "rps": ranked_probability_score(probs, y),
    }


def baseline_probabilities(train: pd.DataFrame, n: int) -> np.ndarray:
    rates = (
        train["result"].value_counts(normalize=True).reindex(["H", "D", "A"]).to_numpy()
    )
    return np.tile(rates, (n, 1))


def run_league(league: League, devig_method: str, audit: bool) -> dict | None:
    train, test, test_season = split(league)
    if train is None:
        logger.warning("%s has too little history to evaluate.", league.name)
        return None

    path = ODDS_DIR / f"{league.slug}_{test_season}.csv"
    if not path.exists():
        logger.error(
            "No odds for %s %s. Run with --download first.", league.name, test_season
        )
        return None

    raw = pd.read_csv(path, encoding="latin-1").dropna(subset=["HomeTeam"])
    aliases = load_aliases().get(league.slug, {})
    aliases = {k: v for k, v in aliases.items() if v}  # blank stubs are unresolved

    our_names = sorted(set(test["home_team"]) | set(test["away_team"]))
    mapping, unresolved = resolve_names(
        sorted(set(raw["HomeTeam"]) | set(raw["AwayTeam"])), our_names, aliases
    )

    print(f"\n{'=' * 66}")
    print(f"{league.name} — {test_season}/{(test_season + 1) % 100:02d}")
    print("=" * 66)

    if audit or unresolved:
        print(f"  Teams in our data      {len(our_names)}")
        print(f"  Matched automatically  {len(mapping) - len(aliases)}")
        print(f"  Pinned by hand         {len(aliases)}")
        print(f"  Unresolved             {len(unresolved)}")

    if unresolved:
        print("\n  Could not match these market names:")
        for name in unresolved:
            suggestion = difflib.get_close_matches(
                normalise(name), [normalise(n) for n in our_names], n=1, cutoff=0.3
            )
            hint = ""
            if suggestion:
                for candidate in our_names:
                    if normalise(candidate) == suggestion[0]:
                        hint = f"   (closest: {candidate})"
                        break
            print(f"    {name:<24}{hint}")
        write_alias_stubs(league, unresolved)
        print(f"\n  Fill these in {ALIAS_FILE.relative_to(PROJECT_ROOT)} and re-run.")

    if audit:
        return None

    prepared = prepare_market(path, mapping, devig_method)
    if prepared is None:
        return None
    market, odds_label = prepared

    merged = join(test, market)
    if merged.empty:
        logger.error("Nothing joined for %s.", league.name)
        return None

    agree, disagree = verify_scorelines(merged)
    if disagree:
        logger.warning(
            "%s scoreline(s) in the odds file disagree with our own results. "
            "That points at a bad team-name match, not a bad result.",
            disagree,
        )

    coverage = len(merged) / len(test)
    y = merged["result"].map(OUTCOMES).to_numpy()

    market_probs = merged[["p_home", "p_draw", "p_away"]].to_numpy()
    model_probs = model_probabilities(train, merged, league)
    base_probs = baseline_probabilities(train, len(merged))

    result = {
        "league": league.slug,
        "name": league.name,
        "test_season": int(test_season),
        "matches": int(len(merged)),
        "coverage": round(coverage, 4),
        "odds": odds_label,
        "devig": devig_method,
        "scorelines_verified": agree,
        "scorelines_disagreeing": disagree,
        "baseline": metrics(base_probs, y),
        "model": metrics(model_probs, y),
        "market": metrics(market_probs, y),
    }

    # How much of the distance from doing nothing to the market the model covers.
    # A single number for "is this model actually any good", on a scale where 0
    # is the naive baseline and 1 is the closing line.
    spread = result["baseline"]["rps"] - result["market"]["rps"]
    result["skill_closed"] = (
        round((result["baseline"]["rps"] - result["model"]["rps"]) / spread, 4)
        if spread > 0
        else None
    )

    print(f"\n  Odds        {odds_label}, margin removed {devig_method}ly")
    print(f"  Matches     {len(merged)} of {len(test)} ({coverage:.0%} matched)")
    print(
        f"  Scorelines  {agree} agree with our own data"
        + (f", {disagree} DISAGREE" if disagree else "")
    )
    print()
    print(f"  {'':<12}{'baseline':>12}{'model':>12}{'market':>12}")
    print("  " + "-" * 48)
    for metric, fmt in (("accuracy", "{:.1%}"), ("log_loss", "{:.4f}"), ("rps", "{:.4f}")):
        row = "".join(
            fmt.format(result[who][metric]).rjust(12)
            for who in ("baseline", "model", "market")
        )
        print(f"  {metric:<12}{row}")
    print("  " + "-" * 48)

    gap = result["model"]["rps"] - result["market"]["rps"]
    print(f"  {'RPS gap':<12}{gap:>+36.4f}   (model minus market)")
    if result["skill_closed"] is not None:
        print(f"  {'Skill closed':<12}{result['skill_closed']:>36.1%}   (baseline → market)")

    return result


# --- CLI ---------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare the model against bookmakers' closing odds."
    )
    parser.add_argument("--league", help="League code, e.g. PL. Default: all.")
    parser.add_argument(
        "--download", action="store_true", help="Fetch the odds CSVs first."
    )
    parser.add_argument(
        "--refresh", action="store_true", help="Re-download files already on disk."
    )
    parser.add_argument(
        "--audit",
        action="store_true",
        help="Report team-name matching and stop, without computing metrics.",
    )
    parser.add_argument(
        "--devig",
        choices=["proportional", "power"],
        default="proportional",
        help="How to strip the bookmaker's margin. Default: proportional.",
    )
    parser.add_argument(
        "--source",
        choices=["auto", "official", "mirror"],
        default="auto",
        help="Where to download from. Default: the official site, then the mirror.",
    )
    args = parser.parse_args()

    codes = [args.league.upper()] if args.league else domestic_codes()
    leagues = []
    for code in codes:
        league = get_league(code)
        if league.code not in DIVISIONS:
            if args.league:
                logger.error("%s has no odds coverage.", league.name)
                return 1
            continue  # Portugal and the Netherlands: modelled, not benchmarked
        leagues.append(league)

    if args.download or args.refresh:
        for league in leagues:
            _, _, test_season = split(league)
            if test_season is not None:
                download(
                    league, test_season, refresh=args.refresh, source=args.source
                )

    results = [r for r in (run_league(l, args.devig, args.audit) for l in leagues) if r]

    if not results:
        return 0 if args.audit else 1

    total = sum(r["matches"] for r in results)
    weighted = {
        who: {
            metric: sum(r[who][metric] * r["matches"] for r in results) / total
            for metric in ("accuracy", "log_loss", "rps")
        }
        for who in ("baseline", "model", "market")
    }

    print(f"\n{'=' * 66}")
    print("OVERALL (weighted by matches)")
    print("=" * 66)
    print(f"  {'':<12}{'baseline':>12}{'model':>12}{'market':>12}")
    print("  " + "-" * 48)
    for metric, fmt in (("accuracy", "{:.1%}"), ("log_loss", "{:.4f}"), ("rps", "{:.4f}")):
        row = "".join(
            fmt.format(weighted[who][metric]).rjust(12)
            for who in ("baseline", "model", "market")
        )
        print(f"  {metric:<12}{row}")
    print("  " + "-" * 48)

    spread = weighted["baseline"]["rps"] - weighted["market"]["rps"]
    print(f"  {total} matches across {len(results)} leagues")

    if spread > 0:
        closed = (weighted["baseline"]["rps"] - weighted["model"]["rps"]) / spread
        print(f"  The model closes {closed:.1%} of the gap from baseline to market.")
    else:
        # Real closing odds always beat the naive baseline. Landing here means
        # the odds are wrong — a bad join, or the wrong season's file — and the
        # ratio would be a meaningless number dressed up as a result.
        closed = None
        print(
            "  The market scored WORSE than the naive baseline, which does not "
            "happen with real closing odds.\n"
            "  Check the join and the odds columns before trusting anything above."
        )

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(
            {
                "leagues": results,
                "overall": {
                    **weighted,
                    "matches": total,
                    "skill_closed": round(closed, 4) if closed is not None else None,
                },
                "devig": args.devig,
            },
            indent=2,
        )
        + "\n",
        encoding="utf8",
    )
    print(f"\n  Written to {OUTPUT_FILE.relative_to(PROJECT_ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())