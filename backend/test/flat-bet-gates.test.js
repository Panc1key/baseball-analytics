import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesFlatBet } from '../src/services/BetStrategy.js';

const base = {
  tier: 'primary',
  market: 'h2h',
  league: 'MLB',
  ev: 0.1,
  edge_prob: 8,
  model_prob: 0.64,
  odds_decimal: 1.9,
  data_quality: 0.8,
  pick_rank: 1,
  pick: 'Colorado Rockies',
};

describe('flat bet 過信／高球場閘', () => {
  it('模型勝率 > 72% 不進均注', () => {
    assert.equal(
      qualifiesFlatBet({ ...base, model_prob: 0.74 }, { pickRank: 1 }),
      false
    );
  });

  it('preferTotals 時獨贏不進均注', () => {
    assert.equal(
      qualifiesFlatBet(base, {
        pickRank: 1,
        preferTotals: true,
        analysis: { homeTeam: 'Colorado Rockies', parkFactor: 1.0 },
      }),
      false
    );
  });

  it('Coors 主場獨贏不進均注', () => {
    assert.equal(
      qualifiesFlatBet(base, {
        pickRank: 1,
        analysis: {
          homeTeam: 'Colorado Rockies',
          venueName: 'Coors Field',
          parkFactor: 1.18,
        },
      }),
      false
    );
  });

  it('普通主場獨贏仍可進均注', () => {
    assert.equal(
      qualifiesFlatBet(
        { ...base, pick: 'Atlanta Braves', model_prob: 0.65 },
        {
          pickRank: 1,
          analysis: {
            homeTeam: 'Atlanta Braves',
            venueName: 'Truist Park',
            parkFactor: 1.0,
          },
        }
      ),
      true
    );
  });

  it('−1.5 蓋盤率 < 70% 不進均注', () => {
    assert.equal(
      qualifiesFlatBet(
        {
          ...base,
          market: 'spreads',
          league: 'KBO',
          pick: 'Hanwha Eagles -1.5',
          model_prob: 0.68,
          odds_decimal: 2.3,
          hasTeamStrength: true,
          data_quality: 0.85,
          edge_prob: 8,
        },
        { pickRank: 1, hasTeamStrength: true }
      ),
      false
    );
  });

  it('−1.5 蓋盤率 ≥ 70% 可進均注', () => {
    assert.equal(
      qualifiesFlatBet(
        {
          ...base,
          market: 'spreads',
          league: 'KBO',
          pick: 'Hanwha Eagles -1.5',
          model_prob: 0.71,
          odds_decimal: 2.3,
          hasTeamStrength: true,
          data_quality: 0.85,
          edge_prob: 8,
        },
        { pickRank: 1, hasTeamStrength: true }
      ),
      true
    );
  });

  it('獨贏均注 < 64% 不進', async () => {
    const { config } = await import('../src/config.js');
    const prev = config.flatBetMinProbH2h;
    config.flatBetMinProbH2h = 0.64;
    assert.equal(
      qualifiesFlatBet({ ...base, model_prob: 0.59, pick: 'Atlanta Braves' }, { pickRank: 1 }),
      false
    );
    assert.equal(
      qualifiesFlatBet({ ...base, model_prob: 0.65, pick: 'Atlanta Braves' }, { pickRank: 1 }),
      true
    );
    config.flatBetMinProbH2h = prev;
  });
});
