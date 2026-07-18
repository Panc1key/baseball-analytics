<template>
  <div class="app">
    <header class="header">
      <div class="brand">
        <h1>初盤分析</h1>
        <p class="subtitle">{{ headerSubtitle }}</p>
      </div>
      <div class="header-right">
        <div v-if="hasApiKey && (lastSyncAt || lastAnalysisAt)" class="status-line">
          <span v-if="lastAnalysisAt">更新 {{ relativeHk(lastAnalysisAt) }}</span>
          <span v-if="oddsQuota != null" class="quota">額度 {{ oddsQuota }}</span>
        </div>
        <el-tag v-if="!hasApiKey" type="danger" size="small">未設定 API Key</el-tag>
        <el-button type="primary" :loading="refreshing" :disabled="!hasApiKey" @click="handleRefresh">
          {{ refreshButtonLabel }}
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="!hasApiKey"
      type="warning"
      :closable="false"
      show-icon
      title="尚未設定賠率 API"
      description="複製 backend/.env.example 為 .env，填入 ODDS_API_KEY 後重啟後端"
      class="setup-alert"
    />

    <el-tabs v-model="activeTab" class="main-tabs" @tab-change="onTabChange">
      <el-tab-pane label="棒球" name="baseball">
        <DailySlatePanel ref="baseballPanelRef" sport="baseball" :auto-load="false" />
      </el-tab-pane>
      <el-tab-pane label="籃球" name="basketball">
        <BasketballPanel ref="basketballPanelRef" />
      </el-tab-pane>
      <el-tab-pane label="足球" name="football">
        <FootballPanel ref="footballPanelRef" />
      </el-tab-pane>
      <el-tab-pane label="網球" name="tennis">
        <TennisPanel ref="tennisPanelRef" />
      </el-tab-pane>
      <el-tab-pane label="全部" name="all">
        <p class="all-hint">跨運動初盤一覽 · 頂部「同步全部」會依序請求棒／籃／足／網</p>
        <DailySlatePanel ref="allPanelRef" sport="all" :auto-load="false" />
      </el-tab-pane>

      <el-tab-pane label="滾球" name="live">
        <LivePanel ref="livePanelRef" :auto-load="false" />
      </el-tab-pane>

      <el-tab-pane label="串關" name="parlays">
        <ParlayList
          :parlays="parlays"
          :meta="parlayMeta"
          :loading="loading"
          :empty-text="parlayEmptyText"
        />
      </el-tab-pane>

      <el-tab-pane label="清單" name="lists">
        <div class="lists-toolbar">
          <el-radio-group v-model="listMode" size="small" @change="loadListMode">
            <el-radio-button label="flat">均注精選</el-radio-button>
            <el-radio-button label="anchor">串關錨腿</el-radio-button>
          </el-radio-group>
          <el-radio-group v-model="leagueFilter" size="small" @change="loadListMode">
            <el-radio-button label="">全部</el-radio-button>
            <el-radio-button label="MLB">MLB</el-radio-button>
            <el-radio-button label="NPB">NPB</el-radio-button>
            <el-radio-button label="KBO">KBO</el-radio-button>
          </el-radio-group>
        </div>
        <p class="list-hint">
          {{
            listMode === 'flat'
              ? '滿額均注：勝率與賠率門檻較嚴，筆數會少'
              : '低水錨腿：適合串關，不建議單獨滿額'
          }}
        </p>
        <RecommendationsTable
          :recommendations="listMode === 'flat' ? flatRecs : anchorRecs"
          :loading="loading"
          :empty-text="listMode === 'flat' ? flatEmptyText : anchorEmptyText"
          :highlight-prob="listMode === 'anchor'"
        />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import RecommendationsTable from './components/RecommendationsTable.vue';
import ParlayList from './components/ParlayList.vue';
import FootballPanel from './components/FootballPanel.vue';
import BasketballPanel from './components/BasketballPanel.vue';
import TennisPanel from './components/TennisPanel.vue';
import DailySlatePanel from './components/DailySlatePanel.vue';
import LivePanel from './components/LivePanel.vue';
import {
  refreshSlate,
  refreshLive,
  getRecommendations,
  getParlays,
  getStatus,
} from './api/index.js';
import { refreshBasketball } from './api/basketball.js';
import { refreshFootball } from './api/football.js';
import { refreshTennis } from './api/tennis.js';

const ALL_SPORTS = ['baseball', 'basketball', 'football', 'tennis'];

const activeTab = ref('baseball');
const baseballPanelRef = ref(null);
const allPanelRef = ref(null);
const basketballPanelRef = ref(null);
const footballPanelRef = ref(null);
const tennisPanelRef = ref(null);
const livePanelRef = ref(null);
const loading = ref(false);
const refreshing = ref(false);

const headerSubtitle = computed(() => {
  const map = {
    baseball: '棒球 MLB / NPB / KBO · 香港時間',
    basketball: '籃球 NBA / WNBA · 僅同步本頁',
    football: '足球 · 僅同步本頁',
    tennis: '網球 ATP / WTA · 僅同步本頁',
    all: '全部運動 · 同步會請求棒／籃／足／網',
    live: '滾球分析 · 依附棒球比分',
    parlays: '棒球串關 · 香港時間',
    lists: '棒球清單 · 香港時間',
  };
  return map[activeTab.value] || '香港時間';
});

const refreshButtonLabel = computed(() => {
  const map = {
    baseball: '同步棒球',
    basketball: '同步籃球',
    football: '同步足球',
    tennis: '同步網球',
    all: '同步全部',
    live: '同步滾球',
    parlays: '同步棒球',
    lists: '同步棒球',
  };
  return map[activeTab.value] || '同步並分析';
});

const flatRecs = ref([]);
const anchorRecs = ref([]);
const parlays = ref([]);
const parlayMeta = ref(null);
const hasApiKey = ref(false);
const leagueFilter = ref('');
const listMode = ref('flat');
const lastSyncAt = ref(null);
const lastAnalysisAt = ref(null);
const oddsQuota = ref(null);
const listsLoaded = ref(false);

function formatHkTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function relativeHk(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return formatHkTime(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  return formatHkTime(iso);
}

const flatEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請點擊「同步棒球」';
  return '暫無均注精選';
});

const anchorEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請點擊「同步棒球」';
  return '暫無串關錨腿';
});

const parlayEmptyText = computed(() => {
  if (!hasApiKey.value) return '請先設定 API Key';
  if (!lastSyncAt.value) return '請先同步棒球';
  return '暫無串關組合';
});

function leagueParams() {
  return { league: leagueFilter.value || undefined };
}

function applyStatus(cfg) {
  hasApiKey.value = cfg?.hasApiKey;
  lastSyncAt.value = cfg?.lastSyncAt || null;
  lastAnalysisAt.value = cfg?.lastAnalysisAt || cfg?.lastSyncAt || null;
  oddsQuota.value = cfg?.oddsQuotaRemaining ?? null;
}

async function loadListMode() {
  loading.value = true;
  try {
    if (listMode.value === 'flat') {
      const res = await getRecommendations({ betStrategy: 'flat_bet', ...leagueParams() });
      flatRecs.value = res.data || [];
    } else {
      const res = await getRecommendations({ betStrategy: 'parlay_anchor', ...leagueParams() });
      anchorRecs.value = res.data || [];
    }
    listsLoaded.value = true;
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '載入失敗');
  } finally {
    loading.value = false;
  }
}

function onTabChange(name) {
  if (name === 'lists' && !listsLoaded.value) loadListMode();
  if (name === 'live') livePanelRef.value?.loadLive?.();
  if (name === 'baseball') baseballPanelRef.value?.loadSlate?.();
  if (name === 'all') allPanelRef.value?.loadSlate?.();
}

async function loadBaseballViews() {
  loading.value = true;
  try {
    const [parRes, statusRes] = await Promise.all([getParlays(40), getStatus()]);
    parlays.value = parRes.data || [];
    parlayMeta.value = parRes.meta || null;
    applyStatus(statusRes.data);
    await baseballPanelRef.value?.loadSlate?.();
    if (activeTab.value === 'all') await allPanelRef.value?.loadSlate?.();
    const slateUpdated = baseballPanelRef.value?.slate?.updatedAt;
    if (slateUpdated) lastAnalysisAt.value = slateUpdated;
  } catch (err) {
    if (!err.response) {
      ElMessage.error('無法連接後端（請確認 backend 已啟動在 port 3101）');
    } else {
      ElMessage.error(err.response?.data?.error || err.message || '載入失敗');
    }
  } finally {
    loading.value = false;
  }
}

async function handleRefresh() {
  if (!hasApiKey.value) return;
  refreshing.value = true;
  const tab = activeTab.value;
  try {
    if (tab === 'live') {
      const res = await refreshLive();
      if (res?.success === false) {
        ElMessage.warning(res.error || '滾球同步失敗');
      } else {
        ElMessage.success('滾球分析完成');
      }
      await livePanelRef.value?.loadLive?.();
      return;
    }

    if (tab === 'basketball') {
      await refreshBasketball();
      ElMessage.success('籃球同步與分析完成');
      await basketballPanelRef.value?.loadAll?.();
      return;
    }

    if (tab === 'football') {
      await refreshFootball();
      ElMessage.success('足球同步與分析完成');
      await footballPanelRef.value?.loadAll?.();
      return;
    }

    if (tab === 'tennis') {
      await refreshTennis();
      ElMessage.success('網球同步與分析完成');
      await tennisPanelRef.value?.loadAll?.();
      return;
    }

    const sports = tab === 'all' ? ALL_SPORTS : ['baseball'];
    const res = await refreshSlate({ sports });
    if (res.partial && res.error) {
      ElMessage.warning(`同步失敗：${res.error}`);
    } else {
      ElMessage.success(tab === 'all' ? '全部運動同步與分析完成' : '棒球同步與分析完成');
    }

    listsLoaded.value = false;
    await loadBaseballViews();
    if (tab === 'all') {
      await Promise.all([
        basketballPanelRef.value?.loadAll?.(),
        footballPanelRef.value?.loadAll?.(),
        tennisPanelRef.value?.loadAll?.(),
        allPanelRef.value?.loadSlate?.(),
      ]);
    }
    if (tab === 'lists') await loadListMode();
    if (tab === 'parlays') {
      const p = await getParlays();
      if (p.success) {
        parlays.value = p.data || [];
        parlayMeta.value = p.meta || null;
      }
    }
  } catch (err) {
    const msg =
      err.code === 'ECONNABORTED'
        ? '同步逾時（請改在對應運動頁單獨同步）'
        : err.response?.data?.error || err.message || '同步失敗';
    ElMessage.error(msg);
  } finally {
    refreshing.value = false;
  }
}

onMounted(loadBaseballViews);
</script>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f0f2f5;
  font-family: "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
  color: #1f2329;
}
.app { max-width: 1100px; margin: 0 auto; padding: 16px 16px 40px; }
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e5e6eb;
}
.brand h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.subtitle { margin: 4px 0 0; color: #86909c; font-size: 13px; }
.header-right { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.status-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #4e5969;
}
.quota { color: #86909c; }
.setup-alert { margin-bottom: 12px; }
.all-hint { margin: 0 0 10px; font-size: 12px; color: #86909c; }
.main-tabs :deep(.el-tabs__header) { margin-bottom: 12px; }
.main-tabs :deep(.el-tabs__item) { font-size: 14px; padding: 0 14px; }
.lists-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
}
.list-hint { margin: 0 0 10px; font-size: 12px; color: #86909c; }
@media (max-width: 640px) {
  .header { flex-direction: column; align-items: flex-start; }
  .app { padding: 12px; }
}
</style>
