/**
 * League configuration.
 *
 * The TypeScript counterpart of src/leagues.py. Two identifiers per league:
 * `slug` matches the Python side, the data directories and the CSS palette
 * scopes, while `route` is what appears in the URL — "premier-league" reads
 * better than "pl" and is worth the extra field.
 *
 * `code` is a three-letter country abbreviation rather than a flag emoji.
 * Windows does not render regional-indicator flags at all — it falls back to
 * the bare letter pair — and England's flag needs a tag sequence that fails
 * even more often. Text renders identically everywhere.
 */

export type League = {
  slug: string; // matches data/predictions/<slug>/ and [data-league="..."]
  route: string; // URL segment
  name: string;
  shortName: string;
  country: string;
  code: string;
  tagline: string;
  /** Cups have no domestic table and their own page shape. */
  cup?: boolean;
};

export const LEAGUES: League[] = [
  {
    slug: "pl",
    route: "premier-league",
    name: "Premier League",
    shortName: "Premier",
    country: "England",
    code: "ENG",
    tagline: "The hardest of the five to forecast",
  },
  {
    slug: "pd",
    route: "laliga",
    name: "LaLiga",
    shortName: "LaLiga",
    country: "Spain",
    code: "ESP",
    tagline: "The strongest home advantage in Europe",
  },
  {
    slug: "sa",
    route: "serie-a",
    name: "Serie A",
    shortName: "Serie A",
    country: "Italy",
    code: "ITA",
    tagline: "The weakest home advantage of the five",
  },
  {
    slug: "bl1",
    route: "bundesliga",
    name: "Bundesliga",
    shortName: "Bundesliga",
    country: "Germany",
    code: "GER",
    tagline: "The most predictable division",
  },
  {
    slug: "fl1",
    route: "ligue-1",
    name: "Ligue 1",
    shortName: "Ligue 1",
    country: "France",
    code: "FRA",
    tagline: "Eighteen teams, one long-standing favourite",
  },
];

/**
 * The Champions League sits apart from the domestic leagues: it has no league
 * table of its own and its forecasts depend on a second model that calibrates
 * one competition's ratings against another's.
 */
export const CHAMPIONS_LEAGUE: League = {
  slug: "cl",
  route: "champions-league",
  name: "Champions League",
  shortName: "Champions",
  country: "Europe",
  code: "UEFA",
  tagline: "Where the five leagues finally meet",
  cup: true,
};

/** Everything with a page, cups included. */
export const COMPETITIONS: League[] = [...LEAGUES, CHAMPIONS_LEAGUE];

export const DEFAULT_LEAGUE = LEAGUES[0];

export function getLeagueByRoute(route: string): League | null {
  return COMPETITIONS.find((l) => l.route === route) ?? null;
}

export function getLeagueBySlug(slug: string): League | null {
  return COMPETITIONS.find((l) => l.slug === slug) ?? null;
}

/**
 * Resolve whatever a caller supplies — route, slug, country or league name —
 * onto a league. The agent's tools take a league from a language model, so
 * accepting "LaLiga" and "Spain" alongside "pd" avoids failed lookups over
 * spelling.
 */
export function resolveLeague(input: string | null | undefined): League | null {
  if (!input) return null;
  const query = input.trim().toLowerCase();

  return (
    COMPETITIONS.find(
      (l) =>
        l.route === query ||
        l.slug === query ||
        l.code.toLowerCase() === query ||
        l.name.toLowerCase() === query ||
        l.shortName.toLowerCase() === query ||
        l.country.toLowerCase() === query,
    ) ??
    COMPETITIONS.find((l) => l.name.toLowerCase().includes(query)) ??
    null
  );
}