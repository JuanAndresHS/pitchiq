/**
 * Model evaluation results.
 *
 * Produced by notebooks/02_outcome_model.ipynb on a held-out season the model
 * never saw during training. Hardcoded rather than computed at request time
 * because they describe a specific evaluation run — recomputing them on live
 * data would quietly turn a test result into a training result.
 *
 * Update these when the model is retrained.
 */

export const MODEL_METRICS = {
  testSeason: "2025/26",
  testMatches: 380,
  trainMatches: 760,

  accuracy: { baseline: 0.426, model: 0.468 },
  logLoss: { baseline: 1.0852, model: 1.03 },
  rpsImprovement: 0.079,

  poissonFit: { homeP: 0.31, awayP: 0.46 },
  homeAdvantage: 1.186,
} as const;
