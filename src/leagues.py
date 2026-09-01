"""
PitchIQ — Competition configuration.

Single source of truth for what the project covers. Everything downstream —
ingestion, modelling, evaluation — reads from here, so adding a competition is a
one-line change rather than a hunt through five files.

The codes are football-data.org competition identifiers. All of these are
available on the free tier.

Two kinds of competition live here:

  domestic=True   A league. Every team plays every other twice, so a
                  Dixon-Coles fit has enough structure to estimate attack and
                  defense per side. These get their own model and page.

  domestic=False  A cup. Teams play six to eight matches against opponents from
                  other competitions, with no home-and-away round robin. Fitting
                  team parameters on that would be noise. These are ingested as
                  data — specifically, as the only matches that connect one
                  league's rating scale to another's.

A separate flag, `visible`, decides whether a competition gets a page. Portugal
and the Netherlands are modelled but hidden: their clubs appear in the Champions
League often enough that ignoring them throws away more than half the matches
that connect the league scales, but a Eredivisie dashboard is not something this
site's readers asked for. Modelling need and product surface are different
questions.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class League:
    code: str  # football-data.org competition code
    slug: str  # URL-safe identifier, used for filenames and routes
    name: str
    country: str
    teams: int
    alpha: float = 3.0  # ridge penalty, tuned per league
    domestic: bool = True
    visible: bool = True  # whether the site gives it a page


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
    # Modelled but not shown: their clubs are regular Champions League
    # participants, and without ratings for them most European fixtures are
    # unusable for calibration.
    "PPL": League(
        "PPL", "ppl", "Primeira Liga", "Portugal", 18, alpha=3.0, visible=False
    ),
    "DED": League(
        "DED", "ded", "Eredivisie", "Netherlands", 18, alpha=3.0, visible=False
    ),
    "CL": League(
        "CL",
        "cl",
        "Champions League",
        "Europe",
        36,
        domestic=False,
    ),
}

DEFAULT_LEAGUE = "PL"


def get_league(code: str) -> League:
    """Look up a competition by code, case-insensitively."""
    key = code.strip().upper()
    if key not in LEAGUES:
        available = ", ".join(LEAGUES)
        raise ValueError(f"Unknown competition '{code}'. Available: {available}")
    return LEAGUES[key]


def all_codes() -> list[str]:
    """Every competition, cups included. Used by ingestion."""
    return list(LEAGUES)


def domestic_codes() -> list[str]:
    """Only the leagues a Dixon-Coles model can be fit on.

    Modelling and evaluation default to these: running a league fit on a cup
    would produce parameters with no basis.
    """
    return [code for code, league in LEAGUES.items() if league.domestic]


def cup_codes() -> list[str]:
    return [code for code, league in LEAGUES.items() if not league.domestic]


def visible_codes() -> list[str]:
    """Competitions the site presents. A subset of the domestic ones."""
    return [
        code
        for code, league in LEAGUES.items()
        if league.domestic and league.visible
    ]


def matches_filename(league: League, season: int) -> str:
    """e.g. pl_matches_2026.csv"""
    return f"{league.slug}_matches_{season}.csv"