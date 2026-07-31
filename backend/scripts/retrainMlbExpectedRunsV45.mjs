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
};

const out = {
  runId: run.runId,
  modelVersion: run.modelVersion,
  selected: s.featureAblation.full.selected,
  fallbackSelected: s.featureAblation.fallback.selected,
  featureKeys: s.featureKeys,
  ablationCandidates: s.featureAblation.full.candidates.map((c) => ({
    key: c.key,
    moneylineBrier: c.moneylineBrier,
    totalRunsMae: c.totalRunsMae,
  })),
  validation2025: {
    totalMae: s.validation.totalRunsMae,
    moneyline: pick(s.validation.moneyline),
  },
  observed2026: {
    totalMae: s.finalTest.totalRunsMae,
    moneyline: pick(s.finalTest.moneyline),
    expectedRunsSide: pick(s.finalTest.expectedRunsSideBets),
    pitModel: pick(s.finalTest.pitModelMoneyline),
    pitMarket: pick(s.finalTest.pitMarketMoneyline),
    strict: pick(s.finalTest.strictMoneylineRecommendations?.summary),
  },
  deployment: s.deploymentDecision,
};

console.log(JSON.stringify(out, null, 2));
