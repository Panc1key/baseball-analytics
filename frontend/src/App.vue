<template>
  <div class="app">
    <header class="header">
      <div class="brand">
        <h1>初盤分析</h1>
        <p class="subtitle">{{ subtitle }}</p>
      </div>
      <div class="header-right">
        <div v-if="hasApiKey && (lastSyncAt || lastAnalysisAt)" class="status-line">
          <span v-if="lastAnalysisAt">更新 {{ relativeHk(lastAnalysisAt) }}</span>
          <span v-if="oddsQuota != null" class="quota">額度 {{ oddsQuota }}</span>
        </div>
        <el-tag v-if="!hasApiKey" type="danger" size="small">未設定 API Key</el-tag>
        <el-button type="primary" plain :loading="refreshing" @click="handleRefresh">
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

    <el-radio-group v-model="mainTab" size="small" class="main-tabs">
      <el-radio-button label="mlb">MLB 鎖定 B</el-radio-button>
      <el-radio-button label="asian">日職／韓職</el-radio-button>
    </el-radio-group>

    <MlbPrematchTruthPanel v-show="mainTab === 'mlb'" ref="mlbPanelRef" />
    <AsianLeaguePrematchPanel v-show="mainTab === 'asian'" ref="asianPanelRef" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import MlbPrematchTruthPanel from './components/MlbPrematchTruthPanel.vue';
import AsianLeaguePrematchPanel from './components/AsianLeaguePrematchPanel.vue';
import {
  getStatus,
  refreshSlate,
} from './api/index.js';

const mainTab = ref('mlb');
const mlbPanelRef = ref(null);
const asianPanelRef = ref(null);
const refreshing = ref(false);

const subtitle = computed(() =>
  mainTab.value === 'asian'
    ? '日職／韓職初盤 · 與 MLB 分開 · 香港時間'
    : 'MLB 鎖定 B · 香港時間'
);

const refreshButtonLabel = computed(() => {
  if (refreshing.value) return '同步中…';
  return mainTab.value === 'asian' ? '同步日職／韓職' : '同步今日 MLB';
});

const hasApiKey = ref(false);
const lastSyncAt = ref(null);
const lastAnalysisAt = ref(null);
const oddsQuota = ref(null);

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

function applyStatus(cfg) {
  hasApiKey.value = cfg?.hasApiKey;
  lastSyncAt.value = cfg?.lastSyncAt || null;
  lastAnalysisAt.value = cfg?.lastAnalysisAt || cfg?.lastSyncAt || null;
  oddsQuota.value = cfg?.oddsQuotaRemaining ?? null;
}

async function loadViews() {
  try {
    const statusRes = await getStatus();
    applyStatus(statusRes.data);
    if (mainTab.value === 'mlb') {
      await mlbPanelRef.value?.loadTruth?.();
    } else {
      await asianPanelRef.value?.reload?.();
    }
  } catch (err) {
    if (!err.response) {
      ElMessage.error('無法連接後端（請確認 backend 已啟動在 port 3101）');
    } else {
      ElMessage.error(err.response?.data?.error || err.message || '載入失敗');
    }
  }
}

async function handleRefresh() {
  refreshing.value = true;
  try {
    await refreshSlate({ sports: ['baseball'] });
    await loadViews();
    ElMessage.success(
      mainTab.value === 'asian' ? '已同步棒球（含日職／韓職）' : '已同步今日 MLB'
    );
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '同步失敗');
  } finally {
    refreshing.value = false;
  }
}

watch(mainTab, () => {
  loadViews();
});

onMounted(loadViews);
</script>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f5f5f5;
  font-family: "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
  color: #111;
}
.app { max-width: 960px; margin: 0 auto; padding: 16px 16px 40px; }
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ddd;
}
.brand h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.subtitle { margin: 4px 0 0; color: #666; font-size: 13px; }
.header-right { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.status-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #555;
}
.quota { color: #888; }
.setup-alert { margin-bottom: 12px; }
.main-tabs { margin-bottom: 14px; }
@media (max-width: 640px) {
  .header { flex-direction: column; align-items: flex-start; }
  .app { padding: 12px; }
}
</style>
