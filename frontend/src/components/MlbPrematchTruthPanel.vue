<template>
  <section class="truth-panel" v-loading="loading">
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="MLB 賽前研究模式"
      :description="truth?.disclaimer || '本頁只做賽前事實、獨立概率與市場錯價排序；不提供投注建議、均注或建議金額。'"
    />

    <MlbSourceHealthPanel />
    <MlbModelValidationPanel />
    <MlbExpectedRunsValidationPanel />

    <header class="toolbar">
      <div>
        <strong>賽前事實 → 概率 → 錯價排序</strong>
        <span v-if="truth" class="version">{{ truth.modelVersion }} · {{ truth.strategyVersion }}</span>
      </div>
      <el-button size="small" :loading="loading" @click="loadTruth">重新載入</el-button>
    </header>

    <div v-if="walkforward" class="ledger">
      <strong>紙上 Walk-forward（近 {{ walkforward.window?.days || '—' }} 日）</strong>
      <span>可用日 {{ walkforward.coverage?.daysUsed || 0 }}</span>
      <span>Top1 命中 {{ percent(walkforward.summary?.top1?.hitRate) }}（n={{ walkforward.summary?.top1?.n || 0 }}）</span>
      <span>Top1 ROI {{ percent(walkforward.summary?.top1?.roi) }}</span>
      <span>Top3 命中 {{ percent(walkforward.summary?.top3?.hitRate) }}（n={{ walkforward.summary?.top3?.n || 0 }}）</span>
      <span>市場熱門 Top1 {{ percent(walkforward.summary?.marketFavoriteTop1?.hitRate) }}</span>
      <small>{{ walkforward.warning }}</small>
    </div>

    <div v-if="dailyTop.length" class="daily-top">
      <strong>今日／近期研究方向 Top</strong>
      <article v-for="item in dailyTop" :key="`${item.researchDay}-${item.gameId}`" class="top-row">
        <el-tag size="small" :type="item.dailyRank === 1 ? 'warning' : 'info'">
          {{ item.researchDay }} · #{{ item.dailyRank }}
        </el-tag>
        <span class="matchup">{{ item.matchup }}</span>
        <span>{{ item.pick || '—' }}</span>
        <span>edge {{ percent(item.edge) }}</span>
        <span>模型 {{ percent(item.modelProb) }} / 市場 {{ percent(item.marketProb) }}</span>
        <span>@{{ formatOdds(item.oddsDecimal) }}</span>
      </article>
    </div>

    <el-empty v-if="!loading && !games.length" description="尚無 MLB 賽前資料快照；請先同步棒球。" />

    <article v-for="game in rankedGames" :key="game.truthSnapshotId" class="game-card">
      <header class="game-head">
        <div>
          <div class="matchup">
            <span v-if="game.dailyRank" class="rank-badge">#{{ game.dailyRank }}</span>
            {{ game.awayTeam }} @ {{ game.homeTeam }}
          </div>
          <div class="time">{{ formatTime(game.commenceTime) }} · 快照 {{ formatTime(game.capturedAt) }}</div>
        </div>
        <div class="status">
          <span class="completeness">資料完整度 {{ Math.round(game.completeness * 100) }}%</span>
          <el-tag :type="tierType(game.researchTier)" size="small">{{ tierLabel(game.researchTier) }}</el-tag>
        </div>
      </header>

      <p class="gate-reason">{{ gateReasonText(game.research?.rejectionReasons || game.gateReasons) }}</p>

      <div class="evidence-grid">
        <div v-for="item in game.evidence" :key="item.key" class="evidence-item" :class="`state-${item.status}`">
          <span class="symbol">{{ stateSymbol(item.status) }}</span>
          <div class="evidence-copy">
            <strong>{{ labelFor(item.key) }}</strong>
            <span>{{ item.summary }}</span>
            <small v-if="item.reason">{{ reasonFor(item.reason) }}</small>
            <small v-if="item.source">來源：{{ item.source }} · {{ formatTime(item.capturedAt) }}</small>
          </div>
        </div>
      </div>

      <div class="model-output">
        <span class="output-label">研究方向（不是推薦）</span>
        <template v-if="game.research?.pick || game.modelOutput?.pick">
          <span>{{ game.research?.pick || game.modelOutput?.pick }}</span>
          <span>@{{ formatOdds(game.research?.oddsDecimal ?? game.modelOutput?.oddsDecimal) }}</span>
          <span>模型 {{ percent(game.research?.modelProb ?? game.modelOutput?.modelProb) }}</span>
          <span>市場 {{ percent(game.research?.marketProb ?? game.modelOutput?.marketProb) }}</span>
          <span>edge {{ percent(game.research?.edge ?? game.modelOutput?.edge) }}</span>
          <span>研究 EV {{ percent(game.research?.ev ?? game.modelOutput?.ev) }}</span>
        </template>
        <span v-else>缺少完整雙邊盤或模型輸出，未產生錯價排序</span>
      </div>
      <div v-if="game.expectedRuns?.prediction" class="model-output">
        <span class="output-label">預期得分（研究）</span>
        <span>客 {{ score(game.expectedRuns.prediction.awayExpectedRuns) }}</span>
        <span>主 {{ score(game.expectedRuns.prediction.homeExpectedRuns) }}</span>
        <span>總分 {{ score(game.expectedRuns.prediction.expectedTotal) }}</span>
        <span>主勝 {{ percent(game.expectedRuns.prediction.markets?.homeWinProbability) }}</span>
      </div>
    </article>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import {
  getMlbPrematchTruth,
} from '../api/index.js';
import MlbModelValidationPanel from './MlbModelValidationPanel.vue';
import MlbExpectedRunsValidationPanel from './MlbExpectedRunsValidationPanel.vue';
import MlbSourceHealthPanel from './MlbSourceHealthPanel.vue';

const loading = ref(false);
const truth = ref(null);
const walkforward = ref(null);

const games = computed(() => truth.value?.games || []);
const dailyTop = computed(() => truth.value?.dailyTop || []);
const rankedGames = computed(() =>
  [...games.value].sort((a, b) => {
    const day = String(a.researchDay || '').localeCompare(String(b.researchDay || ''));
    if (day !== 0) return day;
    return (a.dailyRank || 999) - (b.dailyRank || 999);
  })
);

const labels = {
  fixture: '比賽資訊',
  odds: '賽前盤口',
  venue: '場地',
  starting_pitchers: '先發投手',
  official_history: '官方歷史特徵',
  model_history: '模型同口徑歷史特徵',
  bullpen: '牛棚',
  lineup: '先發打線',
  injuries: '傷停／可出賽',
  park: '球場環境',
  weather: '天氣',
  travel_rest: '旅行／休息',
};

const reasons = {
  bullpen_availability_not_confirmed: '已取得近期負荷，但尚未確認當日可用後援名單。',
  bullpen_usage_data_missing: '無法取得近期牛棚使用量，未納入模型。',
  confirmed_lineup_missing: '官方確認打線尚未公布，未納入模型。',
  injury_list_missing: '無法取得完整傷兵名單，未納入模型。',
  park_factor_dataset_not_implemented: '球場係數資料集尚未建立，未納入模型。',
  weather_forecast_missing: '無法取得比賽時段天氣預報，未納入模型。',
  previous_game_end_time_not_available: '已取得賽程與旅行距離，但前一戰實際結束時間尚未驗證。',
  team_schedule_history_missing: '無法取得完整隊伍賽程歷史，未納入模型。',
  official_probable_pitchers_are_not_confirmed_lineup_cards: '官方僅標示預定先發，尚非確認名單。',
  both_probable_pitchers_required: '雙方預定先發尚未完整公布。',
  official_historical_features_missing: '無法取得截至比賽日前的官方球隊歷史特徵。',
  paired_h2h_market_missing: '沒有可去水的同 bookmaker 雙邊盤。',
  baseline_model_or_features_missing: '基準模型或特徵不足，暫無獨立概率。',
  baseline_market_gap_below_threshold: '模型相對市場的錯價低於研究門檻。',
  strategy_not_validated_for_real_or_paper_selection: '策略未經樣本外驗證，禁止正式選邊。',
};

function labelFor(key) {
  return labels[key] || key;
}

function reasonFor(reason) {
  return reasons[reason] || reason;
}

function stateSymbol(state) {
  if (state === 'verified') return '✓';
  if (state === 'partial') return '△';
  return '×';
}

function tierType(tier) {
  if (tier === 'top1_observation') return 'warning';
  if (tier === 'top3_observation') return 'success';
  if (tier === 'watchlist') return 'info';
  return 'info';
}

function tierLabel(tier) {
  if (tier === 'top1_observation') return '研究方向 Top1';
  if (tier === 'top3_observation') return '研究方向 Top3';
  if (tier === 'watchlist') return '觀察名單';
  return '未排序';
}

function gateReasonText(reasonsList = []) {
  if (!reasonsList.length) return '資料閘門通過；排序僅供研究觀察。';
  return reasonsList.map(reasonFor).join(' ');
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
}

function formatOdds(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
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
.truth-panel { display: grid; gap: 12px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.version { margin-left: 8px; color: #86909c; font-size: 12px; }
.ledger, .daily-top {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
  color: #4e5969;
  font-size: 12px;
}
.ledger { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ledger strong, .daily-top strong { color: #1f2329; }
.ledger small { width: 100%; color: #86909c; }
.top-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.rank-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  background: #fff7e6;
  color: #d48806;
  font-size: 12px;
}
.game-card { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 14px; }
.game-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.matchup { font-size: 16px; font-weight: 700; }
.time, .gate-reason { color: #86909c; font-size: 12px; }
.status { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.completeness { font-size: 12px; color: #4e5969; }
.gate-reason { margin: 10px 0; line-height: 1.5; }
.evidence-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 8px; }
.evidence-item { display: flex; gap: 8px; border: 1px solid #f0f0f0; border-radius: 6px; padding: 8px; min-width: 0; }
.symbol { width: 16px; font-weight: 700; font-size: 16px; }
.state-verified .symbol { color: #52c41a; }
.state-partial .symbol { color: #d48806; }
.state-missing .symbol, .state-stale .symbol, .state-conflicting .symbol { color: #cf1322; }
.evidence-copy { display: grid; gap: 2px; min-width: 0; }
.evidence-copy strong { font-size: 13px; }
.evidence-copy span, .evidence-copy small { color: #4e5969; font-size: 12px; line-height: 1.4; }
.evidence-copy small { color: #86909c; }
.model-output { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f0f0f0; font-size: 12px; color: #4e5969; }
.output-label { color: #86909c; }
@media (max-width: 640px) {
  .game-head { flex-direction: column; }
  .status { align-self: flex-start; }
}
</style>
