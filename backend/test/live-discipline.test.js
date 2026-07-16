import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforceLiveDiscipline } from '../src/services/LiveDiscipline.js';
import { checkPrematchContradiction } from '../src/services/PrematchLiveGuard.js';

function baseCand(over = {}) {
  return {
    market: 'h2h',
    pick: 'Tokyo Yakult Swallows',
    modelProb: 0.62,
    impliedProb: 0.48,
    ev: 0.1,
    edgeProb: 5,
    oddsDecimal: 2.05,
    dataQuality: 0.7,
    ...over,
  };
}

const earlyLive = {
  homeScore: 0,
  awayScore: 0,
  inningsPlayed: 0.25,
  inningsRemaining: 8.8,
  expectedFinalTotal: 7.4,
};

describe('live discipline v1.3', () => {
  it('rejects 1回表 0-0 as opening / zero-zero freeze', () => {
    const d = enforceLiveDiscipline(baseCand(), {
      hasScore: true,
      live: earlyLive,
    });
    assert.equal(d.ok, false);
    assert.ok(
      d.rejectReasons.some((r) => r.includes('開局凍結') || r.includes('0-0 凍結'))
    );
  });

  it('rejects 0-0 even after general opening freeze until mid-game', () => {
    const d = enforceLiveDiscipline(baseCand({ modelProb: 0.62, edgeProb: 6 }), {
      hasScore: true,
      live: { ...earlyLive, inningsPlayed: 3.2, inningsRemaining: 5.8 },
    });
    assert.equal(d.ok, false);
    assert.ok(d.rejectReasons.some((r) => r.includes('0-0 凍結')));
  });

  it('rejects tied H2H before mid-game', () => {
    const d = enforceLiveDiscipline(baseCand({ modelProb: 0.62, edgeProb: 6 }), {
      hasScore: true,
      live: {
        homeScore: 1,
        awayScore: 1,
        inningsPlayed: 3.5,
        inningsRemaining: 5.5,
      },
    });
    assert.equal(d.ok, false);
    assert.ok(d.rejectReasons.some((r) => r.includes('平手獨贏凍結')));
  });

  it('rejects early under when projected total is too close to line', () => {
    const d = enforceLiveDiscipline(
      baseCand({
        market: 'totals',
        pick: '小 8',
        line: 8,
        projectedTotal: 7.2,
        modelProb: 0.58,
        edgeProb: 7,
        oddsDecimal: 1.95,
      }),
      {
        hasScore: true,
        live: {
          homeScore: 1,
          awayScore: 0,
          inningsPlayed: 3.5,
          inningsRemaining: 5.5,
          expectedFinalTotal: 7.2,
        },
      }
    );
    assert.equal(d.ok, false);
    assert.ok(d.rejectReasons.some((r) => r.includes('開局小球過近')));
  });

  it('rejects live H2H below 60% floor', () => {
    const d = enforceLiveDiscipline(baseCand({ modelProb: 0.54, edgeProb: 5 }), {
      hasScore: true,
      live: {
        homeScore: 3,
        awayScore: 1,
        inningsPlayed: 6,
        inningsRemaining: 3,
      },
    });
    assert.equal(d.ok, false);
    assert.ok(d.rejectReasons.some((r) => r.includes('滾球獨贏')));
  });

  it('rejects under below live under edge floor', () => {
    const d = enforceLiveDiscipline(
      baseCand({
        market: 'totals',
        pick: '小 8',
        line: 8,
        projectedTotal: 5.5,
        modelProb: 0.6,
        edgeProb: 5.5,
        oddsDecimal: 1.95,
        ev: 0.08,
      }),
      {
        hasScore: true,
        live: {
          homeScore: 2,
          awayScore: 1,
          inningsPlayed: 6,
          inningsRemaining: 3,
          expectedFinalTotal: 5.5,
        },
      }
    );
    assert.equal(d.ok, false);
    assert.ok(d.rejectReasons.some((r) => r.includes('優勢')));
  });

  it('blocks flipping prematch H2H while score quiet', () => {
    const reason = checkPrematchContradiction(
      baseCand({ pick: 'Tokyo Yakult Swallows' }),
      { homeScore: 0, awayScore: 1, inningsPlayed: 4, inningsRemaining: 5 },
      {
        enabled: true,
        recommendations: [
          { market: 'spreads', pick: 'Yomiuri Giants +0.5', line: 0.5 },
        ],
        rejectedKeys: new Set(),
      }
    );
    assert.ok(reason && reason.includes('初盤看好'));
  });

  it('blocks prematch-rejected direction early', () => {
    const key = 'h2h|saitama seibu lions|';
    const reason = checkPrematchContradiction(
      baseCand({ pick: 'Saitama Seibu Lions', modelProb: 0.62 }),
      { homeScore: 0, awayScore: 0, inningsPlayed: 3.5, inningsRemaining: 5.5 },
      {
        enabled: true,
        recommendations: [],
        rejectedKeys: new Set([key]),
      }
    );
    assert.ok(reason && reason.includes('初盤已濾除'));
  });
});
