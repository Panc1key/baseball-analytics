<template>
  <div class="live-panel">
    <div class="live-toolbar">
      <div class="live-meta">
        <el-tag type="danger" effect="dark" size="small">滾球 v1</el-tag>
        <span v-if="meta">進行中 {{ meta.liveGameCount }} 場 · 推薦 {{ meta.recommendationCount }} 條</span>
        <span class="hint-inline">初盤 prior + 比分條件更新 · 優先獨贏</span>
      </div>
      <div class="live-actions">
        <el-radio-group v-model="league" size="small" @change="loadLive">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="MLB">MLB</el-radio-button>
          <el-radio-button label="NPB">NPB</el-radio-button>
          <el-radio-button label="KBO">KBO</el-radio-button>
        </el-radio-group>
        <el-button size="small" :loading="loading" @click="loadLive">重新載入</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon class="live-alert">
      <template #title>
        v1.1 硬閘：無比分不推 · 勝率&lt;65%不得主推 · 與市場差&gt;12pt拒絕 · 一邊倒降速 · 注碼折減並標最壞風險。局數暫由開賽時間粗估。
      </template>
    </el-alert>

    <el-table :data="recs" stripe v-loading="loading" empty-text="目前無滾球推薦（可能無進行中賽事，或尚未同步）">
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
import { ref, onMounted } from 'vue';
import { getLiveRecommendations } from '../api/index.js';
import { marketLabel } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick, translateReasoning } from '../utils/teams.js';

const props = defineProps({
  autoLoad: { type: Boolean, default: true },
});

const recs = ref([]);
const meta = ref(null);
const loading = ref(false);
const league = ref('');

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

defineExpose({ loadLive, recs, meta });

onMounted(() => {
  if (props.autoLoad) loadLive();
});
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
