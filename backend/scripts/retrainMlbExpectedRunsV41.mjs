import { runMlbExpectedRunsValidation } from '../src/services/MlbExpectedRunsModel.js';

const run = runMlbExpectedRunsValidation({ persist: true });
const summary = run.summary;
console.log(JSON.stringify({
  runId: run.runId,
  modelVersion: run.modelVersion,
  featureKeys: summary.featureKeys,
  fallbackFeatureKeys: summary.fallbackFeatureKeys,
  featureAblation: summary.featureAblation,
  validation2025: {
    totalRunsMae: summary.validation.totalRunsMae,
    moneylineBrier: summary.validation.moneyline.brier,
    totalsSamples: summary.validation.totals.samples,
    totalsBrier: summary.validation.totals.brier,
  },
  observed2026: {
    totalRunsMae: summary.finalTest.totalRunsMae,
    moneylineBrier: summary.finalTest.moneyline.brier,
    pitModelMoneylineBrier: summary.finalTest.pitModelMoneyline.brier,
    pitMarketMoneylineBrier: summary.finalTest.pitMarketMoneyline.brier,
    totalsBrier: summary.finalTest.totals.brier,
    marketTotalsBrier: summary.finalTest.pitMarketTotals.brier,
    strict: {
      samples: summary.finalTest.strictMoneylineRecommendations.samples,
      winRate: summary.finalTest.strictMoneylineRecommendations.winRate,
      roi: summary.finalTest.strictMoneylineRecommendations.roi,
      roi95: summary.finalTest.strictMoneylineRecommendations.roi95,
    },
  },
  routed: {
    totalsBrier: summary.routedFinalObserved.totals.brier,
    marketTotalsBrier: summary.routedFinalObserved.pitMarketTotals.brier,
    pitModelMoneylineBrier: summary.routedFinalObserved.pitModelMoneyline.brier,
    pitMarketMoneylineBrier: summary.routedFinalObserved.pitMarketMoneyline.brier,
    strict: {
      samples: summary.routedFinalObserved.strictMoneylineRecommendations.samples,
      winRate: summary.routedFinalObserved.strictMoneylineRecommendations.winRate,
      roi: summary.routedFinalObserved.strictMoneylineRecommendations.roi,
      roi95: summary.routedFinalObserved.strictMoneylineRecommendations.roi95,
    },
  },
  deploymentDecision: summary.deploymentDecision,
}, null, 2));
