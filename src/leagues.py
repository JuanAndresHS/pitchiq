"""
PitchIQ — League configuration.

Single source of truth for which competitions the project covers. Everything
downstream — ingestion, modelling, evaluation — reads from here, so adding a
league is a one-line change rather than a hunt through five files.

The codes are football-data.org competition identifiers. All five are available
on the free tier.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class League:
    code: str  # football-data.org competition code
    slug: str  # URL-safe identifier, used for filenames and routes
    name: str
    country: str
    teams: int
    alpha: float  # ridge penalty, tuned per league


# The alpha values come from src/models/evaluate.py --sweep, measured on a
# held-out season for each competition. They differ because the leagues differ:
# Serie A's ratings are already well constrained by its results, so it needs
# almost no shrinkage, while LaLiga and Ligue 1 benefit from more.
#
# Re-run the sweep after a season ends and update these.
LEAGUES: dict[str, League] = {
    "PL": League("PL", "pl", "Premier League", "England", 20, alpha=3.0),
    "PD": League("PD", "pd", "LaLiga", "Spain", 20, alpha=5.0),
    "SA": League("SA", "sa", "Serie A", "Italy", 20, alpha=1.0),
    "BL1": League("BL1", "bl1", "Bundesliga", "Germany", 18, alpha=3.0),
    "FL1": League("FL1", "fl1", "Ligue 1", "France", 18, alpha=5.0),
}

DEFAULT_LEAGUE = "PL"


def get_league(code: str) -> League:
    """Look up a league by code, case-insensitively."""
    key = code.strip().upper()
    if key not in LEAGUES:
        available = ", ".join(LEAGUES)
        raise ValueError(f"Unknown league '{code}'. Available: {available}")
    return LEAGUES[key]


def all_codes() -> list[str]:
    return list(LEAGUES)


def matches_filename(league: League, season: int) -> str:
    """e.g. pl_matches_2026.csv"""
    return f"{league.slug}_matches_{season}.csv"
