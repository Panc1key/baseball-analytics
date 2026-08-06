<template>
  <section class="truth-panel" v-loading="loading">
    <header class="toolbar">
      <div>
        <h2 class="panel-title">今日 NPB · 下注板</h2>
        <p class="panel-sub">
          單場 ${{ stake }} · 獨贏日 TopK {{ dailyTopK }} · 大小 Over（砍中賠）· 開賽前 {{ releaseHours }}h 放出
        </p>
      </div>
      <el-button size="small" plain :loading="loading" @click="load">重新載入</el-button>
    </header>

    <p class="schedule-note">港時查看：白天 <strong>09:00–17:00</strong> · 只下「現在可下」（開賽前 {{ releaseHours }}h）</p>

    <div class="action-board">
      <div class="action-head">
        <span class="action-badge">現在可下</span>
        <span class="action-summary">
          獨贏 {{ dailyTop.length }} · 大小 {{ totalsDailyTop.length }} · 未放出 {{ heldTotal }}
        </span>
      </div>

      <div v-if="!loading && !hasActionableBets" class="action-empty">
        <p class="empty-title">此刻沒有可下主倉</p>
        <p class="empty-body">
          <template v-if="heldTotal">
            已有 {{ heldTotal }} 場過閘，約 {{ soonestHeldHours }} 後放出選邊（見「稍後放出」）。
          </template>
          <template v-else-if="startedToday.length">
            今日 {{ startedToday.length }} 場已開賽（初盤窗口已過）。明早同步後再看可下。
          </template>
          <template v-else>
            今日多數未過閘（獨贏 mid／大小 Over+中賠砍帶）。不是壞掉。
          </template>
        </p>
      </div>

      <div v-if="dailyTop.length" class="picks-block action-block">
        <div class="block-label">獨贏主倉 · 各 ${{ stake }}</div>
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
              <td class="num stake-cell">${{ stake }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalsDailyTop.length" class="picks-block action-block">
        <div class="block-label">大小主倉 · Over · 各 ${{ stake }}</div>
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
            <tr
              v-for="item in totalsDailyTop"
              :key="`tot-${item.gameId}`"
              :class="{ 'is-top': item.rank === 1 }"
            >
              <td class="col-rank">{{ item.rank }}</td>
              <td class="matchup">{{ item.matchup }}</td>
              <td class="pick">{{ item.pick || '—' }}</td>
              <td class="num">{{ formatOdds(item.oddsDecimal ?? item.odds) }}</td>
              <td class="num">{{ percent(item.expectedValue) }}</td>
              <td class="num stake-cell">${{ stake }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="totalsPackage?.thinYearWarning" class="thin-year-note">
          大小證據幾乎僅 2026（thin-year），已正式接入；若連續翻負可關 totals。
        </p>
      </div>
    </div>

    <div v-if="heldTotal" class="picks-block held-block">
      <div class="block-label">稍後放出（先別下）</div>
      <ul class="held-list">
        <li v-for="item in held" :key="`held-ml-${item.gameId}`">
          <span class="held-tag">獨贏</span>
          {{ item.matchup }}
          <span class="held-eta">約 {{ formatHoursUntil(item.hoursUntilCommence) }} 後顯示選邊</span>
        </li>
        <li v-for="item in totalsHeld" :key="`held-tot-${item.gameId}`">
          <span class="held-tag">大小</span>
          {{ item.matchup }}
          <span class="held-eta">約 {{ formatHoursUntil(item.hoursUntilCommence) }} 後顯示選邊</span>
        </li>
      </ul>
    </div>

    <div v-if="!loading && funnel" class="funnel-strip compact">
      <span>今日 {{ funnel.upcoming }}</span>
      <span>可看獨贏 {{ funnel.selected }}</span>
      <span>可看大小 {{ funnel.totalsSelected || totalsDailyTop.length }}</span>
      <span>未放出 {{ (funnel.passedGatesHeld || held.length) + (funnel.totalsHeld || totalsHeld.length) }}</span>
      <span>已開賽 {{ funnel.startedToday || startedToday.length }}</span>
      <span>未過閘 {{ funnel.excluded }}</span>
      <span v-if="topReason">主因 {{ topReason }}</span>
    </div>

    <p v-if="packageMeta?.note" class="shadow-overlay-note quiet">
      {{ packageMeta.note }}
    </p>

    <details class="diag-fold">
      <summary>診斷與對照線（一般下注可忽略）</summary>

      <div v-if="excluded.length" class="picks-block">
        <div class="block-label">未入選（{{ excluded.length }}）</div>
        <table class="picks-table">
          <thead>
            <tr><th>開賽</th><th>對陣</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in excluded" :key="`ex-${row.gameId}`">
              <td class="time-cell">{{ formatTime(row.commenceTime) }}</td>
              <td class="matchup">{{ row.matchup }}</td>
              <td class="missing">{{ (row.reasons || []).join('、') || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="startedToday.length" class="picks-block blocked">
        <div class="block-label">今日已開賽（{{ startedToday.length }}）</div>
        <table class="picks-table">
          <thead>
            <tr><th>開賽</th><th>對陣</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in startedToday" :key="`st-${row.gameId}`">
              <td class="time-cell">{{ formatTime(row.commenceTime) }}</td>
              <td class="matchup">{{ row.matchup }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { getNpbPrematch } from '../api/index.js';

const loading = ref(false);
const slate = ref(null);

const packageMeta = computed(() => slate.value?.package || null);
const totalsPackage = computed(() => packageMeta.value?.totalsPackage || null);
const stake = computed(() => Number(packageMeta.value?.flatStakeUsd) || 50);
const dailyTopK = computed(() => Number(packageMeta.value?.dailyTopK) || 3);
const releaseHours = computed(
  () => Number(slate.value?.releasePolicy?.hoursBefore ?? packageMeta.value?.releaseHoursBefore) || 8
);
const dailyTop = computed(() => slate.value?.dailyTop || []);
const totalsDailyTop = computed(() => slate.value?.totalsDailyTop || []);
const held = computed(() => slate.value?.heldUntilRelease || []);
const totalsHeld = computed(() => slate.value?.totalsHeldUntilRelease || []);
const heldTotal = computed(() => held.value.length + totalsHeld.value.length);
const excluded = computed(() => slate.value?.excluded || []);
const startedToday = computed(() => slate.value?.startedToday || []);
const funnel = computed(() => slate.value?.todayFunnel || null);
const hasActionableBets = computed(
  () => dailyTop.value.length > 0 || totalsDailyTop.value.length > 0
);
const soonestHeldHours = computed(() => {
  const hours = [...held.value, ...totalsHeld.value]
    .map((r) => Number(r.hoursUntilCommence))
    .filter((h) => Number.isFinite(h));
  if (!hours.length) return '—';
  return formatHoursUntil(Math.min(...hours));
});
const topReason = computed(() => {
  const t = funnel.value?.topReasons?.[0];
  if (!t) return '';
  return `${t.label || t.reason}×${t.n}`;
});

function percent(v) {
  return Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(1)}%` : '—';
}
function formatOdds(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—';
}
function formatHoursUntil(v) {
  const h = Number(v);
  if (!Number.isFinite(h)) return '—';
  if (h >= 10) return `${Math.round(h)}h`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.max(0, Math.round(h * 60))}m`;
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

async function load() {
  loading.value = true;
  try {
    const result = await getNpbPrematch({ from: new Date().toISOString() });
    slate.value = result.data || null;
  } finally {
    loading.value = false;
  }
}

defineExpose({
  load,
  loadTruth: load,
  reload: load,
});
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
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: #444;
  border-left: 3px solid #888;
  background: #f7f7f7;
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

.thin-year-note {
  margin: 0;
  padding: 6px 12px 10px;
  font-size: 11px;
  color: #888;
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

.stake-cell {
  font-weight: 700;
  color: #0b6e4f;
}

.matchup {
  font-weight: 500;
  color: #111;
}

.pick {
  font-weight: 600;
  color: #111;
}

.missing {
  color: #555;
  font-size: 12px;
}

.time-cell {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
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

.held-eta {
  margin-left: auto;
  font-size: 12px;
  color: #777;
  font-variant-numeric: tabular-nums;
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

.funnel-strip.compact {
  font-size: 11px;
  padding: 6px 10px;
  gap: 8px 12px;
  color: #777;
  background: transparent;
  border-color: #eee;
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
</style>
