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
        { ...base, pick: 'Atlanta Braves', model_prob: 0.62 },
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
});
