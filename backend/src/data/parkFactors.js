/**
 * MLB 球場跑分係數（相對聯盟平均，簡化靜態表）
 * 1.0 = 平均，>1 有利打擊，<1 有利投手
 *
 * 歷史 feature rows 沒有 venue 欄位時，可用主隊對應主場做 PIT 安全近似。
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
  'Truist Park': 1.02,
  'Rate Field': 1.01,
  'Progressive Field': 0.99,
  'Comerica Park': 0.98,
  'Minute Maid Park': 1.01,
  'Dodger Stadium': 0.96,
  'American Family Field': 1.02,
  'Citi Field': 0.97,
  'PNC Park': 0.96,
  'Busch Stadium': 0.98,
  'Tropicana Field': 0.97,
  'Rogers Centre': 1.02,
  'Nationals Park': 1.0,
};

export const MLB_TEAM_HOME_VENUE = {
  'Arizona Diamondbacks': 'Chase Field',
  'Atlanta Braves': 'Truist Park',
  'Baltimore Orioles': 'Oriole Park at Camden Yards',
  'Boston Red Sox': 'Fenway Park',
  'Chicago Cubs': 'Wrigley Field',
  'Chicago White Sox': 'Rate Field',
  'Cincinnati Reds': 'Great American Ball Park',
  'Cleveland Guardians': 'Progressive Field',
  'Colorado Rockies': 'Coors Field',
  'Detroit Tigers': 'Comerica Park',
  'Houston Astros': 'Minute Maid Park',
  'Kansas City Royals': 'Kauffman Stadium',
  'Los Angeles Angels': 'Angel Stadium',
  'Los Angeles Dodgers': 'Dodger Stadium',
  'Miami Marlins': 'loanDepot park',
  'Milwaukee Brewers': 'American Family Field',
  'Minnesota Twins': 'Target Field',
  'New York Mets': 'Citi Field',
  'New York Yankees': 'Yankee Stadium',
  Athletics: 'Sutter Health Park',
  'Oakland Athletics': 'Sutter Health Park',
  'Philadelphia Phillies': 'Citizens Bank Park',
  'Pittsburgh Pirates': 'PNC Park',
  'San Diego Padres': 'Petco Park',
  'San Francisco Giants': 'Oracle Park',
  'Seattle Mariners': 'T-Mobile Park',
  'St. Louis Cardinals': 'Busch Stadium',
  'Tampa Bay Rays': 'Tropicana Field',
  'Texas Rangers': 'Globe Life Field',
  'Toronto Blue Jays': 'Rogers Centre',
  'Washington Nationals': 'Nationals Park',
};

export function getParkFactor(venueName) {
  if (!venueName) return 1.0;
  if (PARK_FACTORS[venueName]) return PARK_FACTORS[venueName];

  const lower = venueName.toLowerCase();
  if (lower.includes('coors')) return 1.18;
  if (lower.includes('oracle') || lower.includes('petco')) return 0.93;
  if (lower.includes('fenway')) return 1.06;
  if (lower.includes('t-mobile') || lower.includes('tmobile')) return 0.96;
  if (lower.includes('yankee')) return 1.04;
  if (lower.includes('great american')) return 1.08;

  return 1.0;
}

export function resolveMlbParkFactor({ venueName = null, homeTeam = null } = {}) {
  if (venueName) return getParkFactor(venueName);
  if (homeTeam && MLB_TEAM_HOME_VENUE[homeTeam]) {
    return getParkFactor(MLB_TEAM_HOME_VENUE[homeTeam]);
  }
  return 1.0;
}
