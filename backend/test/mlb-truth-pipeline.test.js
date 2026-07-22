import test from 'node:test';
import assert from 'node:assert/strict';

import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { runAnalysis } from '../src/services/AnalysisEngine.js';
import {
  bestFairH2h,
  calculateCompleteness,
  detectStarterInjuryConflicts,
  selectBaselineH2hEdge,
} from '../src/services/MlbPrematchTruthPipeline.js';
import {
  getProbablePitchers,
  matchMlbOfficialGame,
  parseMlbInjuredRoster,
} from '../src/services/MlbStatsService.js';

test('MLB 研究資料表已建立並與舊投注帳分離', () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('mlb_prematch_truth_snapshots', 'mlb_paper_candidates', 'mlb_paper_bets')
  `).all().map((row) => row.name);

  assert.deepEqual(tables.sort(), [
    'mlb_paper_bets',
    'mlb_paper_candidates',
    'mlb_prematch_truth_snapshots',
  ]);
});

test('研究模式停止舊推薦／均注管線', async () => {
  assert.equal(config.mlbTruthResearchOnly, true);
  const result = await runAnalysis();
  assert.equal(result.disabled, true);
  assert.equal(result.mode, 'research_only');
});

test('MLB 真實資料完整度：缺失資料不可被當作已覆蓋', () => {
  const completeness = calculateCompleteness([
    { key: 'fixture', status: 'verified' },
    { key: 'odds', status: 'verified' },
    { key: 'venue', status: 'verified' },
    { key: 'starting_pitchers', status: 'partial' },
    { key: 'official_history', status: 'missing' },
    { key: 'bullpen', status: 'missing' },
    { key: 'lineup', status: 'missing' },
    { key: 'injuries', status: 'missing' },
    { key: 'park', status: 'partial' },
    { key: 'weather', status: 'missing' },
    { key: 'travel_rest', status: 'missing' },
  ]);

  assert.ok(completeness > 0);
  assert.ok(completeness < 0.6);
});

test('官方預定先發若同時位於 IL 必須標記來源衝突', () => {
  const conflicts = detectStarterInjuryConflicts(
    {
      home: { id: 1, name: 'Home Starter' },
      away: { id: 2, name: 'Away Starter' },
    },
    { roster: [{ id: 1, status: 'Injured 15-Day' }] },
    { roster: [] }
  );

  assert.deepEqual(conflicts, [
    {
      side: 'home',
      pitcher: { id: 1, name: 'Home Starter' },
      source: 'official_il',
    },
  ]);
});

test('官方歷史特徵為完整度的一部分，缺失時不可偽裝為已覆蓋', () => {
  const base = [
    { key: 'fixture', status: 'verified' },
    { key: 'odds', status: 'verified' },
  ];
  const withVerifiedHistory = calculateCompleteness([
    ...base,
    { key: 'official_history', status: 'verified' },
  ]);
  const withMissingHistory = calculateCompleteness([
    ...base,
    { key: 'official_history', status: 'missing' },
  ]);

  assert.ok(withVerifiedHistory > withMissingHistory);
});

test('市場基準只使用同一 bookmaker 的雙邊盤去水', () => {
  const market = bestFairH2h(
    [
      {
        title: '高水莊',
        markets: [{
          key: 'h2h',
          outcomes: [{ name: 'Home', price: 1.8 }, { name: 'Away', price: 1.8 }],
        }],
      },
      {
        title: '低水莊',
        markets: [{
          key: 'h2h',
          outcomes: [{ name: 'Home', price: 1.91 }, { name: 'Away', price: 1.91 }],
        }],
      },
    ],
    'Home',
    'Away'
  );

  assert.equal(market.bookmaker, '低水莊');
  assert.equal(Math.round(market.homeProb * 1000) / 1000, 0.5);
  assert.equal(Math.round(market.awayProb * 1000) / 1000, 0.5);
});

test('候選必須選擇正 edge 方向，不可只選模型超過五成的一方', () => {
  const selection = selectBaselineH2hEdge(
    { homeProb: 0.51, awayProb: 0.49 },
    { homeProb: 0.6, awayProb: 0.4 }
  );
  assert.equal(selection.pickHome, false);
  assert.equal(selection.modelProb, 0.49);
  assert.equal(selection.marketProb, 0.4);
  assert.ok(Math.abs(selection.edge - 0.09) < 1e-9);
});

test('傷兵名單只接受 40-man roster 的 Injured 狀態', () => {
  const injuries = parseMlbInjuredRoster([
    {
      person: { id: 1, fullName: 'Active Player' },
      position: { abbreviation: 'P' },
      status: { code: 'A', description: 'Active' },
    },
    {
      person: { id: 2, fullName: 'Minor Player' },
      position: { abbreviation: 'P' },
      status: { code: 'RM', description: 'Reassigned to Minors' },
    },
    {
      person: { id: 3, fullName: 'Injured Player' },
      position: { abbreviation: 'C' },
      status: { code: 'D60', description: 'Injured 60-Day' },
    },
  ]);
  assert.deepEqual(injuries, [{
    id: 3,
    name: 'Injured Player',
    position: 'C',
    status: 'Injured 60-Day',
    statusCode: 'D60',
  }]);
});

test('官方場次配對必須以隊伍與最接近開賽時間區分雙重賽', () => {
  const team = (name) => ({ name });
  const schedule = [
    {
      gamePk: 1,
      gameDate: '2026-07-22T17:00:00Z',
      teams: {
        home: { team: team('Chicago Cubs') },
        away: { team: team('St. Louis Cardinals') },
      },
    },
    {
      gamePk: 2,
      gameDate: '2026-07-22T23:00:00Z',
      teams: {
        home: { team: team('Chicago Cubs') },
        away: { team: team('St. Louis Cardinals') },
      },
    },
  ];
  const match = matchMlbOfficialGame({
    commence_time: '2026-07-22T22:55:00Z',
    home_team: 'Chicago Cubs',
    away_team: 'St. Louis Cardinals',
  }, schedule);
  assert.equal(match.gamePk, 2);
});

test('官方賽程未匹配時 probable pitcher 必須安全回空值', () => {
  assert.deepEqual(getProbablePitchers(null), { home: null, away: null });
});

