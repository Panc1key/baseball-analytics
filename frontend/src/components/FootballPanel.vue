<template>
  <div class="football-panel">
    <div class="fb-header">
      <div>
        <h2>世界盃足球分析</h2>
        <p class="subtitle">獨立引擎 · 陣容/戰術/球員盤 · 可擴展五大聯賽</p>
        <div v-if="status" class="status-line">
          <span>{{ syncStatusText }}</span>
          <span v-if="status.oddsQuotaRemaining != null" class="quota">
            Odds API 剩餘 {{ status.oddsQuotaRemaining }} 次
          </span>
          <el-tag v-if="status.hasFootballStatsApi" type="success" size="small">API-Football 已接入</el-tag>
          <el-tag v-else type="info" size="small">僅賠率模式</el-tag>
        </div>
      </div>
      <el-button
        type="primary"
        :loading="refreshing"
        :disabled="!status?.hasOddsApiKey"
        @click="handleRefresh"
      >
        同步世界盃
      </el-button>
    </div>

    <el-alert
      v-if="status && !status.hasOddsApiKey"
      type="warning"
      :closable="false"
      show-icon
      title="需要 ODDS_API_KEY"
      description="在 backend/.env 填入 The Odds API Key 後重啟後端"
      class="setup-alert"
    />

    <el-alert
      v-else-if="status && !status.hasFootballStatsApi"
      type="info"
      :closable="false"
      show-icon
      title="建議接入 API-Football"
      description="設定 API_FOOTBALL_KEY 可啟用首發陣容、傷病、教練戰術與球員數據（免費 100 次/天）"
      class="setup-alert"
    />

    <div v-if="status" class="fb-stats">
      <el-statistic title="待賽場次" :value="status.upcomingGames" />
      <el-statistic title="推薦數" :value="status.recommendationCount" />
    </div>

    <el-tabs v-model="fbTab">
      <el-tab-pane label="均注精選" name="flat">
        <div v-if="meta?.flatBet" class="strategy-banner flat">
          <strong>{{ meta.flatBet.label }}</strong>
          <span>賠率 ≥ {{ meta.flatBet.minOdds }}</span>
          <span>勝率 ≥ {{ (meta.flatBet.minProb * 100).toFixed(0) }}%</span>
          <span>EV ≥ {{ (meta.flatBet.minEv * 100).toFixed(0) }}%</span>
        </div>
        <RecommendationsTable
          :recommendations="flatRecs"
          :loading="loading"
          :empty-text="emptyText"
          sort-hint="足球 EV 排序 · 含球員進球/射正等盤口"
        />
      </el-tab-pane>

      <el-tab-pane label="串關錨腿" name="anchor">
        <div v-if="meta?.parlayAnchor" class="strategy-banner anchor">
          <strong>{{ meta.parlayAnchor.label }}</strong>
          <span>賠率 {{ meta.parlayAnchor.minOdds }}～{{ meta.parlayAnchor.maxOdds }}</span>
          <span>勝率 ≥ {{ (meta.parlayAnchor.minProb * 100).toFixed(0) }}%</span>
        </div>
        <RecommendationsTable
          :recommendations="anchorRecs"
          :loading="loading"
          :empty-text="anchorEmptyText"
          sort-hint="低水高勝率 · 淘汰賽穩腿"
          highlight-prob
        />
      </el-tab-pane>

      <el-tab-pane label="球員盤" name="props">
        <RecommendationsTable
          :recommendations="propRecs"
          :loading="loading"
          empty-text="暫無球員盤推薦（需賽前開盤且 API 有數據）"
          sort-hint="進球/射正/助攻/吃牌"
        />
      </el-tab-pane>

      <el-tab-pane label="盤口說明" name="markets">
        <div v-if="marketsInfo" class="markets-panel">
          <el-card v-for="(info, code) in marketsInfo" :key="code" shadow="never">
            <template #header>
              <strong>{{ info.name }}</strong>
              <el-tag size="small" style="margin-left: 8px">{{ code }}</el-tag>
            </template>
            <p class="section-title">主盤</p>
            <el-tag v-for="m in info.bulkMarkets" :key="m" size="small" class="tag">{{ m }}</el-tag>
            <p class="section-title">球員盤（逐場）</p>
            <el-tag v-for="m in info.eventMarkets" :key="m" type="success" size="small" class="tag">{{ m }}</el-tag>
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
  refreshFootball,
  getFootballStatus,
  getFootballRecommendations,
  getFootballMarkets,
} from '../api/football.js';

const loading = ref(false);
const refreshing = ref(false);
const status = ref(null);
const meta = ref(null);
const flatRecs = ref([]);
const anchorRecs = ref([]);
const propRecs = ref([]);
const marketsInfo = ref(null);
const fbTab = ref('flat');

const syncStatusText = computed(() => {
  if (!status.value?.lastSyncAt) return '尚未同步';
  const diff = Date.now() - new Date(status.value.lastSyncAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '上次同步：剛剛';
  if (mins < 60) return `上次同步：${mins} 分鐘前`;
  return `上次同步：${status.value.lastSyncAt.slice(0, 16).replace('T', ' ')}`;
});

const emptyText = computed(() => {
  if (!status.value?.hasOddsApiKey) return '請設定 API Key';
  if (!status.value?.lastSyncAt) return '請點擊「同步世界盃」';
  if (!status.value?.upcomingGames) return '世界盃賽程已結束或暫無開盤';
  return '暫無符合條件的足球推薦';
});

const anchorEmptyText = computed(() => {
  if (!status.value?.lastSyncAt) return '請先同步';
  return '暫無串關錨腿推薦';
});

async function loadAll() {
  loading.value = true;
  try {
    const [flatRes, anchorRes, propRes, statusRes, marketsRes] = await Promise.all([
      getFootballRecommendations({ betStrategy: 'flat_bet', league: 'WC' }),
      getFootballRecommendations({ betStrategy: 'parlay_anchor', league: 'WC' }),
      getFootballRecommendations({ marketGroup: 'props', league: 'WC' }),
      getFootballStatus(),
      getFootballMarkets(),
    ]);
    flatRecs.value = flatRes.data || [];
    anchorRecs.value = anchorRes.data || [];
    propRecs.value = propRes.data || [];
    meta.value = flatRes.meta || anchorRes.meta;
    status.value = statusRes.data;
    marketsInfo.value = marketsRes.data;
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '載入足球數據失敗');
  } finally {
    loading.value = false;
  }
}

async function handleRefresh() {
  refreshing.value = true;
  try {
    await refreshFootball();
    ElMessage.success('世界盃同步與分析完成');
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
.football-panel { margin-top: 8px; }
.fb-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.fb-header h2 { margin: 0 0 4px; font-size: 20px; }
.subtitle { margin: 0; color: #909399; font-size: 13px; }
.status-line { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 8px; font-size: 13px; color: #606266; }
.quota { color: #909399; }
.fb-stats { display: flex; gap: 32px; margin-bottom: 16px; }
.strategy-banner { display: flex; flex-wrap: wrap; gap: 12px; padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
.strategy-banner.flat { background: #fdf6ec; border: 1px solid #faecd8; }
.strategy-banner.anchor { background: #f0f9eb; border: 1px solid #e1f3d8; }
.markets-panel { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.section-title { font-size: 13px; color: #606266; margin: 12px 0 8px; }
.section-title:first-of-type { margin-top: 0; }
.tag { margin: 0 8px 8px 0; }
.note { font-size: 13px; color: #909399; margin-top: 8px; }
.setup-alert { margin-bottom: 12px; }
</style>
