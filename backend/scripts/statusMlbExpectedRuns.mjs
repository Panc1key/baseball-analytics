import { getLatestMlbExpectedRunsValidation } from '../src/services/MlbExpectedRunsModel.js';

const latest = getLatestMlbExpectedRunsValidation();
const s = latest?.summary || {};
const final = s.finalTest || {};
const routed = s.routedFinalObserved || {};
const pick = (obj) => ({
  samples: obj?.samples ?? null,
  winRate: obj?.winRate ?? null,
  accuracy: obj?.accuracy ?? null,
  brier: obj?.brier ?? null,
  logLoss: obj?.logLoss ?? null,
  roi: obj?.roi ?? null,
  roi95: obj?.roi95 ?? null,
  averageOdds: obj?.averageOdds ?? null,
  averageEdge: obj?.averageEdge ?? null,
  averageModelProbability: obj?.averageModelProbability ?? null,
});

console.log(JSON.stringify({
  runId: latest?.runId,
  modelVersion: latest?.modelVersion,
  createdAt: latest?.createdAt,
  selected: s.featureAblation?.full?.selected,
  fallbackSelected: s.featureAblation?.fallback?.selected,
  featureKeys: s.featureKeys,
  deployment: s.deploymentDecision,
  starterCoverage: s.starterIdentityCoverage,
  observed2026: {
    totalMae: final.totalRunsMae,
    moneylineAll: pick(final.moneyline),
    pitModelMl: pick(final.pitModelMoneyline),
    pitMarketMl: pick(final.pitMarketMoneyline),
    positives: pick(final.moneylineBetDiagnostics?.all || final.moneylineBetDiagnostics),
    confidence: final.moneylineConfidence,
    strict: pick(final.strictMoneylineRecommendations),
    totals: pick(final.totals),
    marketTotals: pick(final.pitMarketTotals),
  },
  routed2026: {
    totalMae: routed.totalRunsMae,
    pitModelMl: pick(routed.pitModelMoneyline),
    pitMarketMl: pick(routed.pitMarketMoneyline),
    positives: pick(routed.moneylineBetDiagnostics?.all || routed.moneylineBetDiagnostics),
    confidence: routed.moneylineConfidence,
    strict: pick(routed.strictMoneylineRecommendations),
    totals: pick(routed.totals),
    marketTotals: pick(routed.pitMarketTotals),
  },
  validation2025: {
    totalMae: s.validation?.totalRunsMae,
    moneyline: pick(s.validation?.moneyline),
    confidence: s.validation?.moneylineConfidence,
  },
}, null, 2));
