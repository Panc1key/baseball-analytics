import { runMlbExpectedRunsValidation } from '../src/services/MlbExpectedRunsModel.js';

const run = runMlbExpectedRunsValidation({ persist: true });
const s = run.summary;
const pick = (obj) => obj && {
  samples: obj.samples,
  wins: obj.wins,
  winRate: obj.winRate,
  accuracy: obj.accuracy,
  brier: obj.brier,
  logLoss: obj.logLoss,
  roi: obj.roi,
  roi95: obj.roi95,
  averageOdds: obj.averageOdds,
  averageModelProbability: obj.averageModelProbability,
};

console.log(JSON.stringify({
  runId: run.runId,
  modelVersion: run.modelVersion,
  selected: s.featureAblation.full.selected,
  fallbackSelected: s.featureAblation.fallback.selected,
  featureKeys: s.featureKeys,
  ablationCandidates: s.featureAblation.full.candidates,
  moneylineCalibration: s.moneylineCalibration,
  validation2025: {
    totalMae: s.validation.totalRunsMae,
    moneyline: pick(s.validation.moneyline),
    confidence: s.validation.moneylineConfidence,
    expectedRunsSide: pick(s.validation.expectedRunsSideBets),
    edgeHallucination: pick(s.validation.edgePickPositiveEvHallucination),
    strict: pick(s.validation.strictMoneylineRecommendations?.summary),
  },
  observed2026: {
    totalMae: s.finalTest.totalRunsMae,
    moneyline: pick(s.finalTest.moneyline),
    pitModel: pick(s.finalTest.pitModelMoneyline),
    pitMarket: pick(s.finalTest.pitMarketMoneyline),
    confidence: s.finalTest.moneylineConfidence,
    expectedRunsSide: pick(s.finalTest.expectedRunsSideBets),
    edgeHallucination: pick(s.finalTest.edgePickPositiveEvHallucination),
    strict: pick(s.finalTest.strictMoneylineRecommendations?.summary),
    totals: pick(s.finalTest.totals),
    marketTotals: pick(s.finalTest.pitMarketTotals),
  },
  routed2026: {
    pitModel: pick(s.routedFinalObserved.pitModelMoneyline),
    pitMarket: pick(s.routedFinalObserved.pitMarketMoneyline),
    confidence: s.routedFinalObserved.moneylineConfidence,
    expectedRunsSide: pick(s.routedFinalObserved.expectedRunsSideBets),
    edgeHallucination: pick(s.routedFinalObserved.edgePickPositiveEvHallucination),
    strict: pick(s.routedFinalObserved.strictMoneylineRecommendations?.summary),
  },
  deployment: s.deploymentDecision,
}, null, 2));
