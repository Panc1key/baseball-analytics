/**
 * 鎖定 B 組合包：獨贏主倉 + Hybrid 大小 + Star 串關紀律。
 * 2026-08-03 初版；2026-08-04 Hybrid v1.1；2026-08-04 Star 串關寫入 UI。
 * 不改 ev02／frozen_b 主常數；大小與獨贏分欄；串關為提示非自動建單。
 */
import { MLB_TOTALS_SATELLITE_HYBRID_SPEC } from './MlbTotalsSatellite.js';

export const MLB_LOCKED_B_PACKAGE = Object.freeze({
  id: 'locked_b_package_v2026-08-04_star',
  label: '鎖定 B 組合包',
  lockedAt: '2026-08-04',
  flatStakeUsd: 50,
  moneyline: Object.freeze({
    role: 'primary',
    modelVersion: 'mlb-expected-runs-nb-v4.5',
    profile: 'ev02_max230',
    overlay: 'frozen_b+shrink',
    highEvOverlay: 'shrink_w15_l15 (apply)',
    releaseHoursBefore: 8,
    dailyTopK: 3,
    evidenceNote: '紙上主倉；均注 $50；日 TopK 維持 3（不升 4）',
  }),
  totals: Object.freeze({
    role: 'co_primary_satellite',
    specId: MLB_TOTALS_SATELLITE_HYBRID_SPEC.id,
    label: MLB_TOTALS_SATELLITE_HYBRID_SPEC.label,
    under: 'raw μ · gap≥0.6 · 01b 閘',
    over:
      '投手公園 μ−0.70 去偏 · gap≥0.9；Over·raw 另限 absGap≤1.25 · 01b 閘',
    rawOverMaxAbsGap: MLB_TOTALS_SATELLITE_HYBRID_SPEC.rawOverMaxAbsGap,
    stakeUsd: 50,
    mixWithMoneylineTopK: false,
    evidenceUsd50: MLB_TOTALS_SATELLITE_HYBRID_SPEC.paperEvidenceUsd50?.merged || null,
  }),
  parlays: Object.freeze({
    /** 單場 $50 → 串關固定建議 $25（1/2；對齊 star-parlay-discipline） */
    stakeUsd: 25,
    stakeRatioOfSingle: 0.5,
    star: Object.freeze({
      id: 'star_ml_parlay_discipline',
      label: '獨贏 Star 串關包',
      audit: 'auditMlbStarParlayDiscipline / auditMlbTopK45ParlayHitRate',
      forbidFourLeg: true,
      rule3: '三推：R1×R2、R1×R3、R1×R2×R3',
      rule4: '四推：R1×R2、R1×R3、R1×R2×R3、R1×R4；禁止四串',
      rule2: '兩推：僅 R1×R2',
      stakeGuide: '單場均注 $50 時，每張串關票下 $25（勿與單場同額）',
    }),
    /** 衛星混串（獨贏×大小）；獨立於獨贏主串，可選 */
    secondary: Object.freeze({
      id: 'r1_x_hybrid_under',
      label: '衛星：R1 獨贏 × Hybrid 小分',
      rule: '日 Rank1 獨贏 × 當日 Hybrid Under 中 EV 最高者（優先異場）',
      preferDifferentGame: true,
      totalsSide: 'under',
      priority: 2,
      evidenceNote: '混串衛星；不佔獨贏 TopK；與獨贏主串分帳',
    }),
  }),
  stillSeparateLedgers: Object.freeze([
    'mlb_paper_bets 仍只記獨贏',
    '大小分不寫入獨贏紙上帳本',
    '串關為組合包提示，非自動建單',
  ]),
  note:
    '注碼紀律：單場均注 $50（獨贏／Hybrid 大小）；串關每票 $25（單場一半）。日 TopK 維持 3。',
});

function mapMlLeg(leg) {
  return {
    market: 'h2h',
    rank: leg.rank,
    gameId: leg.gameId,
    matchup: leg.matchup,
    pick: leg.pick,
    oddsDecimal: Number(leg.oddsDecimal),
    commenceTime: leg.commenceTime || null,
  };
}

function buildTicket(id, label, legs, stakeUsd) {
  const mapped = legs.map(mapMlLeg);
  const combined = mapped.reduce((a, l) => a * Number(l.oddsDecimal), 1);
  return {
    available: true,
    id,
    label,
    market: 'h2h_parlay',
    legCount: mapped.length,
    suggestedStakeUsd: stakeUsd,
    combinedOdds: Number(combined.toFixed(3)),
    legs: mapped,
  };
}

/**
 * 獨贏 Star 串關包（只吃已放出可看選邊，按日排名）
 * 3 推：R1×R2、R1×R3、三串
 * 4 推：同上 + R1×R4；禁止四串
 */
export function buildStarMoneylineParlayBundle({
  moneylinePicks = [],
  stakeUsd = MLB_LOCKED_B_PACKAGE.parlays.stakeUsd,
  singleStakeUsd = MLB_LOCKED_B_PACKAGE.flatStakeUsd,
} = {}) {
  const spec = MLB_LOCKED_B_PACKAGE.parlays.star;
  const ranked = [...(moneylinePicks || [])]
    .filter((p) => p?.pick && Number.isFinite(Number(p.oddsDecimal)) && Number(p.oddsDecimal) > 1)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99) || String(a.gameId).localeCompare(String(b.gameId)));

  const n = ranked.length;
  const tickets = [];

  if (n >= 2) {
    tickets.push(buildTicket('2leg_r1r2', 'R1 × R2', [ranked[0], ranked[1]], stakeUsd));
  }
  if (n >= 3) {
    tickets.push(buildTicket('2leg_r1r3', 'R1 × R3', [ranked[0], ranked[2]], stakeUsd));
    tickets.push(
      buildTicket('3leg_r123', 'R1 × R2 × R3', [ranked[0], ranked[1], ranked[2]], stakeUsd)
    );
  }
  if (n >= 4) {
    tickets.push(buildTicket('2leg_r1r4', 'R1 × R4', [ranked[0], ranked[3]], stakeUsd));
  }

  let rule = spec.rule2;
  if (n >= 4) rule = spec.rule4;
  else if (n === 3) rule = spec.rule3;
  else if (n < 2) rule = '獨贏可看選邊不足 2，無法組 Star 串關';

  return {
    available: tickets.length > 0,
    id: spec.id,
    label: spec.label,
    rule,
    stakeGuide: spec.stakeGuide,
    singleStakeUsd,
    moneylineLegCount: n,
    suggestedStakeUsd: stakeUsd,
    forbidFourLeg: true,
    tickets,
    reason: n < 2 ? rule : undefined,
    howToBet:
      n >= 2
        ? `注碼：單場各 $${singleStakeUsd}；下列 ${tickets.length} 張串關各 $${stakeUsd}（單場一半，勿同額）。先下 ${n} 場獨贏，再照票串。`
        : rule,
  };
}

/**
 * 組合同日 R1 獨贏 × Hybrid Under 串關（衛星；與獨贏主串分離）。
 */
export function buildR1xHybridUnderParlay({
  moneylinePicks = [],
  hybridTotalsPicks = [],
  stakeUsd = MLB_LOCKED_B_PACKAGE.parlays.stakeUsd,
  preferDifferentGame = true,
} = {}) {
  const spec = MLB_LOCKED_B_PACKAGE.parlays.secondary;
  if (!moneylinePicks.length) {
    return {
      available: false,
      id: spec.id,
      label: spec.label,
      reason: '無可看獨贏選邊',
      suggestedStakeUsd: stakeUsd,
      legs: [],
    };
  }
  const unders = (hybridTotalsPicks || []).filter((p) => p.side === 'under');
  if (!unders.length) {
    return {
      available: false,
      id: spec.id,
      label: spec.label,
      reason: '今日無 Hybrid Under',
      suggestedStakeUsd: stakeUsd,
      legs: [],
    };
  }
  const r1 = [...moneylinePicks].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  const sortedUnder = [...unders].sort(
    (a, b) =>
      (b.expectedValue || 0) - (a.expectedValue || 0) ||
      (b.absGap || 0) - (a.absGap || 0)
  );
  let tot = preferDifferentGame
    ? sortedUnder.find((t) => t.gameId !== r1.gameId)
    : null;
  if (!tot) tot = sortedUnder[0];
  if (!tot || !Number.isFinite(Number(r1.oddsDecimal)) || !Number.isFinite(Number(tot.oddsDecimal))) {
    return {
      available: false,
      id: spec.id,
      label: spec.label,
      reason: '串關腿賠率不完整',
      suggestedStakeUsd: stakeUsd,
      legs: [],
    };
  }
  const combined = Number(r1.oddsDecimal) * Number(tot.oddsDecimal);
  return {
    available: true,
    id: spec.id,
    label: spec.label,
    rule: spec.rule,
    suggestedStakeUsd: stakeUsd,
    combinedOdds: Number(combined.toFixed(3)),
    sameGame: tot.gameId === r1.gameId,
    legs: [
      {
        market: 'h2h',
        rank: r1.rank,
        gameId: r1.gameId,
        matchup: r1.matchup,
        pick: r1.pick,
        oddsDecimal: r1.oddsDecimal,
      },
      {
        market: 'totals',
        rank: tot.rank,
        gameId: tot.gameId,
        matchup: tot.matchup,
        pick: tot.pick,
        side: tot.side,
        line: tot.line,
        oddsDecimal: tot.oddsDecimal,
        expectedValue: tot.expectedValue,
      },
    ],
  };
}

export function buildLockedBPackageSnapshot({
  moneylinePicks = [],
  hybridTotalsPicks = [],
  sameDayMlParlay = null,
  stakeUsd = MLB_LOCKED_B_PACKAGE.flatStakeUsd,
  parlayStakeUsd = MLB_LOCKED_B_PACKAGE.parlays.stakeUsd,
} = {}) {
  const star = buildStarMoneylineParlayBundle({
    moneylinePicks,
    stakeUsd: parlayStakeUsd,
    singleStakeUsd: stakeUsd,
  });

  const r1Under = buildR1xHybridUnderParlay({
    moneylinePicks,
    hybridTotalsPicks,
    stakeUsd: parlayStakeUsd,
    preferDifferentGame: MLB_LOCKED_B_PACKAGE.parlays.secondary.preferDifferentGame,
  });

  /** 相容舊欄位：primary = 首張 Star 票（或舊 2 串） */
  const primary =
    star.tickets[0] ||
    (sameDayMlParlay?.available
      ? {
          available: true,
          id: sameDayMlParlay.id || 'same_day_ml_2leg',
          label: sameDayMlParlay.label || '同日獨贏 2 串',
          rule: sameDayMlParlay.rule,
          suggestedStakeUsd: parlayStakeUsd,
          combinedOdds: sameDayMlParlay.combinedOdds,
          legs: (sameDayMlParlay.legs || []).map((leg) => ({ market: 'h2h', ...leg })),
        }
      : {
          available: false,
          id: 'star_ml_parlay_discipline',
          label: MLB_LOCKED_B_PACKAGE.parlays.star.label,
          reason: star.reason || 'Star 串關不可用',
          suggestedStakeUsd: parlayStakeUsd,
          legs: [],
        });

  const singles = [
    ...moneylinePicks.map((p) => ({
      market: 'h2h',
      marketLabel: '獨贏',
      rank: p.rank,
      gameId: p.gameId,
      matchup: p.matchup,
      commenceTime: p.commenceTime,
      pick: p.pick,
      oddsDecimal: p.oddsDecimal,
      modelProbability: p.modelProbability,
      marketProbability: p.marketProbability,
      expectedValue: p.expectedValue,
      stakeUsd,
    })),
    ...hybridTotalsPicks.map((p) => ({
      market: 'totals',
      marketLabel: '大小',
      rank: p.rank,
      gameId: p.gameId,
      matchup: p.matchup,
      commenceTime: p.commenceTime,
      pick: p.pick,
      side: p.side,
      line: p.line,
      oddsDecimal: p.oddsDecimal,
      modelProbability: p.modelProbability,
      marketProbability: p.marketProbability,
      expectedValue: p.expectedValue,
      hybridPath: p.hybridPath,
      stakeUsd,
    })),
  ];

  return {
    id: MLB_LOCKED_B_PACKAGE.id,
    label: MLB_LOCKED_B_PACKAGE.label,
    note: MLB_LOCKED_B_PACKAGE.note,
    flatStakeUsd: stakeUsd,
    parlayStakeUsd,
    moneylineCount: moneylinePicks.length,
    totalsCount: hybridTotalsPicks.length,
    singles,
    parlays: {
      star,
      primary,
      secondary: r1Under,
      tickets: star.tickets,
      recommendedOrder: ['star', 'secondary'],
      note:
        star.available
          ? `注碼紀律：單場 $${stakeUsd}／串關 $${parlayStakeUsd}（一半）。${star.howToBet} 禁止四串。大小混串見衛星票（可選、同用串關注碼）。`
          : star.reason || '今日串關暫無',
    },
    stakeGuide: {
      singleUsd: stakeUsd,
      parlayUsd: parlayStakeUsd,
      ratio: 'parlay = single / 2',
      text: `單場 $${stakeUsd} → 串關 $${parlayStakeUsd}`,
    },
    spec: MLB_LOCKED_B_PACKAGE,
  };
}
