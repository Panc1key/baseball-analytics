export const MARKET_LABELS = {
  h2h: '獨贏',
  spreads: '讓分',
  totals: '大小',
  pitcher_strikeouts: '投手三振',
  pitcher_outs: '投手出局',
  pitcher_hits_allowed: '投手被安打',
  batter_hits: '打者安打',
  batter_total_bases: '打者總壘打',
  batter_home_runs: '打者全壘打',
};

export function marketLabel(market) {
  return MARKET_LABELS[market] || market;
}

export function tierLabel(tier) {
  return { primary: '主推', watch: '觀察' }[tier] || tier;
}

export function formatGameTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-TW', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function leagueLabel(league) {
  return { MLB: 'MLB 美職', NPB: 'NPB 日職', KBO: 'KBO 韓職' }[league] || league;
}

export function isPropMarket(market) {
  return market?.startsWith('pitcher_') || market?.startsWith('batter_');
}
