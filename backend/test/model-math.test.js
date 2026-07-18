import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brierScore,
  logLoss,
  buildBinCalibration,
  applyBinCalibration,
} from '../src/services/ProbabilityCalibration.js';
import {
  dixonColesTau,
  jointScoreMass,
} from '../src/models/DixonColes.js';
import {
  poissonTotalDistribution,
  jointScoreProb,
} from '../src/models/GameScoreModel.js';
import { createWalkForwardElo, updatePairElo } from '../src/services/BaseballElo.js';
import { MODEL_STAGES, MODEL_PIPELINE_VERSION } from '../src/models/ModelPipeline.js';
import { scorePick } from '../src/services/PickScorer.js';

test('ModelPipeline 契約版本存在', () => {
  assert.ok(MODEL_PIPELINE_VERSION.startsWith('baseball-'));
  assert.ok(MODEL_STAGES.includes('score_distribution'));
  assert.ok(MODEL_STAGES.includes('ev_and_gates'));
});

test('Brier / LogLoss：近完美預測接近 0', () => {
  const pts = [
    { p: 0.98, y: 1 },
    { p: 0.02, y: 0 },
  ];
  assert.ok(brierScore(pts) < 0.001);
  assert.ok(logLoss(pts) < 0.05);
});

test('分箱校準：高估箱會下修', () => {
  const points = [];
  for (let i = 0; i < 20; i++) points.push({ p: 0.7, y: 0 });
  for (let i = 0; i < 5; i++) points.push({ p: 0.7, y: 1 });
  const table = buildBinCalibration(points, 0.1);
  const cal = applyBinCalibration(0.7, table);
  assert.ok(cal < 0.7);
});

test('Dixon–Coles τ：ρ=0 時為 1', () => {
  assert.equal(dixonColesTau(0, 0, 4, 4, 0), 1);
  assert.equal(dixonColesTau(1, 1, 4, 4, 0), 1);
});

test('Dixon–Coles：ρ>0 增加 (0,0) 相對質量差', () => {
  const indep = jointScoreMass(0, 0, 3.5, 3.5, 0);
  const corr = jointScoreMass(0, 0, 3.5, 3.5, 0.05);
  assert.ok(corr < indep);
});

test('泊松大小分布支援 ρ', () => {
  const a = poissonTotalDistribution(4, 4, 8.5, 24, 0);
  const b = poissonTotalDistribution(4, 4, 8.5, 24, 0.08);
  assert.ok(Math.abs(a.overProb + a.underProb + a.pushProb - 1) < 1e-6);
  assert.ok(Math.abs(b.overProb - a.overProb) > 1e-6 || Math.abs(b.underProb - a.underProb) > 1e-6);
});

test('jointScoreProb 與 DixonColes 質量一致', () => {
  const a = jointScoreProb(2, 1, 4, 3.5, 0.03);
  const b = jointScoreMass(2, 1, 4, 3.5, 0.03);
  assert.ok(Math.abs(a - b) < 1e-12);
});

test('Walk-forward Elo：先讀後更新無前視', () => {
  const w = createWalkForwardElo('NPB', { seedFromRating: false });
  const beforeHome = w.get('TeamA');
  const beforeAway = w.get('TeamB');
  assert.equal(beforeHome, 1500);
  w.applyGame('TeamA', 'TeamB', 5, 1);
  assert.ok(w.get('TeamA') > beforeHome);
  assert.ok(w.get('TeamB') < beforeAway);
});

test('updatePairElo 守恒：雙方變動相反', () => {
  const next = updatePairElo(1500, 1500, 3, 2);
  assert.ok(Math.abs(next.homeElo + next.awayElo - 3000) < 1e-9);
});

test('scorePick 以 EV/勝率決策，edge 計算不變', () => {
  const scored = scorePick({
    modelProb: 0.53,
    marketProb: 0.5,
    impliedProb: 1 / 1.91,
    oddsDecimal: 1.91,
    marketType: 'h2h',
    dataQuality: 0.8,
  });
  assert.equal(scored.edgeProb, 3);
  assert.equal(scored.offeredEdgeProb, 0.6);
});
