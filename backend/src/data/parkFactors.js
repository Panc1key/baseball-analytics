/**
 * MLB 球場跑分係數（相對聯盟平均，簡化靜態表）
 * 1.0 = 平均，>1 有利打擊，<1 有利投手
 */
export const PARK_FACTORS = {
  'Coors Field': 1.18,
  'Great American Ball Park': 1.08,
  'Fenway Park': 1.06,
  'Globe Life Field': 1.05,
  'Yankee Stadium': 1.04,
  'Citizens Bank Park': 1.04,
  'Oriole Park at Camden Yards': 1.03,
  'Wrigley Field': 1.03,
  'Target Field': 1.02,
  'Angel Stadium': 1.01,
  'Chase Field': 1.01,
  'loanDepot park': 1.0,
  'T-Mobile Park': 0.96,
  'Petco Park': 0.94,
  'Oracle Park': 0.92,
  'Kauffman Stadium': 0.97,
  'Oakland Coliseum': 0.95,
  'Sutter Health Park': 0.95,
};

export function getParkFactor(venueName) {
  if (!venueName) return 1.0;
  if (PARK_FACTORS[venueName]) return PARK_FACTORS[venueName];

  const lower = venueName.toLowerCase();
  if (lower.includes('coors')) return 1.18;
  if (lower.includes('oracle') || lower.includes('petco')) return 0.93;
  if (lower.includes('fenway')) return 1.06;

  return 1.0;
}
