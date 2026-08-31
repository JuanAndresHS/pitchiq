"""
PitchIQ — Match ingestion.

Fetches fixtures and results from football-data.org and stores them as
normalized CSVs in data/processed/, one file per league and season.

Usage:
    python src/ingestion/fetch_matches.py                    # all leagues, current season
    python src/ingestion/fetch_matches.py --league PD        # one league
    python src/ingestion/fetch_matches.py --season 2024      # a past season
    python src/ingestion/fetch_matches.py --season 2024 --league PL SA
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from leagues import League, all_codes, get_league, matches_filename  # noqa: E402

API_BASE_URL = "https://api.football-data.org/v4"
REQUEST_TIMEOUT = 30

# The free tier allows 10 requests per minute. Pausing between leagues keeps a
# full sweep comfortably inside that without ever tripping a 429.
THROTTLE_SECONDS = 7

OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.ingestion")


# --- Extract -----------------------------------------------------------------


def fetch_matches(league: League, season: int, api_key: str) -> list[dict]:
    """Fetch every match of a given league and season."""
    url = f"{API_BASE_URL}/competitions/{league.code}/matches"

    logger.info("Requesting %s (%s) season %s...", league.name, league.code, season)

    try:
        response = requests.get(
            url,
            headers={"X-Auth-Token": api_key},
            params={"season": season},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code
        if status == 403:
            logger.error("Access denied — this season may not be in the free tier.")
        elif status == 429:
            logger.error("Rate limit exceeded. The free tier allows 10 requests/min.")
        else:
            logger.error("HTTP %s: %s", status, exc.response.text[:200])
        raise
    except requests.exceptions.RequestException as exc:
        logger.error("Network error: %s", exc)
        raise

    matches = response.json().get("matches", [])
    logger.info("Received %s matches.", len(matches))
    return matches


# --- Transform ---------------------------------------------------------------


def normalize_matches(matches: list[dict], league: League) -> pd.DataFrame:
    """Flatten the nested API response into a tidy, analysis-ready table.

    Only finished matches carry scores; scheduled fixtures keep null scores so
    the same table serves both historical analysis and upcoming predictions.
    """
    records = []

    for match in matches:
        score = match.get("score", {})
        full_time = score.get("fullTime", {})
        half_time = score.get("halfTime", {})

        records.append(
            {
                "match_id": match.get("id"),
                "league": league.slug,
                "league_name": league.name,
                "season": match.get("season", {}).get("startDate", "")[:4],
                "matchday": match.get("matchday"),
                "utc_date": match.get("utcDate"),
                "status": match.get("status"),
                "stage": match.get("stage"),
                "home_team": match.get("homeTeam", {}).get("name"),
                "home_team_id": match.get("homeTeam", {}).get("id"),
                "away_team": match.get("awayTeam", {}).get("name"),
                "away_team_id": match.get("awayTeam", {}).get("id"),
                "home_goals": full_time.get("home"),
                "away_goals": full_time.get("away"),
                "home_goals_ht": half_time.get("home"),
                "away_goals_ht": half_time.get("away"),
                "winner": score.get("winner"),
                "venue": match.get("venue"),
            }
        )

    df = pd.DataFrame(records)

    if df.empty:
        logger.warning("No matches returned — nothing to normalize.")
        return df

    df["utc_date"] = pd.to_datetime(df["utc_date"], errors="coerce")
    df["match_date"] = df["utc_date"].dt.date

    # Result from the home team's perspective: the standard encoding for
    # match-outcome models (H = home win, D = draw, A = away win).
    def encode_result(row):
        if pd.isna(row["home_goals"]) or pd.isna(row["away_goals"]):
            return None
        if row["home_goals"] > row["away_goals"]:
            return "H"
        if row["home_goals"] < row["away_goals"]:
            return "A"
        return "D"

    df["result"] = df.apply(encode_result, axis=1)
    df["total_goals"] = df["home_goals"] + df["away_goals"]
    df["goal_difference"] = df["home_goals"] - df["away_goals"]
    df["ingested_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    return df.sort_values("utc_date").reset_index(drop=True)


# --- Validate ----------------------------------------------------------------


def validate(df: pd.DataFrame, league: League) -> None:
    """Cheap guardrails that surface silent upstream changes early."""
    if df.empty:
        logger.warning("Validation skipped — empty dataset.")
        return

    finished = df[df["status"] == "FINISHED"]

    checks = {
        "duplicate match_ids": df["match_id"].duplicated().sum(),
        "missing team names": df[["home_team", "away_team"]].isna().sum().sum(),
        "finished matches missing scores": finished["home_goals"].isna().sum(),
        "negative goal counts": ((df["home_goals"] < 0) | (df["away_goals"] < 0)).sum(),
        "teams playing themselves": (df["home_team"] == df["away_team"]).sum(),
    }

    for label, count in checks.items():
        if count:
            logger.warning("Validation — %s: %s", label, count)

    if not any(checks.values()):
        logger.info("Validation passed — no issues found.")

    scheduled = len(df) - len(finished)
    logger.info(
        "%s: %s matches (%s finished, %s upcoming).",
        league.name,
        len(df),
        len(finished),
        scheduled,
    )


# --- Load --------------------------------------------------------------------


def save(df: pd.DataFrame, league: League, season: int) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / matches_filename(league, season)
    df.to_csv(output_path, index=False)
    logger.info("Saved %s rows to %s", len(df), output_path.relative_to(PROJECT_ROOT))
    return output_path


# --- Entrypoint --------------------------------------------------------------


def default_season() -> int:
    """European seasons start in August, so before then the current season is
    still the one that began the previous calendar year."""
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch football matches.")
    parser.add_argument(
        "--season",
        type=int,
        default=default_season(),
        help="Season start year (e.g. 2024 for 2024/25).",
    )
    parser.add_argument(
        "--league",
        nargs="+",
        default=all_codes(),
        metavar="CODE",
        help=f"Which leagues to fetch. Default: all ({', '.join(all_codes())}).",
    )
    args = parser.parse_args()

    load_dotenv()
    api_key = os.getenv("FOOTBALL_DATA_API_KEY")

    if not api_key:
        logger.error("FOOTBALL_DATA_API_KEY not found. Check your .env file.")
        return 1

    try:
        leagues = [get_league(code) for code in args.league]
    except ValueError as exc:
        logger.error("%s", exc)
        return 1

    succeeded, failed = [], []

    for i, league in enumerate(leagues):
        # Throttle between leagues, not before the first one.
        if i > 0:
            time.sleep(THROTTLE_SECONDS)

        try:
            raw = fetch_matches(league, args.season, api_key)
        except requests.exceptions.RequestException:
            failed.append(league.name)
            continue

        df = normalize_matches(raw, league)
        validate(df, league)

        if df.empty:
            failed.append(league.name)
            continue

        save(df, league, args.season)
        succeeded.append(league.name)

    logger.info("Done. %s succeeded, %s failed.", len(succeeded), len(failed))

    if failed:
        logger.warning("Failed: %s", ", ".join(failed))

    # A partial sweep is still useful, so only a total failure is an error.
    return 0 if succeeded else 1


if __name__ == "__main__":
    sys.exit(main())
