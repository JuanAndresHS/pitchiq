"""
PitchIQ — European connectivity report.

Before modelling relative league strength, it is worth knowing whether the data
can support it at all. Domestic fixtures never connect one competition's rating
scale to another's; European matches are the only bridge, and there are not many
of them.

This script answers three questions:

  1. How many European matches are there, and how many involve two teams whose
     domestic leagues we already model?
  2. Which pairs of leagues are connected, and by how many matches? A pair with
     three meetings supports a much weaker claim than one with thirty.
  3. How many participants come from leagues outside our coverage, and does
     pooling them into a single "rest of Europe" group recover enough matches to
     be worth it?

Run it before writing any modelling code. If the connectivity is too thin, the
honest answer is to say so rather than to fit something that cannot be
estimated.

Usage:
    python src/models/analyse_european.py
    python src/models/analyse_european.py --competition CL
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from leagues import LEAGUES, cup_codes, domestic_codes, get_league  # noqa: E402

PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"

# Clubs from leagues too small to model individually share one parameter. Each
# of them appears once or twice in four seasons — far too little to estimate a
# Norwegian or Cypriot league factor, but enough collectively to describe a
# level: "champions of smaller leagues", which is what these clubs mostly are.
REST = "rest"


def load_competition(slug: str) -> pd.DataFrame:
    files = sorted(PROCESSED_DIR.glob(f"{slug}_matches_*.csv"))
    if not files:
        return pd.DataFrame()

    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    df["utc_date"] = pd.to_datetime(df["utc_date"], utc=True)
    return df.sort_values("utc_date").reset_index(drop=True)


def build_team_index() -> dict[str, str]:
    """Map every team we have domestic data for onto its league slug."""
    index: dict[str, str] = {}

    for code in domestic_codes():
        league = get_league(code)
        df = load_competition(league.slug)
        if df.empty:
            continue
        for team in set(df["home_team"]) | set(df["away_team"]):
            index[team] = league.slug

    return index


def main() -> int:
    parser = argparse.ArgumentParser(description="Report European connectivity.")
    parser.add_argument(
        "--competition",
        nargs="+",
        default=cup_codes(),
        metavar="CODE",
        help="Cup competitions to analyse.",
    )
    args = parser.parse_args()

    team_league = build_team_index()
    print(f"Domestic teams on record: {len(team_league):,}")
    for code in domestic_codes():
        slug = get_league(code).slug
        count = sum(1 for v in team_league.values() if v == slug)
        print(f"  {get_league(code).name:<18} {count:>3} teams")

    for code in args.competition:
        league = get_league(code)
        df = load_competition(league.slug)

        print(f"\n{'=' * 66}")
        print(f"{league.name}")
        print("=" * 66)

        if df.empty:
            print(f"  No data. Run: python src/ingestion/fetch_matches.py --league {code}")
            continue

        played = df[df["status"] == "FINISHED"].copy()
        print(f"Matches on record   {len(df):,} ({len(played):,} finished)")
        print(f"Seasons             {sorted(int(s) for s in df['season'].unique())}")

        if "stage" in df.columns:
            print("\nBy stage:")
            for stage, count in df["stage"].value_counts().items():
                print(f"  {str(stage):<28} {count:>4}")

        if played.empty:
            print("\nNo finished matches yet — nothing to measure.")
            continue

        # --- Coverage ---------------------------------------------------------
        participants = set(played["home_team"]) | set(played["away_team"])
        covered = {t for t in participants if t in team_league}
        uncovered = participants - covered

        print(f"\nParticipants        {len(participants)}")
        print(f"  In covered leagues {len(covered)}")
        print(f"  Outside coverage   {len(uncovered)}")

        if uncovered:
            print("\n  Teams with no domestic rating:")
            for team in sorted(uncovered)[:20]:
                print(f"    {team}")
            if len(uncovered) > 20:
                print(f"    ... and {len(uncovered) - 20} more")

        # --- Connectivity -----------------------------------------------------
        # Only matches between two covered teams from *different* leagues carry
        # information about relative league strength. Same-league meetings and
        # matches involving an unrated side do not.
        pairs: Counter = Counter()
        pairs_pooled: Counter = Counter()
        usable = 0
        usable_pooled = 0
        same_league = 0

        for match in played.itertuples():
            home = team_league.get(match.home_team)
            away = team_league.get(match.away_team)

            # Strict view: both teams modelled individually.
            if home is not None and away is not None and home != away:
                usable += 1
                pairs[tuple(sorted((home, away)))] += 1

            # Pooled view: unmodelled clubs fall into one shared group.
            h = home or REST
            a = away or REST
            if h == a:
                same_league += 1
                continue

            usable_pooled += 1
            pairs_pooled[tuple(sorted((h, a)))] += 1

        print(f"\nMatches usable, modelled leagues only  {usable:,}")
        print(f"Matches usable, pooling the rest       {usable_pooled:,}")
        print(f"  Recovered by pooling                 {usable_pooled - usable:,}")
        print(f"  Same-group meetings, excluded        {same_league:,}")

        if not pairs:
            print("\n  No cross-league matches between covered teams.")
            continue

        pairs = pairs_pooled  # the pooled view is the one we would model on

        print("\nLeague pairs, by number of meetings:")
        names = {get_league(c).slug: get_league(c).name for c in domestic_codes()}
        names[REST] = "Rest of Europe"
        for (a, b), count in pairs.most_common():
            bar = "█" * min(count, 40)
            print(f"  {names[a]:<16} v {names[b]:<16} {count:>4}  {bar}")

        # --- Per-league exposure ---------------------------------------------
        exposure: dict[str, int] = defaultdict(int)
        for (a, b), count in pairs.items():
            exposure[a] += count
            exposure[b] += count

        print("\nCross-league matches per league:")
        for slug, count in sorted(exposure.items(), key=lambda kv: -kv[1]):
            print(f"  {names[slug]:<18} {count:>4}")

        # --- Verdict ----------------------------------------------------------
        groups = len(domestic_codes()) + 1  # modelled leagues plus the pooled rest
        possible_pairs = groups * (groups - 1) // 2
        thin = [p for p, c in pairs.items() if c < 10]

        print(f"\n{'-' * 66}")
        print(f"Connected pairs      {len(pairs)} of {possible_pairs} possible")
        print(f"Thinly connected     {len(thin)} pair(s) with fewer than 10 meetings")
        print(f"Weakest link         {min(pairs.values())} meetings")
        print(f"Median per pair      {int(pd.Series(list(pairs.values())).median())}")

        usable = usable_pooled
        if usable < 100:
            print(
                "\nVerdict: too few cross-league matches to estimate league "
                "strength with any confidence. Consider pooling more seasons or "
                "adding the Europa League."
            )
        elif thin:
            print(
                "\nVerdict: enough overall, but some pairs rest on very few "
                "matches. A hierarchical model that shares information across "
                "pairs will behave better here than independent estimates."
            )
        else:
            print("\nVerdict: connectivity looks adequate for a pooled estimate.")

    return 0


if __name__ == "__main__":
    sys.exit(main())