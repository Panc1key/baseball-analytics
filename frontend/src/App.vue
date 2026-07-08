<template>
  <div class="app">
    <header class="header">
      <div>
        <h1>棒球初盤分析</h1>
        <p class="subtitle">MLB / NPB / KBO · 評分制推薦 · 請至外部平台下注</p>
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
      <el-tab-pane label="單場推薦" name="singles">
        <div class="filter-bar">
          <el-radio-group v-model="tierFilter" size="small" @change="loadRecommendations">
            <el-radio-button label="">全部等級</el-radio-button>
            <el-radio-button label="primary">主推</el-radio-button>
            <el-radio-button label="watch">觀察</el-radio-button>
          </el-radio-group>
          <el-radio-group v-model="leagueFilter" size="small" @change="loadRecommendations">
            <el-radio-button label="">全部聯盟</el-radio-button>
            <el-radio-button label="MLB">MLB</el-radio-button>
            <el-radio-button label="NPB">NPB</el-radio-button>
            <el-radio-button label="KBO">KBO</el-radio-button>
          </el-radio-group>
          <el-radio-group v-model="marketFilter" size="small" @change="loadRecommendations">
            <el-radio-button label="">全部盤口</el-radio-button>
            <el-radio-button label="h2h">獨贏</el-radio-button>
            <el-radio-button label="spreads">讓分</el-radio-button>
            <el-radio-button label="totals">大小</el-radio-button>
            <el-radio-button label="props">球員</el-radio-button>
          </el-radio-group>
        </div>
        <p class="hint">
          主推 ≥65 分 · 觀察 50–64 分 · 依勝率與概率優勢評分 · 禁止陰陽盤 · MLB 含球員盤口
        </p>
        <RecommendationsTable
          :recommendations="recommendations"
          :loading="loading"
          :empty-text="recEmptyText"
        />
      </el-tab-pane>

      <el-tab-pane label="串關推薦" name="parlays">
        <p class="hint parlay-hint">
          均注正 EV · 每注 $1 · 每腿須正優勢 · 長期盈利導向（長串為彩券型，不要求全中）
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
import { isPropMarket } from './utils/market.js';

const activeTab = ref('singles');
const loading = ref(false);
const refreshing = ref(false);
const recommendations = ref([]);
const parlays = ref([]);
const parlayMeta = ref(null);
const marketsInfo = ref(null);
const hasApiKey = ref(false);
const minEv = ref(0.03);
const leagueFilter = ref('');
const marketFilter = ref('');
const tierFilter = ref('');
const lastSyncAt = ref(null);
const oddsQuota = ref(null);

const statItems = computed(() => [
  { label: '推薦總數', value: recommendations.value.length },
  { label: '主推', value: recommendations.value.filter((r) => r.tier === 'primary').length, class: 'positive' },
  { label: '觀察', value: recommendations.value.filter((r) => r.tier === 'watch').length },
  { label: '獨贏', value: recommendations.value.filter((r) => r.market === 'h2h').length },
  { label: '讓分', value: recommendations.value.filter((r) => r.market === 'spreads').length },
  { label: '大小/球員', value: recommendations.value.filter((r) => r.market === 'totals' || isPropMarket(r.market)).length },
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

const recEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key（見上方說明）';
  if (!lastSyncAt.value) return '尚無推薦，請點擊右上角「同步並分析」';
  return '本次同步無達觀察門檻(50分)的推薦，可稍後再同步';
});

const parlayEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請先點擊「同步並分析」';
  const primary = recommendations.value.filter((r) => r.tier === 'primary').length;
  if (primary < 2) return `目前僅 ${primary} 條主推，需至少 2 條不同場次才可組串關`;
  return '暫無合適串關組合，請稍後再同步';
});

function buildQueryParams() {
  const params = {
    league: leagueFilter.value || undefined,
    minEv: minEv.value,
    tier: tierFilter.value || undefined,
  };
  if (marketFilter.value === 'props') {
    params.marketGroup = 'props';
  } else if (marketFilter.value) {
    params.market = marketFilter.value;
  }
  return params;
}

function applyStatus(cfg) {
  hasApiKey.value = cfg?.hasApiKey;
  minEv.value = cfg?.minEvThreshold || 0.03;
  lastSyncAt.value = cfg?.lastSyncAt || null;
  oddsQuota.value = cfg?.oddsQuotaRemaining ?? null;
}

async function loadAll() {
  loading.value = true;
  try {
    const [recRes, parRes, statusRes, marketsRes] = await Promise.all([
      getRecommendations(buildQueryParams()),
      getParlays(40),
      getStatus(),
      getMarkets(),
    ]);
    recommendations.value = recRes.data || [];
    parlays.value = parRes.data || [];
    parlayMeta.value = parRes.meta || null;
    marketsInfo.value = marketsRes.data || null;
    applyStatus(statusRes.data);
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '載入失敗');
  } finally {
    loading.value = false;
  }
}

async function loadRecommendations() {
  loading.value = true;
  try {
    const res = await getRecommendations(buildQueryParams());
    recommendations.value = res.data || [];
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
.markets-panel { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.market-card :deep(.el-card__header) { padding: 12px 16px; }
.market-section-title { font-size: 13px; color: #606266; margin: 12px 0 8px; }
.market-section-title:first-of-type { margin-top: 0; }
.market-tag { margin: 0 8px 8px 0; }
.market-note { font-size: 13px; color: #909399; margin: 8px 0 0; }
.setup-alert { margin-bottom: 16px; }
</style>
