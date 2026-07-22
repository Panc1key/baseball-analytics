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
        <el-button type="primary" :loading="refreshing" @click="handleRefresh">
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

    <MlbPrematchTruthPanel ref="baseballPanelRef" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import MlbPrematchTruthPanel from './components/MlbPrematchTruthPanel.vue';
import {
  getStatus,
} from './api/index.js';
const baseballPanelRef = ref(null);
const refreshing = ref(false);

const headerSubtitle = computed(() => {
  return 'MLB 賽前事實資料與紙上研究 · 香港時間';
});

const refreshButtonLabel = computed(() => '重新載入本機快照');
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

async function loadBaseballViews() {
  try {
    const statusRes = await getStatus();
    applyStatus(statusRes.data);
    await baseballPanelRef.value?.loadTruth?.();
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
    await loadBaseballViews();
    ElMessage.success('已重新載入本機賽前快照');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '載入失敗');
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
