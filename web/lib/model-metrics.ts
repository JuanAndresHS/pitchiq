/**
 * Model evaluation results.
 *
 * Produced by src/models/evaluate.py on the most recent complete season, held
 * out entirely from training. Hardcoded rather than computed at request time
 * because they describe a specific evaluation run — recomputing them on live
 * data would quietly turn a test result into a training result.
 *
 * Regenerate with `python src/models/evaluate.py --sweep` after any change to
 * the model, and paste the block it prints.
 */

export const MODEL_METRICS = {
  testSeason: "2025/26",
  testMatches: 380,
  trainMatches: 760,

  accuracy: { baseline: 0.426, model: 0.479 },
  logLoss: { baseline: 1.0852, model: 1.0286 },
  rpsImprovement: 0.082,

  poissonFit: { homeP: 0.31, awayP: 0.46 },
  homeAdvantage: 1.185,

  /** Ridge penalty on team parameters, selected by held-out validation. */
  alpha: 3.0,
} as const;
