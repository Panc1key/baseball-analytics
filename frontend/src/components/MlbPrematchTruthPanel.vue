<template>
  <section class="truth-panel" v-loading="loading">
    <header class="toolbar">
      <div>
        <h2 class="panel-title">今日鎖定 B · 下注板</h2>
        <p class="panel-sub">
          單場 ${{ packageStake }} · 串關 ${{ parlayStake }} · 開賽前 {{ releaseHoursBefore || 8 }}h 才顯示獨贏選邊
        </p>
      </div>
      <el-button size="small" plain :loading="loading" @click="loadTruth">重新載入</el-button>
    </header>

    <p class="schedule-note">港時查看：今晚 <strong>20:00–23:00</strong> · 只下「現在可下」（開賽前 {{ releaseHoursBefore || 8 }}h）</p>

    <div class="action-board">
      <div class="action-head">
        <span class="action-badge">現在可下</span>
        <span class="action-summary">
          獨贏 {{ dailyTop.length }} · 大小 {{ totalsHybridPicks.length }} · 串關 {{ starParlayTickets.length }}
        </span>
      </div>

      <div v-if="!loading && !hasActionableBets" class="action-empty">
        <p class="empty-title">此刻沒有可下主倉</p>
        <p class="empty-body">
          <template v-if="heldUntilRelease.length">
            已有 {{ heldUntilRelease.length }} 場獨贏過閘，約 {{ soonestHeldHours }} 後放出選邊（見「稍後放出」）。
          </template>
          <template v-else>
            今日多數未過鎖定 B（常見 EV／賠率／分差）。不是壞掉。
          </template>
        </p>
      </div>

      <div v-if="dailyTop.length" class="picks-block action-block">
        <div class="block-label">獨贏主倉 · 各 ${{ packageStake }}</div>
        <table class="picks-table">
          <thead>
            <tr>
              <th class="col-rank">#</th>
              <th>對陣</th>
              <th>選邊</th>
              <th class="num">賠率</th>
              <th class="num">EV</th>
              <th class="num">注碼</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in dailyTop" :key="item.gameId" :class="{ 'is-top': item.rank === 1 }">
              <td class="col-rank">{{ item.rank }}</td>
              <td class="matchup">{{ item.matchup }}</td>
              <td class="pick">{{ item.pick || '—' }}</td>
              <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
              <td class="num">{{ percent(item.expectedValue) }}</td>
              <td class="num stake-cell">${{ packageStake }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalsHybridPicks.length" class="picks-block action-block">
        <div class="block-label">大小 Hybrid · 各 ${{ totalsSatStake }}（分帳）</div>
        <table class="picks-table">
          <thead>
            <tr>
              <th class="col-rank">#</th>
              <th>對陣</th>
              <th>選邊</th>
              <th class="num">盤口</th>
              <th class="num">賠率</th>
              <th class="num">EV</th>
              <th class="num">注碼</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in totalsHybridPicks" :key="`tot-h-${item.gameId}`">
              <td class="col-rank">{{ item.rank }}</td>
              <td class="matchup">{{ item.matchup }}</td>
              <td class="pick">{{ item.pick || '—' }}</td>
              <td class="num">{{ item.line ?? '—' }}</td>
              <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
              <td class="num">{{ percent(item.expectedValue) }}</td>
              <td class="num stake-cell">${{ totalsSatStake }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="starParlayTickets.length" class="picks-block action-block parlay-block">
        <div class="block-label">Star 串關 · 每票 ${{ parlayStake }}</div>
        <div
          v-for="(ticket, tIdx) in starParlayTickets"
          :key="ticket.id || `star-${tIdx}`"
          class="parlay-card star-ticket"
        >
          <div class="parlay-title">
            <span class="ticket-idx">票 {{ tIdx + 1 }}</span>
            {{ ticket.label }}
            <span class="ticket-stake">下 ${{ ticket.suggestedStakeUsd || parlayStake }}</span>
          </div>
          <p class="parlay-line">
            <template v-for="(leg, idx) in ticket.legs" :key="`${ticket.id}-${idx}`">
              <span v-if="idx"> × </span>
              <strong>R{{ leg.rank }}</strong>
              {{ leg.pick }}（{{ formatOdds(leg.oddsDecimal) }}）
              <span class="leg-matchup">{{ leg.matchup }}</span>
            </template>
          </p>
          <p class="parlay-combined">合計約 {{ formatOdds(ticket.combinedOdds) }}</p>
        </div>
      </div>

      <div v-if="parlaySecondary?.available" class="picks-block action-block">
        <div class="block-label">衛星混串（可選）· ${{ parlaySecondary.suggestedStakeUsd || parlayStake }}</div>
        <div class="parlay-card satellite-ticket">
          <p class="parlay-line">
            <template v-for="(leg, idx) in parlaySecondary.legs" :key="`sat-${idx}`">
              <span v-if="idx"> × </span>{{ leg.pick }}（{{ formatOdds(leg.oddsDecimal) }}）
            </template>
            · 合計約 {{ formatOdds(parlaySecondary.combinedOdds) }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="heldUntilRelease.length || totalsHybridHeld.length" class="picks-block held-block">
      <div class="block-label">稍後放出（先別下）</div>
      <ul class="held-list">
        <li v-for="item in heldUntilRelease" :key="`held-ml-${item.gameId}`">
          <span class="held-tag">獨贏</span>
          {{ item.matchup }}
          <span class="held-eta">約 {{ formatHoursUntil(item.hoursUntilCommence) }} 後顯示選邊</span>
        </li>
        <li v-for="item in totalsHybridHeld.slice(0, 6)" :key="`held-tot-${item.gameId}`">
          <span class="held-tag tot">大小</span>
          {{ item.matchup }}
          <span class="held-eta">
            <template v-if="item.holdReason === 'data_incomplete_pitchers'">缺先發</template>
            <template v-else>約 {{ formatHoursUntil(item.hoursUntilCommence) }}</template>
          </span>
        </li>
      </ul>
    </div>

    <div v-if="!loading && todayFunnel" class="funnel-strip compact">
      <span>今日 {{ todayFunnel.upcoming }}</span>
      <span>可看獨贏 {{ todayFunnel.selected }}</span>
      <span>未放出 {{ todayFunnel.passedGatesHeld || heldUntilRelease.length }}</span>
      <span>資料未齊 {{ todayFunnel.pendingData }}</span>
      <span v-if="topFunnelReason">主因 {{ topFunnelReason }}</span>
    </div>

    <p v-if="highEvShrinkNote" class="shadow-overlay-note quiet" :class="{ apply: highEvShrinkApply }">
      {{ highEvShrinkNote }}
    </p>

    <details class="diag-fold">
      <summary>診斷與對照線（一般下注可忽略）</summary>

      <div v-if="analyzedExcluded.length" class="picks-block">
        <div class="block-label">未入選（{{ analyzedExcluded.length }}）</div>
        <table class="picks-table">
          <thead>
            <tr><th>開賽</th><th>對陣</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="game in analyzedExcluded" :key="`ex-${game.truthSnapshotId}`">
              <td class="time-cell">{{ formatTime(game.commenceTime) }}</td>
              <td class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</td>
              <td class="missing">{{ exclusionReasonText(game) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="pendingData.length" class="picks-block blocked">
        <div class="block-label">資料未齊（{{ pendingData.length }}）</div>
        <table class="picks-table">
          <thead>
            <tr><th>開賽</th><th>對陣</th><th>還缺</th></tr>
          </thead>
          <tbody>
            <tr v-for="game in pendingData" :key="`pend-${game.truthSnapshotId}`">
              <td class="time-cell">{{ formatTime(game.commenceTime) }}</td>
              <td class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</td>
              <td class="missing">{{ missingCriticalText(game.dataReadiness?.missingCritical) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalsUnderOnlyPicks.length" class="picks-block research-sat">
        <div class="block-label">Under 對照（非主打）</div>
        <table class="picks-table">
          <thead>
            <tr><th>對陣</th><th>選邊</th><th class="num">賠率</th><th class="num">EV</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in totalsUnderOnlyPicks" :key="`tot-u-${item.gameId}`">
              <td class="matchup">{{ item.matchup }}</td>
              <td class="pick">{{ item.pick || '—' }}</td>
              <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
              <td class="num">{{ percent(item.expectedValue) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalsSatellitePicks.length" class="picks-block research-sat">
        <div class="block-label">both 對照（非主打）</div>
        <table class="picks-table">
          <thead>
            <tr><th>對陣</th><th>選邊</th><th class="num">賠率</th><th class="num">EV</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in totalsSatellitePicks" :key="`tot-${item.gameId}`">
              <td class="matchup">{{ item.matchup }}</td>
              <td class="pick">{{ item.pick || '—' }}</td>
              <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
              <td class="num">{{ percent(item.expectedValue) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <details class="meta-fold" v-if="upcomingGames.length" style="margin-top:12px">
        <summary>展開原始資料清單</summary>
        <article v-for="game in upcomingGames" :key="`detail-${game.truthSnapshotId}`" class="game-card">
          <header class="game-head">
            <div>
              <div class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</div>
              <div class="time">{{ formatTime(game.commenceTime) }}</div>
            </div>
            <div class="status-plain">
              <span :class="game.dataReadiness?.recommendationAllowed ? 'data-ok' : 'data-bad'">
                {{ bucketLabel(game) }} · {{ game.dataReadiness?.scorePct ?? Math.round((game.completeness || 0) * 100) }}%
              </span>
            </div>
          </header>
        </article>
      </details>
    </details>

    <div v-if="!loading && !dailyTop.length && dataLag?.stale" class="empty-picks stale">
      <p class="empty-title">本機沒有今日場次</p>
      <p class="empty-body">請同步今日 MLB。</p>
    </div>

    <el-empty
      v-if="!loading && !games.length"
      description="尚無 MLB 賽前快照。請重新載入或同步今日賽程。"
    />
  </section>
</template>


<script setup>
import { computed, ref } from 'vue';
import { getMlbPrematchTruth } from '../api/index.js';

const loading = ref(false);
const truth = ref(null);

const games = computed(() => truth.value?.games || []);
const dailyTop = computed(() => truth.value?.expectedRunsTop || []);
const heldUntilRelease = computed(() => truth.value?.heldUntilRelease || []);
const releaseHoursBefore = computed(
  () => truth.value?.releasePolicy?.hoursBefore ?? 8
);
const dataLag = computed(() => truth.value?.dataLag || null);
const sameDayParlay = computed(() => truth.value?.sameDayParlay || null);
const totalsSatellite = computed(() => truth.value?.totalsSatellite || null);
const totalsSatellitePicks = computed(() => totalsSatellite.value?.picks || []);
const totalsSatelliteUnderOnly = computed(() => truth.value?.totalsSatelliteUnderOnly || null);
const totalsUnderOnlyPicks = computed(() => totalsSatelliteUnderOnly.value?.picks || []);
const totalsSatelliteHybrid = computed(() => truth.value?.totalsSatelliteHybrid || null);
const totalsHybridPicks = computed(() => totalsSatelliteHybrid.value?.picks || []);
const totalsHybridHeld = computed(() => totalsSatelliteHybrid.value?.held || []);
const totalsHybridBlockedNotable = computed(
  () => totalsSatelliteHybrid.value?.blockedNotable || []
);
const totalsHybridMaxLine = computed(
  () => Number(totalsSatelliteHybrid.value?.maxTotalLine) || 10
);
const totalsSatStake = computed(
  () =>
    Number(totalsSatelliteHybrid.value?.suggestedStakeUsd) ||
    Number(totalsSatelliteUnderOnly.value?.suggestedStakeUsd) ||
    50
);
const lockedBPackage = computed(() => truth.value?.lockedBPackage || null);
const packageSingles = computed(() => lockedBPackage.value?.singles || []);
const packageStake = computed(
  () => Number(lockedBPackage.value?.flatStakeUsd) || totalsSatStake.value || 50
);
const parlayStake = computed(
  () =>
    Number(lockedBPackage.value?.parlayStakeUsd) ||
    Number(starParlayBundle.value?.suggestedStakeUsd) ||
    Math.round(packageStake.value / 2) ||
    25
);
const starParlayBundle = computed(
  () => lockedBPackage.value?.parlays?.star || null
);
const starParlayTickets = computed(
  () =>
    lockedBPackage.value?.parlays?.tickets ||
    lockedBPackage.value?.parlays?.star?.tickets ||
    []
);
const parlayPrimary = computed(() => lockedBPackage.value?.parlays?.primary || sameDayParlay.value);
const parlaySecondary = computed(() => lockedBPackage.value?.parlays?.secondary || null);
const hasActionableBets = computed(
  () =>
    dailyTop.value.length > 0 ||
    totalsHybridPicks.value.length > 0 ||
    starParlayTickets.value.length > 0 ||
    Boolean(parlaySecondary.value?.available)
);
const soonestHeldHours = computed(() => {
  const hours = heldUntilRelease.value
    .map((r) => Number(r.hoursUntilCommence))
    .filter((h) => Number.isFinite(h));
  if (!hours.length) return '—';
  return formatHoursUntil(Math.min(...hours));
});
const stakeGuideText = computed(() => {
  const g = lockedBPackage.value?.stakeGuide;
  if (g?.text) return `注碼紀律：${g.text}（串關 = 單場 ÷ 2）`;
  return `注碼紀律：單場 $${packageStake.value} → 串關 $${parlayStake.value}`;
});

function hybridPathLabel(item) {
  if (item?.hybridPath === 'raw_under') return 'Under·raw';
  if (item?.hybridPath === 'pitcher_debiased_over') return 'Over·投手去偏';
  if (item?.hybridPath === 'raw_over') return 'Over·raw';
  return item?.side === 'under' ? 'Under' : item?.side === 'over' ? 'Over' : '—';
}
const todayFunnel = computed(() => truth.value?.todayFunnel || null);
const highEvShrink = computed(() => truth.value?.highEvShrinkShadow || null);
const highEvShrinkApply = computed(() => Boolean(highEvShrink.value?.appliesToVisiblePicks));
const highEvShrinkNote = computed(() => {
  const s = highEvShrink.value;
  if (!s?.enabled && s?.mode === 'off') return null;
  if (!s?.mode || s.mode === 'off') return null;
  const diff = s.diff;
  const deltaBits =
    diff && !diff.sameSlots
      ? ` · 對照差：+${(diff.added || []).length}/−${(diff.dropped || []).length} 場`
      : diff?.sameSlots
        ? ' · 今日與正式名額相同'
        : '';
  const obs = s.observation?.status ? ` · 觀察：${s.observation.status}` : '';
  if (s.mode === 'apply') {
    return `影子 overlay shrink_w15_l15 已套用至可看選邊（非升格常數）${obs}`;
  }
  return `影子 overlay shrink_w15_l15 對照中（正式選邊不變）${deltaBits}${obs}`;
});

const selectedIds = computed(() => new Set(dailyTop.value.map((row) => row.gameId)));
const heldIds = computed(() => new Set(heldUntilRelease.value.map((row) => row.gameId)));

const upcomingGames = computed(() =>
  [...games.value].sort((a, b) =>
    String(a.commenceTime || '').localeCompare(String(b.commenceTime || ''))
  )
);

/** 關鍵資料未齊：尚未做正式入選判斷 */
const pendingData = computed(() =>
  upcomingGames.value.filter((game) => !game.dataReadiness?.recommendationAllowed)
);

/**
 * 分析完成但未入選：資料齊、已有分類結果，且不在可看選邊。
 * （含嚴格擋下與 value_watch 觀察級）
 */
const analyzedExcluded = computed(() =>
  upcomingGames.value.filter((game) => {
    if (!game.dataReadiness?.recommendationAllowed) return false;
    if (selectedIds.value.has(game.gameId)) return false;
    if (heldIds.value.has(game.gameId)) return false;
    return Boolean(game.expectedRuns?.moneylineClassification) || Boolean(game.research?.status);
  })
);

const labels = {
  fixture: '官方賽程匹配',
  odds: '初盤雙邊賠率',
  venue: '球場名稱',
  starting_pitchers: '雙方預定先發',
  official_history: '官方戰績特徵',
  model_history: '模型同口徑歷史',
  bullpen: '牛棚負荷',
  lineup: '確認打線',
  injuries: '傷停名單',
  pitcher_injury_intel: '先發傷病情報',
  park: '球場係數',
  weather: '天氣',
  travel_rest: '旅行／休息',
};

const reasonLabels = {
  expected_value_below_threshold: 'EV 不足',
  expected_run_margin_below_threshold: '分差不足',
  model_probability_below_threshold: '模型勝率不足',
  pick_odds_below_minimum: '賠率低於下限',
  pick_odds_above_maximum: '賠率高於上限',
  pick_early_exits_higher_than_opponent: '選邊先發早退偏多',
  moneyline_either_side_odds_too_short: '任一邊賠率過低',
  h2h_bookmakers_below_minimum: '開盤 book 數不足',
  feature_out_of_distribution: '特徵超出訓練分佈',
  pitcher_identity_incomplete: '先發身份不完整',
  strict_pit_starter_required: '先發 PIT 身份未齊',
  regime_routes_to_totals: '路線改走大小球',
  both_stable_starters_prefer_totals_under: '雙穩先發偏 unders',
  abs_gap_below_threshold: '總分差不足',
  edge_vs_market_below_threshold: '相對市場優勢不足',
  mean_prob_disagree: '均值與機率方向不一致',
  totals_market_missing: '缺大小分盤口',
  totals_prediction_missing: '缺總分預測',
  total_line_above_maximum: '大小分盤口過高',
  regime_totals_primary_moneyline_secondary: '獨贏為次優先',
  one_sided_collapse_risk_no_auto_totals_lean: '單邊崩盤風險',
};

const funnelReasonLabels = {
  ...reasonLabels,
  starting_pitchers: '雙方預定先發未齊',
  odds: '初盤未齊',
  fixture: '賽程未齊',
  model_history: '模型歷史未齊',
  data_incomplete: '資料未齊',
  locked_b_excluded: '未過鎖定 B',
  baseline_market_gap_below_threshold: '相對市場優勢不足',
  paper_entry_window_not_due: '尚未到可建帳時點',
};

const topFunnelReason = computed(() => {
  const top = todayFunnel.value?.topReasons?.[0];
  if (!top) return '';
  return `${funnelReasonLabels[top.reason] || top.reason}×${top.n}`;
});

const todayFunnelText = computed(() => {
  if (!todayFunnel.value?.upcoming) return '';
  const held = todayFunnel.value.passedGatesHeld || heldUntilRelease.value.length || 0;
  const passedTotal =
    todayFunnel.value.passedGatesTotal ??
    todayFunnel.value.selected + held;
  const parts = [
    `今日共 ${todayFunnel.value.upcoming} 場`,
    `資料未齊 ${todayFunnel.value.pendingData}`,
    `已分析未入選約 ${Math.max(0, todayFunnel.value.analyzedReady - passedTotal)}`,
  ];
  if (held > 0) parts.push(`過門檻未放出 ${held}`);
  parts.push(`可看選邊 ${todayFunnel.value.selected}`);
  if (topFunnelReason.value) parts.push(`最常見卡點：${topFunnelReason.value}`);
  return parts.join(' · ');
});

const pitcherGapText = computed(() => {
  const g = todayFunnel.value?.pitcherGap;
  if (!g) return '';
  const bits = [];
  if (g.missingCritical) bits.push(`缺先發閘 ${g.missingCritical}`);
  if (g.conflictingIl) bits.push(`IL衝突 ${g.conflictingIl}`);
  if (g.identityIncomplete) bits.push(`身份不完整 ${g.identityIncomplete}`);
  if (g.strictPitFallback) bits.push(`非嚴格PIT ${g.strictPitFallback}`);
  if (g.preferredCompleteOverPartial) bits.push(`保留完整快照 ${g.preferredCompleteOverPartial}`);
  return bits.join(' · ');
});

/** 入選判斷用的主因（略過僅附註的 regime 次要標籤） */
const PRIMARY_EXCLUDE_REASONS = new Set([
  'expected_value_below_threshold',
  'expected_run_margin_below_threshold',
  'model_probability_below_threshold',
  'pick_odds_below_minimum',
  'pick_odds_above_maximum',
  'pick_early_exits_higher_than_opponent',
  'moneyline_either_side_odds_too_short',
  'h2h_bookmakers_below_minimum',
  'feature_out_of_distribution',
  'pitcher_identity_incomplete',
  'strict_pit_starter_required',
  'regime_routes_to_totals',
  'both_stable_starters_prefer_totals_under',
]);

function labelFor(key) {
  return labels[key] || key;
}

function stateSymbol(state) {
  if (state === 'verified') return '齊';
  if (state === 'partial') return '部分';
  return '缺';
}

function missingCriticalText(list = []) {
  if (!list?.length) return '—';
  return list.map((row) => row.label || labelFor(row.key)).join('、');
}

function readinessChecklist(game) {
  if (game.dataReadiness?.checklist?.length) {
    return game.dataReadiness.checklist;
  }
  return (game.evidence || []).map((item) => ({
    key: item.key,
    label: labelFor(item.key),
    weight: '—',
    status: item.status,
    statusLabel: stateSymbol(item.status),
    summary: item.summary,
    blockRecommend: ['odds', 'starting_pitchers', 'fixture', 'model_history'].includes(item.key),
    ok: item.status === 'verified',
    softOk: item.status === 'verified' || item.status === 'partial',
  }));
}

function analyzedResultLabel(game) {
  const tier = game.expectedRuns?.moneylineClassification?.tier || game.researchTier;
  if (tier === 'value_watch') return '觀察級（未嚴格入選）';
  return '已分析・排除';
}

function exclusionReasonText(game) {
  const reasons =
    game.expectedRuns?.moneylineClassification?.reasons ||
    game.research?.rejectionReasons ||
    [];
  const primary = reasons.filter((r) => PRIMARY_EXCLUDE_REASONS.has(r));
  const use = primary.length ? primary : reasons.slice(0, 2);
  if (!use.length) return '未過鎖定 B 綜合門檻';
  return use.map((r) => reasonLabels[r] || r).join('、');
}

function bucketLabel(game) {
  if (selectedIds.value.has(game.gameId)) return '已入選';
  if (heldIds.value.has(game.gameId)) return '過門檻・未到放出時窗';
  if (!game.dataReadiness?.recommendationAllowed) return '資料未齊';
  return '已分析未入選';
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
}

function formatOdds(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function formatHoursUntil(value) {
  const h = Number(value);
  if (!Number.isFinite(h)) return '—';
  if (h >= 10) return `${Math.round(h)}h`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.max(0, Math.round(h * 60))}m`;
}

function score(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function loadTruth() {
  loading.value = true;
  try {
    const result = await getMlbPrematchTruth({
      from: new Date().toISOString(),
    });
    truth.value = result.data || null;
  } finally {
    loading.value = false;
  }
}

defineExpose({ loadTruth });
</script>

<style scoped>
.truth-panel {
  display: grid;
  gap: 16px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #111;
}

.panel-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: #666;
}

.schedule-note {
  margin: 0;
  font-size: 12px;
  color: #555;
}

.shadow-overlay-note {
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: #444;
  border-left: 3px solid #888;
  background: #f7f7f7;
}

.shadow-overlay-note.apply {
  border-left-color: #333;
  background: #f0f0f0;
  font-weight: 500;
}

.picks-block {
  border: 1px solid #ddd;
  background: #fff;
}

.picks-block.blocked {
  border-color: #bbb;
  background: #fafafa;
}

.picks-block.held-block {
  border-color: #c4c4c4;
  background: #f7f7f7;
}

.picks-block.empty-picks .hint {
  padding: 12px;
  margin: 0;
}

.pick.muted,
.num.muted {
  color: #999;
}

.block-label {
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  font-size: 12px;
  font-weight: 600;
  color: #333;
}

.picks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.picks-table th,
.picks-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  text-align: left;
  vertical-align: middle;
}

.picks-table th {
  font-size: 11px;
  font-weight: 600;
  color: #666;
  background: #fafafa;
}

.picks-table tbody tr:last-child td {
  border-bottom: none;
}

.picks-table tr.is-top td {
  background: #f7f7f7;
  font-weight: 500;
}

.col-rank {
  width: 36px;
  color: #666;
  font-variant-numeric: tabular-nums;
}

.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.matchup {
  font-weight: 500;
  color: #111;
}

.pick {
  font-weight: 600;
  color: #111;
}

.missing,
.status-cell {
  color: #555;
  font-size: 12px;
}

.time-cell {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.data-ok {
  color: #1a1a1a;
  font-weight: 600;
}

.data-bad {
  color: #888;
  font-weight: 600;
}

.hint {
  margin: 0;
  padding: 8px 12px;
  font-size: 11px;
  color: #777;
  border-top: 1px solid #eee;
}

.package-note {
  margin: 0 0 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #444;
  background: #f7f7f5;
  border: 1px solid #e8e8e4;
}

.package-note.stake-guide {
  background: #eef6f1;
  border-color: #c5e0d0;
  color: #0b6e4f;
  font-weight: 600;
}

.parlay-block .parlay-card {
  padding: 10px 12px;
  border-top: 1px solid #eee;
}

.parlay-block .star-ticket {
  background: #fafaf8;
  margin-bottom: 6px;
  border: 1px solid #ebebe6;
  border-radius: 4px;
  border-top: 1px solid #ebebe6;
}

.parlay-block .satellite-ticket {
  margin-top: 10px;
  background: #f5f7fa;
  border: 1px dashed #c5cdd8;
  border-radius: 4px;
}

.parlay-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ticket-idx {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  background: #2c3e50;
  color: #fff;
  border-radius: 3px;
}

.ticket-stake {
  margin-left: auto;
  font-size: 12px;
  color: #0b6e4f;
  font-weight: 700;
}

.leg-matchup {
  font-size: 11px;
  color: #888;
  font-weight: 400;
}

.parlay-combined {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: #1a1a1a;
}

.forbid-note {
  color: #8a4b08 !important;
}

.block-meta {
  font-weight: 400;
  color: #777;
  font-size: 12px;
}

.parlay-hint {
  border-top: 1px solid #eee;
  background: #fafafa;
}

.parlay-hint .block-label {
  border-bottom: none;
  padding-bottom: 0;
}

.parlay-line {
  margin: 0;
  padding: 4px 12px 0;
  font-size: 13px;
  color: #222;
}

.funnel-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 8px 12px;
  font-size: 12px;
  color: #555;
  border: 1px solid #e8e8e8;
  background: #fcfcfc;
}

.funnel-line {
  margin-top: 8px;
}

.empty-picks {
  padding: 20px 16px;
  border: 1px dashed #ccc;
  background: #fff;
  text-align: center;
}

.empty-picks.stale {
  border-color: #999;
  background: #fafafa;
}

.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #222;
}

.empty-body {
  margin: 8px 0 0;
  font-size: 13px;
  color: #666;
  line-height: 1.5;
}

.meta-fold {
  border: 1px solid #e5e5e5;
  padding: 8px 12px;
  background: #fff;
}

.meta-fold > summary {
  cursor: pointer;
  font-size: 12px;
  color: #555;
  font-weight: 600;
}

.game-card {
  margin-top: 12px;
  padding: 12px 0;
  border-top: 1px solid #eee;
}

.game-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 8px;
}

.time {
  font-size: 12px;
  color: #777;
  margin-top: 2px;
}

.status-plain {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
}

.evidence-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.evidence-list li {
  display: grid;
  grid-template-columns: 42px 36px 1fr;
  gap: 8px;
  align-items: start;
  font-size: 12px;
  color: #444;
  padding: 4px 0;
  border-bottom: 1px solid #f0f0f0;
}

.evidence-list li.critical.bad {
  background: #f5f5f5;
}

.evidence-list li.ok .ev-state {
  color: #111;
  font-weight: 600;
}

.evidence-list li.bad .ev-state {
  color: #888;
}

.ev-weight {
  font-variant-numeric: tabular-nums;
  color: #888;
  font-size: 11px;
}

.ev-state {
  font-size: 11px;
}

.ev-summary {
  color: #777;
  font-weight: 400;
}

.action-board {
  border: 2px solid #222;
  background: #fff;
  display: grid;
  gap: 0;
}

.action-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: #111;
  color: #fff;
}

.action-badge {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.action-summary {
  font-size: 12px;
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}

.action-empty {
  padding: 20px 16px;
  text-align: center;
}

.action-block {
  border: none;
  border-top: 1px solid #e8e8e8;
}

.action-block .block-label {
  background: #f5f5f3;
}

.stake-cell {
  font-weight: 700;
  color: #0b6e4f;
}

.held-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px 12px;
  display: grid;
  gap: 8px;
}

.held-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  color: #333;
}

.held-tag {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  background: #e8e8e8;
  color: #444;
}

.held-tag.tot {
  background: #e4ebe6;
  color: #2a5a3c;
}

.held-eta {
  margin-left: auto;
  font-size: 12px;
  color: #777;
  font-variant-numeric: tabular-nums;
}

.funnel-strip.compact {
  font-size: 11px;
  padding: 6px 10px;
  gap: 8px 12px;
  color: #777;
  background: transparent;
  border-color: #eee;
}

.shadow-overlay-note.quiet {
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 400;
  color: #888;
  background: transparent;
  border-left: 2px solid #ddd;
}

.diag-fold {
  border: 1px solid #e5e5e5;
  padding: 8px 12px 12px;
  background: #fafafa;
}

.diag-fold > summary {
  cursor: pointer;
  font-size: 12px;
  color: #666;
  font-weight: 600;
  margin-bottom: 8px;
}

.diag-fold .picks-block {
  margin-top: 10px;
}

.diag-fold .research-sat {
  opacity: 0.92;
}

.action-board .parlay-card {
  padding: 10px 12px;
  border-top: 1px solid #eee;
}

.action-board .star-ticket {
  background: #fafaf8;
  margin: 0;
  border: none;
  border-radius: 0;
}

.action-board .satellite-ticket {
  margin: 0;
  background: #f5f7fa;
  border: none;
  border-radius: 0;
}

</style>
