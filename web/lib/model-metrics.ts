/**
 * Model evaluation results, per league.
 *
 * Produced by `python src/models/evaluate.py --sweep`, measured on the most
 * recent complete season of each competition, held out entirely from training.
 * Hardcoded rather than computed at request time because they describe a
 * specific evaluation run — recomputing them on live data would quietly turn a
 * test result into a training result.
 *
 * Regenerate after any change to the model and paste the block it prints.
 */

export type LeagueMetrics = {
  testSeason: string;
  testMatches: number;
  accuracy: { baseline: number; model: number };
  logLoss: { baseline: number; model: number };
  rpsImprovement: number;
  homeAdvantage: number;
  alpha: number;
};

export const LEAGUE_METRICS: Record<string, LeagueMetrics> = {
  pl: {
    testSeason: "2025/26",
    testMatches: 380,
    accuracy: { baseline: 0.426, model: 0.479 },
    logLoss: { baseline: 1.0852, model: 1.0286 },
    rpsImprovement: 0.082,
    homeAdvantage: 1.185,
    alpha: 3.0,
  },
  pd: {
    testSeason: "2025/26",
    testMatches: 380,
    accuracy: { baseline: 0.489, model: 0.532 },
    logLoss: { baseline: 1.0509, model: 0.986 },
    rpsImprovement: 0.097,
    homeAdvantage: 1.29,
    alpha: 5.0,
  },
  sa: {
    testSeason: "2025/26",
    testMatches: 380,
    accuracy: { baseline: 0.389, model: 0.511 },
    logLoss: { baseline: 1.0906, model: 1.0213 },
    rpsImprovement: 0.105,
    homeAdvantage: 1.144,
    alpha: 1.0,
  },
  bl1: {
    testSeason: "2025/26",
    testMatches: 306,
    accuracy: { baseline: 0.438, model: 0.542 },
    logLoss: { baseline: 1.0718, model: 0.9791 },
    rpsImprovement: 0.141,
    homeAdvantage: 1.201,
    alpha: 3.0,
  },
  fl1: {
    testSeason: "2025/26",
    testMatches: 305,
    accuracy: { baseline: 0.462, model: 0.502 },
    logLoss: { baseline: 1.0643, model: 1.0085 },
    rpsImprovement: 0.084,
    homeAdvantage: 1.256,
    alpha: 5.0,
  },
};

/**
 * The cross-league model, evaluated on a held-out European season with every
 * domestic rating refit behind that season's start date. Reusing today's
 * ratings would hand the model domestic results that had not happened yet.
 *
 * Regenerate with `python src/models/evaluate_european.py`.
 */
export const EUROPEAN_METRICS = {
  testSeason: "2025/26",
  testMatches: 189,
  trainMatches: 298,
  accuracy: { baseline: 0.503, model: 0.571 },
  logLoss: { baseline: 1.0161, model: 0.9584 },
  rpsImprovement: 0.093,
  homeAdvantage: 1.485,
  /** How much worse, in RPS, a fixture scores when one club comes from the
   *  pooled group rather than a modelled league. */
  pooledRpsPenalty: 0.0161,
} as const;

/**
 * Weighted by test-set size, so the bigger divisions are not outvoted by the
 * 18-team ones.
 */
export const OVERALL_ACCURACY = 0.512;

/** Poisson goodness-of-fit on the Premier League sample. */
export const POISSON_FIT = { homeP: 0.31, awayP: 0.46 };