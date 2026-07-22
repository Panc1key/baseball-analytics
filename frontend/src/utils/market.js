export const MARKET_LABELS = {
  h2h: '獨贏',
  spreads: '讓分',
  totals: '大小',
  corners_totals: '角球大小',
  team_totals: '球隊大小',
  pitcher_strikeouts: '投手三振',
  pitcher_outs: '投手出局',
  pitcher_hits_allowed: '投手被安打',
  batter_hits: '打者安打',
  batter_total_bases: '打者總壘打',
  player_to_receive_card: '吃牌',
  // 足球
  player_goal_scorer_anytime: '任意時間進球',
  player_first_goal_scorer: '首個進球',
  player_shots_on_target: '射正',
  player_shots: '射門',
  player_assists: '助攻',
};

export function marketLabel(market) {
  return MARKET_LABELS[market] || market;
}

export function tierLabel(tier) {
  return {
    // primary≠必下：僅高評分關注；真下看「均注」
    primary: '關注',
    watch: '觀察',
    sample: '樣本',
  }[tier] || tier;
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
  return { MLB: 'MLB 美職', NPB: 'NPB 日職', KBO: 'KBO 韓職', WC: '世界盃' }[league] || league;
}

export function isPropMarket(market) {
  return (
    market?.startsWith('pitcher_') ||
    market?.startsWith('batter_') ||
    market?.startsWith('player_')
  );
}
