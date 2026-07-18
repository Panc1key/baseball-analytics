<template>
  <div class="sport-panel">
    <div class="panel-header">
      <div>
        <h2>網球初盤分析</h2>
        <p class="subtitle">ATP / WTA 動態賽事 · 選手勝率 · 讓局 / 總局數 · 暫無滾球</p>
        <div v-if="status" class="status-line">
          <span>{{ syncStatusText }}</span>
          <span v-if="status.oddsQuotaRemaining != null" class="quota">
            Odds API 剩餘 {{ status.oddsQuotaRemaining }}
          </span>
          <el-tag v-if="!(status.activeSports || []).length" type="info" size="small">賽事空窗</el-tag>
        </div>
      </div>
      <el-button type="primary" :loading="refreshing" :disabled="!status?.hasOddsApiKey" @click="handleRefresh">
        同步網球
      </el-button>
    </div>

    <el-alert
      v-if="status && !(status.activeSports || []).length && status.lastSyncAt"
      type="info"
      :closable="false"
      show-icon
      title="目前無 active 網球賽事"
      description="The Odds API 僅覆蓋大滿貫與 ATP/WTA 500+。溫網結束到加拿大站之間常為空窗，管線已就緒，開打後再同步即可。"
      class="setup-alert"
    />

    <div v-if="status" class="stats-row">
      <el-statistic title="進行中賽事" :value="(status.activeSports || []).length" />
      <el-statistic title="待賽場次" :value="status.upcomingGames" />
      <el-statistic title="推薦數" :value="status.recommendationCount" />
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="均注精選" name="flat">
        <RecommendationsTable
          :recommendations="flatRecs"
          :loading="loading"
          :empty-text="emptyText"
          sort-hint="網球 EV 排序"
        />
      </el-tab-pane>
      <el-tab-pane label="串關錨腿" name="anchor">
        <RecommendationsTable
          :recommendations="anchorRecs"
          :loading="loading"
          empty-text="暫無錨腿"
          sort-hint="低水高勝率"
          highlight-prob
        />
      </el-tab-pane>
      <el-tab-pane label="盤口說明" name="markets">
        <div v-if="marketsInfo" class="markets-panel">
          <el-card v-for="(info, code) in marketsInfo" :key="code" shadow="never">
            <template #header>
              <strong>{{ info.name }}</strong>
              <el-tag size="small" style="margin-left: 8px">{{ code }}</el-tag>
            </template>
            <el-tag v-for="m in info.bulkMarkets" :key="m" size="small" class="tag">{{ m }}</el-tag>
            <p class="note">{{ info.note }}</p>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import RecommendationsTable from './RecommendationsTable.vue';
import {
  refreshTennis,
  getTennisStatus,
  getTennisRecommendations,
  getTennisMarkets,
} from '../api/tennis.js';

const loading = ref(false);
const refreshing = ref(false);
const status = ref(null);
const flatRecs = ref([]);
const anchorRecs = ref([]);
const marketsInfo = ref(null);
const tab = ref('flat');

const syncStatusText = computed(() => {
  if (!status.value?.lastSyncAt) return '尚未同步';
  const mins = Math.floor((Date.now() - new Date(status.value.lastSyncAt).getTime()) / 60000);
  if (mins < 1) return '上次同步：剛剛';
  if (mins < 60) return `上次同步：${mins} 分鐘前`;
  return `上次同步：${status.value.lastSyncAt.slice(0, 16).replace('T', ' ')}`;
});

const emptyText = computed(() => {
  if (!status.value?.hasOddsApiKey) return '請設定 API Key';
  if (!status.value?.lastSyncAt) return '請點擊「同步網球」';
  if (!(status.value?.activeSports || []).length) return '賽事空窗，暫無盤口';
  if (!status.value?.upcomingGames) return '暫無待賽場次';
  return '暫無符合條件的網球推薦';
});

async function loadAll() {
  loading.value = true;
  try {
    const [flatRes, anchorRes, statusRes, marketsRes] = await Promise.all([
      getTennisRecommendations({ betStrategy: 'flat_bet' }),
      getTennisRecommendations({ betStrategy: 'parlay_anchor' }),
      getTennisStatus(),
      getTennisMarkets(),
    ]);
    flatRecs.value = flatRes.data || [];
    anchorRecs.value = anchorRes.data || [];
    status.value = statusRes.data;
    marketsInfo.value = marketsRes.data;
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '載入網球失敗');
  } finally {
    loading.value = false;
  }
}

async function handleRefresh() {
  refreshing.value = true;
  try {
    const res = await refreshTennis();
    const n = res.data?.sync?.activeSports?.length ?? 0;
    ElMessage.success(n ? `網球同步完成 · ${n} 個進行中賽事` : '網球同步完成 · 目前賽事空窗');
    await loadAll();
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '同步失敗');
  } finally {
    refreshing.value = false;
  }
}

onMounted(loadAll);

defineExpose({ loadAll });
</script>

<style scoped>
.sport-panel { margin-top: 8px; }
.panel-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.panel-header h2 { margin: 0 0 4px; font-size: 20px; }
.subtitle { margin: 0; color: #909399; font-size: 13px; }
.status-line { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 8px; font-size: 13px; color: #606266; }
.quota { color: #909399; }
.stats-row { display: flex; gap: 32px; margin-bottom: 16px; }
.markets-panel { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.tag { margin: 0 8px 8px 0; }
.note { font-size: 13px; color: #909399; margin-top: 8px; }
.setup-alert { margin-bottom: 12px; }
</style>
