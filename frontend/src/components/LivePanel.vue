<template>
  <div class="live-panel">
    <div class="live-toolbar">
      <div class="live-meta">
        <el-tag type="danger" effect="dark" size="small">滾球 v1.3</el-tag>
        <span v-if="meta">進行中 {{ meta.liveGameCount }} 場 · 推薦 {{ meta.recommendationCount }} 條</span>
        <span class="hint-inline">開局/0-0 凍結 · 對齊初盤 · 命中率優先</span>
      </div>
      <div class="live-actions">
        <el-radio-group v-model="league" size="small" @change="loadLive">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="MLB">MLB</el-radio-button>
          <el-radio-button label="NPB">NPB</el-radio-button>
          <el-radio-button label="KBO">KBO</el-radio-button>
        </el-radio-group>
        <el-button size="small" :loading="loading" @click="loadLive">重新載入</el-button>
        <el-button type="primary" size="small" :loading="refreshing" @click="handleRefreshLive">
          同步滾球
        </el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon class="live-alert">
      <template #title>
        v1.3：開局前 3 局不推 · 0-0 需更晚 · 平手不推獨贏 · 小球加嚴 · 早段禁止翻初盤結論。
        MLB 用官方 linescore；NPB 用 Yahoo 補比分。無比分不推 · 獨贏勝率&lt;60%不推 · &lt;65% 不掛關注。
        「同步滾球」更新比分+賠率後重算。
        <span v-if="pollMinutes > 0">列表每 {{ pollMinutes }} 分鐘自動重載（不耗 API）；更新盤口請按「同步滾球」。</span>
      </template>
    </el-alert>

    <el-table :data="recs" stripe v-loading="loading || refreshing" empty-text="目前無滾球推薦（開局凍結／門檻未過／無進行中賽事，屬正常）">
      <el-table-column label="聯盟" width="88">
        <template #default="{ row }">{{ leagueLabel(row.league) }}</template>
      </el-table-column>
      <el-table-column label="對戰 / 比分" min-width="260">
        <template #default="{ row }">
          <div>{{ formatMatchup(row.away_team, row.home_team) }}</div>
          <div class="sub">
            <el-tag type="danger" size="small" effect="plain">滾球</el-tag>
            <span v-if="row.live_score"> 比分 {{ row.live_score }}（客-主）</span>
            <span> · {{ formatTime(row.commence_time) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="盤口" width="80">
        <template #default="{ row }">{{ marketLabel(row.market) }}</template>
      </el-table-column>
      <el-table-column label="推薦" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ translatePick(row.pick) }}</template>
      </el-table-column>
      <el-table-column label="賠率" width="68">
        <template #default="{ row }">{{ row.odds_decimal?.toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="勝率" width="72">
        <template #default="{ row }">
          <strong>{{ (row.model_prob * 100).toFixed(1) }}%</strong>
        </template>
      </el-table-column>
      <el-table-column label="優勢" width="72">
        <template #default="{ row }">
          <span v-if="row.edge_prob != null" class="pos">
            +{{ row.edge_prob?.toFixed(1) }}%
          </span>
        </template>
      </el-table-column>
      <el-table-column label="EV" width="76">
        <template #default="{ row }">
          <el-tag type="success" size="small">+{{ (row.ev * 100).toFixed(1) }}%</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="建議注" width="76">
        <template #default="{ row }">
          <span v-if="row.suggested_stake != null">{{ row.suggested_stake }}元</span>
          <span v-else class="sub">—</span>
        </template>
      </el-table-column>
      <el-table-column label="分析" min-width="280" show-overflow-tooltip>
        <template #default="{ row }">{{ translateReasoning(row.reasoning) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { getLiveRecommendations, refreshLive } from '../api/index.js';
import { marketLabel } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick, translateReasoning } from '../utils/teams.js';

const props = defineProps({
  autoLoad: { type: Boolean, default: true },
});

const recs = ref([]);
const meta = ref(null);
const loading = ref(false);
const refreshing = ref(false);
const league = ref('');
let pollTimer = null;

const pollMinutes = computed(() => Number(meta.value?.thresholds?.pollMinutes ?? 5));

function formatTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

async function loadLive() {
  loading.value = true;
  try {
    const res = await getLiveRecommendations({
      league: league.value || undefined,
      limit: 60,
    });
    recs.value = res.data || [];
    meta.value = res.meta || null;
  } catch (err) {
    console.warn(err);
    recs.value = [];
  } finally {
    loading.value = false;
  }
}

async function handleRefreshLive() {
  refreshing.value = true;
  try {
    const res = await refreshLive();
    const status = res.data?.status;
    if (status) meta.value = status;
    ElMessage.success(
      `滾球已同步 · 場次 ${status?.liveGameCount ?? '?'} · 推薦 ${status?.recommendationCount ?? res.data?.analysis?.recommendations ?? '?'}`
    );
    await loadLive();
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '滾球同步失敗');
  } finally {
    refreshing.value = false;
  }
}

function setupPoll() {
  clearPoll();
  const mins = pollMinutes.value;
  if (!mins || mins <= 0) return;
  // 僅重讀庫內滾球推薦，不打 Odds API（額度保護）；更新盤口請按「同步滾球」
  pollTimer = setInterval(() => {
    loadLive();
  }, mins * 60 * 1000);
}

function clearPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

defineExpose({ loadLive, handleRefreshLive, recs, meta });

onMounted(async () => {
  if (props.autoLoad) await loadLive();
  setupPoll();
});

onUnmounted(clearPoll);
</script>

<style scoped>
.live-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.live-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #606266;
}
.hint-inline { color: #909399; }
.live-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.live-alert { margin-bottom: 12px; }
.sub { margin-top: 4px; font-size: 12px; color: #909399; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pos { color: #67c23a; font-weight: 600; }
</style>
