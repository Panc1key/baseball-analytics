<template>
  <div class="app">
    <header class="header">
      <div>
        <h1>棒球初盤分析</h1>
        <p class="subtitle">MLB / NPB / KBO · 動態建議投注 · 串關低水錨腿</p>
        <div v-if="hasApiKey && lastSyncAt" class="status-line">
          <span>{{ syncStatusText }}</span>
          <span v-if="oddsQuota != null" class="quota">API 剩餘 {{ oddsQuota }} 次</span>
        </div>
      </div>
      <div class="actions">
        <el-tag v-if="!hasApiKey" type="danger">未設定 API Key</el-tag>
        <el-button type="primary" :loading="refreshing" :disabled="!hasApiKey" @click="handleRefresh">
          同步並分析
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="!hasApiKey"
      type="warning"
      :closable="false"
      show-icon
      title="尚未設定賠率 API"
      description="1. 複製 backend/.env.example 為 backend/.env　2. 填入 ODDS_API_KEY　3. 重啟後端　4. 點擊「同步並分析」"
      class="setup-alert"
    />

    <StatsCards :items="statItems" />

    <el-tabs v-model="activeTab">
      <el-tab-pane label="均注精選" name="flat">
        <div v-if="bettingMeta?.flatBet" class="strategy-banner flat">
          <strong>{{ bettingMeta.flatBet.label }}</strong>
          <span>基準均注 {{ bettingMeta.flatBet.baseUnit }}{{ bettingMeta.flatBet.currency || '元' }}</span>
          <span>依 EV / 優勢動態建議額</span>
          <span>賠率 ≥ {{ bettingMeta.flatBet.minOdds }}</span>
          <span>勝率 ≥ {{ (bettingMeta.flatBet.minProb * 100).toFixed(0) }}%</span>
          <span>同一場可主推+次推（不同盤口）</span>
          <span class="desc">{{ bettingMeta.flatBet.description }}</span>
        </div>
        <div class="filter-bar">
          <el-radio-group v-model="leagueFilter" size="small" @change="loadFlat">
            <el-radio-button label="">全部聯盟</el-radio-button>
            <el-radio-button label="MLB">MLB</el-radio-button>
            <el-radio-button label="NPB">NPB</el-radio-button>
            <el-radio-button label="KBO">KBO</el-radio-button>
          </el-radio-group>
        </div>
        <RecommendationsTable
          :recommendations="flatRecs"
          :loading="loading"
          :empty-text="flatEmptyText"
          :currency="bettingMeta?.flatBet?.currency || '元'"
          sort-hint="依開賽時間 · 同場主推→次推 · 建議投注額依 EV 動態調整"
        />
      </el-tab-pane>

      <el-tab-pane label="串關錨腿" name="anchors">
        <div v-if="bettingMeta?.parlayAnchor" class="strategy-banner anchor">
          <strong>{{ bettingMeta.parlayAnchor.label }}</strong>
          <span>賠率 {{ bettingMeta.parlayAnchor.minOdds }}～{{ bettingMeta.parlayAnchor.maxOdds }}</span>
          <span>勝率 ≥ {{ (bettingMeta.parlayAnchor.minProb * 100).toFixed(0) }}%</span>
          <span>建議額約基準均注 × {{ ((bettingMeta.parlayAnchor.stakeRatio || 0.35) * 100).toFixed(0) }}%</span>
          <span class="desc">{{ bettingMeta.parlayAnchor.description }}</span>
        </div>
        <div class="filter-bar">
          <el-radio-group v-model="leagueFilter" size="small" @change="loadAnchors">
            <el-radio-button label="">全部聯盟</el-radio-button>
            <el-radio-button label="MLB">MLB</el-radio-button>
            <el-radio-button label="NPB">NPB</el-radio-button>
            <el-radio-button label="KBO">KBO</el-radio-button>
          </el-radio-group>
        </div>
        <RecommendationsTable
          :recommendations="anchorRecs"
          :loading="loading"
          :empty-text="anchorEmptyText"
          :currency="bettingMeta?.parlayAnchor?.currency || '元'"
          sort-hint="依模型勝率排序 · 低水穩腿 · 建議額為縮倉比例"
          highlight-prob
        />
      </el-tab-pane>

      <el-tab-pane label="串關組合" name="parlays">
        <p class="hint parlay-hint">
          $1 六合彩型大串：盡量涵蓋當日全部場次（錨腿優先）· 不要求全中 · 均注請用「均注精選」
        </p>
        <ParlayList
          :parlays="parlays"
          :meta="parlayMeta"
          :loading="loading"
          :empty-text="parlayEmptyText"
        />
      </el-tab-pane>

      <el-tab-pane label="API 盤口" name="markets">
        <div v-if="marketsInfo" class="markets-panel">
          <el-card v-for="(info, code) in marketsInfo" :key="code" class="market-card" shadow="never">
            <template #header>
              <strong>{{ info.name }}</strong>
              <el-tag size="small" type="info" style="margin-left: 8px">{{ code }}</el-tag>
            </template>
            <p class="market-section-title">主盤（一次拉全聯盟）</p>
            <el-tag v-for="m in info.bulkMarkets" :key="m" size="small" class="market-tag">{{ m }}</el-tag>
            <template v-if="info.eventMarkets?.length">
              <p class="market-section-title">球員盤（逐場 event-odds）</p>
              <el-tag v-for="m in info.eventMarkets" :key="m" size="small" type="success" class="market-tag">{{ m }}</el-tag>
            </template>
            <p v-else class="market-note">{{ info.note }}</p>
          </el-card>
        </div>
        <el-empty v-else description="載入盤口說明中…" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import StatsCards from './components/StatsCards.vue';
import RecommendationsTable from './components/RecommendationsTable.vue';
import ParlayList from './components/ParlayList.vue';
import { refreshData, getRecommendations, getParlays, getStatus, getMarkets } from './api/index.js';

const activeTab = ref('flat');
const loading = ref(false);
const refreshing = ref(false);
const flatRecs = ref([]);
const anchorRecs = ref([]);
const parlays = ref([]);
const parlayMeta = ref(null);
const bettingMeta = ref(null);
const marketsInfo = ref(null);
const hasApiKey = ref(false);
const leagueFilter = ref('');
const lastSyncAt = ref(null);
const oddsQuota = ref(null);

const statItems = computed(() => [
  { label: '均注精選', value: flatRecs.value.length, class: 'positive' },
  { label: '串關錨腿', value: anchorRecs.value.length },
  { label: '串關組合', value: parlays.value.length },
  {
    label: '錨腿均勝率',
    value: anchorRecs.value.length
      ? `${(anchorRecs.value.reduce((a, r) => a + r.model_prob, 0) / anchorRecs.value.length * 100).toFixed(1)}%`
      : '—',
  },
]);

const syncStatusText = computed(() => {
  if (!lastSyncAt.value) return '';
  const diff = Date.now() - new Date(lastSyncAt.value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '上次同步：剛剛';
  if (mins < 60) return `上次同步：${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `上次同步：${hours} 小時前`;
  return `上次同步：${lastSyncAt.value.slice(0, 16).replace('T', ' ')}`;
});

const flatEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請點擊「同步並分析」';
  return '暫無符合均注條件的高賠推薦（賠率≥1.80、正EV）';
});

const anchorEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請點擊「同步並分析」';
  return '暫無串關錨腿（需低水 1.55～1.79 且勝率≥58%）';
});

const parlayEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請先點擊「同步並分析」';
  if (anchorRecs.value.length < 2) return `目前僅 ${anchorRecs.value.length} 條錨腿，需至少 2 條不同場次`;
  return '暫無錨腿串關組合';
});

function leagueParams() {
  return { league: leagueFilter.value || undefined };
}

function applyStatus(cfg) {
  hasApiKey.value = cfg?.hasApiKey;
  lastSyncAt.value = cfg?.lastSyncAt || null;
  oddsQuota.value = cfg?.oddsQuotaRemaining ?? null;
}

async function loadFlat() {
  const res = await getRecommendations({ gamePicks: true, ...leagueParams() });
  flatRecs.value = res.data || [];
  if (res.meta) bettingMeta.value = res.meta;
}

async function loadAnchors() {
  const res = await getRecommendations({ betStrategy: 'parlay_anchor', ...leagueParams() });
  anchorRecs.value = res.data || [];
  if (res.meta) bettingMeta.value = res.meta;
}

async function loadAll() {
  loading.value = true;
  try {
    const [flatRes, anchorRes, parRes, statusRes, marketsRes] = await Promise.all([
      getRecommendations({ gamePicks: true, ...leagueParams() }),
      getRecommendations({ betStrategy: 'parlay_anchor', ...leagueParams() }),
      getParlays(40),
      getStatus(),
      getMarkets(),
    ]);
    flatRecs.value = flatRes.data || [];
    anchorRecs.value = anchorRes.data || [];
    bettingMeta.value = flatRes.meta || anchorRes.meta || null;
    parlays.value = parRes.data || [];
    parlayMeta.value = parRes.meta || null;
    marketsInfo.value = marketsRes.data || null;
    applyStatus(statusRes.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message || '載入失敗';
    if (!err.response) {
      ElMessage.error('無法連接後端（請確認 backend 已啟動在 port 3101）');
    } else {
      ElMessage.error(msg);
    }
  } finally {
    loading.value = false;
  }
}

async function handleRefresh() {
  if (!hasApiKey.value) return;
  refreshing.value = true;
  try {
    await refreshData();
    ElMessage.success('同步與分析完成');
    await loadAll();
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '同步失敗');
  } finally {
    refreshing.value = false;
  }
}

onMounted(loadAll);
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f5f7fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.app { max-width: 1400px; margin: 0 auto; padding: 20px; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.header h1 { margin: 0 0 4px; font-size: 24px; }
.subtitle { margin: 0 0 8px; color: #909399; font-size: 14px; }
.status-line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; color: #606266; }
.quota { color: #909399; }
.actions { display: flex; gap: 12px; align-items: center; }
.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; }
.hint { font-size: 13px; color: #909399; margin: 0 0 12px; }
.parlay-hint { margin-bottom: 12px; }
.strategy-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}
.strategy-banner.flat { background: #ecf5ff; border: 1px solid #d9ecff; color: #303133; }
.strategy-banner.anchor { background: #f0f9eb; border: 1px solid #e1f3d8; color: #303133; }
.strategy-banner .desc { color: #909399; flex-basis: 100%; margin-top: 2px; }
.markets-panel { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.market-card :deep(.el-card__header) { padding: 12px 16px; }
.market-section-title { font-size: 13px; color: #606266; margin: 12px 0 8px; }
.market-section-title:first-of-type { margin-top: 0; }
.market-tag { margin: 0 8px 8px 0; }
.market-note { font-size: 13px; color: #909399; margin: 8px 0 0; }
.setup-alert { margin-bottom: 16px; }
</style>
