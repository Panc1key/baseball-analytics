/**
 * 先發質量指數與對對手得分影響（MLB / KBO / NPB 共用）
 */

/**
 * 先發投手質量指數（越高越差）
 */
export function pitcherQualityIndex(pitcherStats) {
  if (!pitcherStats) {
    return { index: 0, tier: 'unknown', weak: false, solid: false, elite: false, era: null, whip: null };
  }
  const era = pitcherStats.era ?? 4.5;
  const whip = pitcherStats.whip ?? 1.3;
  const index = (era - 4.5) * 0.55 + (whip - 1.3) * 2.2;

  let tier = 'avg';
  if (index > 0.85 || era >= 5.2 || whip >= 1.48) tier = 'weak';
  else if (index > 0.35 || era >= 4.8) tier = 'below_avg';
  else if (index < -0.35 && era <= 3.6 && whip <= 1.12) tier = 'elite';
  else if (index < 0.15 && era <= 4.0) tier = 'solid';

  return {
    index,
    tier,
    weak: tier === 'weak' || tier === 'below_avg',
    solid: tier === 'solid' || tier === 'elite',
    elite: tier === 'elite',
    era,
    whip,
  };
}

/**
 * 先發對對手得分的影響（弱投非線性放大）
 * @param {object|null} pitcherStats
 * @param {{ scale?: number }} [options]
 */
export function pitcherRunSuppression(pitcherStats, options = {}) {
  if (!pitcherStats) return 0;
  const scale = Number.isFinite(options.scale) ? options.scale : 1;
  const q = pitcherQualityIndex(pitcherStats);
  let delta = 0;
  if (q.tier === 'weak') {
    delta = 0.45 + Math.max(0, q.index) * 0.5;
  } else if (q.tier === 'below_avg') {
    delta = 0.22 + Math.max(0, q.index) * 0.35;
  } else if (q.elite) {
    delta = -0.35 + q.index * 0.25;
  } else {
    delta = q.index * 0.35;
  }
  return delta * scale;
}
