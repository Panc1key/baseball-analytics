import { runMlbExpectedRunsValidation } from '../src/services/MlbExpectedRunsModel.js';
import { weatherCoverageStats } from '../src/services/MlbGameWeatherService.js';

const run = runMlbExpectedRunsValidation({ persist: true });
const summary = run.summary;
console.log(JSON.stringify({
  runId: run.runId,
  modelVersion: run.modelVersion,
  weatherCoverage: weatherCoverageStats(),
  featureKeys: summary.featureKeys,
  fallbackFeatureKeys: summary.fallbackFeatureKeys,
  featureAblation: summary.featureAblation,
  validation2025: {
    totalRunsMae: summary.validation.totalRunsMae,
    moneylineBrier: summary.validation.moneyline.brier,
  },
  observed2026: {
    totalRunsMae: summary.finalTest.totalRunsMae,
    moneylineBrier: summary.finalTest.moneyline.brier,
    pitModelMoneylineBrier: summary.finalTest.pitModelMoneyline.brier,
    pitMarketMoneylineBrier: summary.finalTest.pitMarketMoneyline.brier,
    totalsBrier: summary.finalTest.totals.brier,
    marketTotalsBrier: summary.finalTest.pitMarketTotals.brier,
  },
  routed: {
    totalsBrier: summary.routedFinalObserved.totals.brier,
    marketTotalsBrier: summary.routedFinalObserved.pitMarketTotals.brier,
    pitModelMoneylineBrier: summary.routedFinalObserved.pitModelMoneyline.brier,
    pitMarketMoneylineBrier: summary.routedFinalObserved.pitMarketMoneyline.brier,
  },
  deploymentDecision: summary.deploymentDecision,
  starterIdentityCoverage: summary.starterIdentityCoverage,
}, null, 2));
