/**
 * MLB 主場座標與屋頂類型（賽前可知靜態表）。
 * 用於天氣查詢與室內場中性化，不依賴即時 API。
 */
import { MLB_TEAM_HOME_VENUE } from './parkFactors.js';

export const MLB_VENUE_META = {
  'Chase Field': {
    latitude: 33.4455,
    longitude: -112.0667,
    roof: 'retractable',
  },
  'Truist Park': {
    latitude: 33.8908,
    longitude: -84.4679,
    roof: 'open',
  },
  'Oriole Park at Camden Yards': {
    latitude: 39.2839,
    longitude: -76.6217,
    roof: 'open',
  },
  'Fenway Park': {
    latitude: 42.3467,
    longitude: -71.0972,
    roof: 'open',
  },
  'Wrigley Field': {
    latitude: 41.9484,
    longitude: -87.6553,
    roof: 'open',
  },
  'Rate Field': {
    latitude: 41.8299,
    longitude: -87.6338,
    roof: 'open',
  },
  'Great American Ball Park': {
    latitude: 39.0979,
    longitude: -84.5082,
    roof: 'open',
  },
  'Progressive Field': {
    latitude: 41.4962,
    longitude: -81.6852,
    roof: 'open',
  },
  'Coors Field': {
    latitude: 39.7559,
    longitude: -104.9942,
    roof: 'open',
  },
  'Comerica Park': {
    latitude: 42.3390,
    longitude: -83.0485,
    roof: 'open',
  },
  'Minute Maid Park': {
    latitude: 29.7573,
    longitude: -95.3555,
    roof: 'retractable',
  },
  'Kauffman Stadium': {
    latitude: 39.0517,
    longitude: -94.4803,
    roof: 'open',
  },
  'Angel Stadium': {
    latitude: 33.8003,
    longitude: -117.8827,
    roof: 'open',
  },
  'Dodger Stadium': {
    latitude: 34.0739,
    longitude: -118.2400,
    roof: 'open',
  },
  'loanDepot park': {
    latitude: 25.7781,
    longitude: -80.2197,
    roof: 'retractable',
  },
  'American Family Field': {
    latitude: 43.0280,
    longitude: -87.9712,
    roof: 'retractable',
  },
  'Target Field': {
    latitude: 44.9817,
    longitude: -93.2776,
    roof: 'open',
  },
  'Citi Field': {
    latitude: 40.7571,
    longitude: -73.8458,
    roof: 'open',
  },
  'Yankee Stadium': {
    latitude: 40.8296,
    longitude: -73.9262,
    roof: 'open',
  },
  'Sutter Health Park': {
    latitude: 38.5802,
    longitude: -121.5133,
    roof: 'open',
  },
  'Oakland Coliseum': {
    latitude: 37.7516,
    longitude: -122.2005,
    roof: 'open',
  },
  'Citizens Bank Park': {
    latitude: 39.9061,
    longitude: -75.1665,
    roof: 'open',
  },
  'PNC Park': {
    latitude: 40.4469,
    longitude: -80.0057,
    roof: 'open',
  },
  'Petco Park': {
    latitude: 32.7076,
    longitude: -117.1570,
    roof: 'open',
  },
  'Oracle Park': {
    latitude: 37.7786,
    longitude: -122.3893,
    roof: 'open',
  },
  'T-Mobile Park': {
    latitude: 47.5914,
    longitude: -122.3325,
    roof: 'retractable',
  },
  'Busch Stadium': {
    latitude: 38.6226,
    longitude: -90.1928,
    roof: 'open',
  },
  'Tropicana Field': {
    latitude: 27.7682,
    longitude: -82.6534,
    roof: 'fixed',
  },
  'Globe Life Field': {
    latitude: 32.7472,
    longitude: -97.0834,
    roof: 'retractable',
  },
  'Rogers Centre': {
    latitude: 43.6414,
    longitude: -79.3894,
    roof: 'retractable',
  },
  'Nationals Park': {
    latitude: 38.8730,
    longitude: -77.0074,
    roof: 'open',
  },
};

export function resolveMlbVenueName({ venueName = null, homeTeam = null } = {}) {
  if (venueName && MLB_VENUE_META[venueName]) return venueName;
  if (venueName) {
    const hit = Object.keys(MLB_VENUE_META).find((name) =>
      name.toLowerCase() === String(venueName).toLowerCase()
    );
    if (hit) return hit;
  }
  if (homeTeam && MLB_TEAM_HOME_VENUE[homeTeam]) {
    return MLB_TEAM_HOME_VENUE[homeTeam];
  }
  return venueName || null;
}

export function resolveMlbVenueMeta({ venueName = null, homeTeam = null } = {}) {
  const resolvedName = resolveMlbVenueName({ venueName, homeTeam });
  if (!resolvedName || !MLB_VENUE_META[resolvedName]) return null;
  return {
    venueName: resolvedName,
    ...MLB_VENUE_META[resolvedName],
  };
}

/** 固定穹頂視為室內；可開合屋頂保守視為半室外（天氣仍可影響但權重較弱）。 */
export function outdoorExposure(roof) {
  if (roof === 'fixed') return 0;
  if (roof === 'retractable') return 0.35;
  return 1;
}
