<template>
  <div class="sport-panel">
    <div class="panel-header">
      <div>
        <h2>籃球初盤分析</h2>
        <p class="subtitle">NBA / WNBA / 夏季聯賽 · Log5 獨贏 · 淨勝分讓分 · 期望總分</p>
        <div v-if="status" class="status-line">
          <span>{{ syncStatusText }}</span>
          <span v-if="status.oddsQuotaRemaining != null" class="quota">
            Odds API 剩餘 {{ status.oddsQuotaRemaining }}
          </span>
        </div>
      </div>
      <el-button type="primary" :loading="refreshing" :disabled="!status?.hasOddsApiKey" @click="handleRefresh">
        同步籃球
      </el-button>
    </div>

    <div v-if="status" class="stats-row">
      <el-statistic title="待賽場次" :value="status.upcomingGames" />
      <el-statistic title="推薦數" :value="status.recommendationCount" />
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="均注精選" name="flat">
        <RecommendationsTable
          :recommendations="flatRecs"
          :loading="loading"
          :empty-text="emptyText"
          sort-hint="籃球 EV 排序"
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
  refreshBasketball,
  getBasketballStatus,
  getBasketballRecommendations,
  getBasketballMarkets,
} from '../api/basketball.js';

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
  if (!status.value?.lastSyncAt) return '請點擊「同步籃球」';
  if (!status.value?.upcomingGames) return '暫無開盤（NBA 休賽常見；可試 WNBA／夏季聯賽）';
  return '暫無符合條件的籃球推薦';
});

async function loadAll() {
  loading.value = true;
  try {
    const [flatRes, anchorRes, statusRes, marketsRes] = await Promise.all([
      getBasketballRecommendations({ betStrategy: 'flat_bet' }),
      getBasketballRecommendations({ betStrategy: 'parlay_anchor' }),
      getBasketballStatus(),
      getBasketballMarkets(),
    ]);
    flatRecs.value = flatRes.data || [];
    anchorRecs.value = anchorRes.data || [];
    status.value = statusRes.data;
    marketsInfo.value = marketsRes.data;
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '載入籃球失敗');
  } finally {
    loading.value = false;
  }
}

async function handleRefresh() {
  refreshing.value = true;
  try {
    const res = await refreshBasketball();
    const counts = res.data?.sync?.gameCounts || {};
    ElMessage.success(`籃球同步完成 · 場次 ${JSON.stringify(counts)}`);
    await loadAll();
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '同步失敗');
  } finally {
    refreshing.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.sport-panel { margin-top: 8px; }
.panel-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.panel-header h2 { margin: 0 0 4px; font-size: 20px; }
.subtitle { margin: 0; color: #909399; font-size: 13px; }
.status-line { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 13px; color: #606266; }
.quota { color: #909399; }
.stats-row { display: flex; gap: 32px; margin-bottom: 16px; }
.markets-panel { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.tag { margin: 0 8px 8px 0; }
.note { font-size: 13px; color: #909399; margin-top: 8px; }
</style>
