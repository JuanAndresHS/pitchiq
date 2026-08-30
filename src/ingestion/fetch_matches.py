"""
PitchIQ — Premier League match ingestion.

Fetches fixtures and results for a Premier League season from football-data.org
and stores them as a normalized CSV in data/processed/.

Usage:
    python src/ingestion/fetch_matches.py
    python src/ingestion/fetch_matches.py --season 2024
"""

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

# --- Configuration -----------------------------------------------------------

API_BASE_URL = "https://api.football-data.org/v4"
COMPETITION = "PL"  # Premier League
REQUEST_TIMEOUT = 30  # seconds

# Resolve paths relative to the project root, not the current working directory,
# so the script behaves identically when run locally or from GitHub Actions.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pitchiq.ingestion")


# --- Extract -----------------------------------------------------------------


def fetch_matches(season: int, api_key: str) -> list[dict]:
    """Fetch every match of a given Premier League season.

    Args:
        season: Starting year of the season (2024 means the 2024/25 season).
        api_key: football-data.org API token.

    Returns:
        Raw match objects as returned by the API.
    """
    url = f"{API_BASE_URL}/competitions/{COMPETITION}/matches"
    headers = {"X-Auth-Token": api_key}
    params = {"season": season}

    logger.info("Requesting %s season %s...", COMPETITION, season)

    try:
        response = requests.get(
            url, headers=headers, params=params, timeout=REQUEST_TIMEOUT
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code
        if status == 403:
            logger.error("Access denied. This season may not be in the free tier.")
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


def normalize_matches(matches: list[dict]) -> pd.DataFrame:
    """Flatten the nested API response into a tidy, analysis-ready table.

    Only finished matches carry scores; scheduled fixtures keep null scores so
    the same table can serve both historical analysis and upcoming predictions.
    """
    records = []

    for match in matches:
        score = match.get("score", {})
        full_time = score.get("fullTime", {})
        half_time = score.get("halfTime", {})

        records.append(
            {
                "match_id": match.get("id"),
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

    # Parse dates and derive a plain calendar date for easier grouping.
    df["utc_date"] = pd.to_datetime(df["utc_date"], errors="coerce")
    df["match_date"] = df["utc_date"].dt.date

    # Derive the result from the home team's perspective: the standard encoding
    # for match-outcome models (H = home win, D = draw, A = away win).
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

    df = df.sort_values("utc_date").reset_index(drop=True)
    return df


# --- Validate ----------------------------------------------------------------


def validate(df: pd.DataFrame) -> None:
    """Run basic data quality checks and log the outcome.

    These are cheap guardrails: they surface silent upstream changes before bad
    data reaches the models.
    """
    if df.empty:
        logger.warning("Validation skipped — empty dataset.")
        return

    finished = df[df["status"] == "FINISHED"]

    checks = {
        "duplicate match_ids": df["match_id"].duplicated().sum(),
        "missing team names": df[["home_team", "away_team"]].isna().sum().sum(),
        "finished matches missing scores": finished["home_goals"].isna().sum(),
        "negative goal counts": (
            (df["home_goals"] < 0) | (df["away_goals"] < 0)
        ).sum(),
    }

    for label, count in checks.items():
        if count:
            logger.warning("Validation — %s: %s", label, count)

    if not any(checks.values()):
        logger.info("Validation passed — no issues found.")

    logger.info(
        "Summary: %s matches (%s finished, %s scheduled).",
        len(df),
        len(finished),
        (df["status"] == "TIMED").sum() + (df["status"] == "SCHEDULED").sum(),
    )


# --- Load --------------------------------------------------------------------


def save(df: pd.DataFrame, season: int) -> Path:
    """Write the dataset to data/processed/ as CSV."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"pl_matches_{season}.csv"
    df.to_csv(output_path, index=False)
    logger.info("Saved %s rows to %s", len(df), output_path.relative_to(PROJECT_ROOT))
    return output_path


# --- Entrypoint --------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Premier League matches.")
    parser.add_argument(
        "--season",
        type=int,
        default=datetime.now().year if datetime.now().month >= 8 else datetime.now().year - 1,
        help="Season start year (e.g. 2024 for the 2024/25 season).",
    )
    args = parser.parse_args()

    load_dotenv()
    api_key = os.getenv("FOOTBALL_DATA_API_KEY")

    if not api_key:
        logger.error("FOOTBALL_DATA_API_KEY not found. Check your .env file.")
        return 1

    try:
        raw = fetch_matches(args.season, api_key)
    except requests.exceptions.RequestException:
        return 1

    df = normalize_matches(raw)
    validate(df)

    if df.empty:
        logger.error("Nothing to save.")
        return 1

    save(df, args.season)
    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())