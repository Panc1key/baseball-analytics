<template>
  <div>
    <p v-if="sortHint" class="sort-hint">{{ sortHint }}</p>
    <el-table
      :data="displayRows"
      stripe
      v-loading="loading"
      :empty-text="emptyText"
      :span-method="spanMethod"
    >
    <el-table-column label="序位" width="72" fixed="left">
      <template #default="{ row }">
        <el-tag v-if="row.rank_label" :type="row.pick_rank === 1 ? 'success' : 'info'" size="small">
          {{ row.rank_label }}
        </el-tag>
        <el-tag v-else :type="row.tier === 'primary' ? 'success' : 'warning'" size="small">
          {{ tierLabel(row.tier) }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="聯盟" width="88">
      <template #default="{ row }">{{ leagueLabel(row.league) }}</template>
    </el-table-column>
    <el-table-column label="對戰" min-width="280">
      <template #default="{ row }">
        <div>{{ formatMatchup(row.away_team, row.home_team) }}</div>
        <div class="sub">
          <el-tag v-if="row.is_live" type="danger" size="small" effect="plain" class="live-tag">滾球</el-tag>
          <el-tag v-else-if="row.is_started" type="warning" size="small" effect="plain" class="live-tag">進行中</el-tag>
          {{ formatTime(row.commence_time) }}
          <span v-if="row._groupSize > 1" class="group-n"> · {{ row._groupSize }} 盤</span>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="盤口" width="88">
      <template #default="{ row }">{{ marketLabel(row.market) }}</template>
    </el-table-column>
    <el-table-column label="推薦" min-width="220" show-overflow-tooltip>
      <template #default="{ row }">
        <div>{{ translatePick(row.pick) }}</div>
        <div v-if="threeWayHint(row)" class="sub direction-hint">{{ threeWayHint(row) }}</div>
      </template>
    </el-table-column>
    <el-table-column label="賠率" width="68">
      <template #default="{ row }">{{ row.odds_decimal?.toFixed(2) }}</template>
    </el-table-column>
    <el-table-column label="勝率" width="72">
      <template #default="{ row }">
        <strong :class="highlightProb ? 'prob-em' : ''">{{ (row.model_prob * 100).toFixed(1) }}%</strong>
      </template>
    </el-table-column>
    <el-table-column label="優勢" width="72">
      <template #default="{ row }">
        <span v-if="row.edge_prob != null" :class="row.edge_prob > 0 ? 'pos' : ''">
          {{ row.edge_prob > 0 ? '+' : '' }}{{ row.edge_prob?.toFixed(1) }}%
        </span>
      </template>
    </el-table-column>
    <el-table-column label="評分" width="64">
      <template #default="{ row }">{{ row.score?.toFixed(0) }}</template>
    </el-table-column>
    <el-table-column label="建議注" width="76">
      <template #default="{ row }">
        <span v-if="row.suggested_stake != null">{{ row.suggested_stake }}元</span>
        <span v-else class="sub">—</span>
      </template>
    </el-table-column>
    <el-table-column label="策略" width="88">
      <template #default="{ row }">
        <el-tag v-if="row.bet_strategy === 'flat_bet'" type="success" size="small" effect="plain">均注</el-tag>
        <el-tag v-else-if="row.bet_strategy === 'parlay_anchor'" type="info" size="small" effect="plain">錨腿</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="EV" width="76">
      <template #default="{ row }">
        <el-tag :type="evTag(row.ev)" size="small">+{{ (row.ev * 100).toFixed(1) }}%</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="莊家" width="120" show-overflow-tooltip>
      <template #default="{ row }">{{ bookmakerLabel(row.bookmaker) }}</template>
    </el-table-column>
    <el-table-column label="分析" min-width="240" show-overflow-tooltip>
      <template #default="{ row }">{{ translateReasoning(row.reasoning) }}</template>
    </el-table-column>
  </el-table>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { marketLabel, tierLabel } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick, translateReasoning, bookmakerLabel } from '../utils/teams.js';

const props = defineProps({
  recommendations: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  emptyText: { type: String, default: '尚無推薦' },
  sortHint: { type: String, default: '' },
  highlightProb: { type: Boolean, default: false },
});

function matchupKey(row) {
  const day = row.commence_time ? String(row.commence_time).slice(0, 10) : '';
  return `${row.league}|${day}|${row.away_team}|${row.home_team}`;
}

/** 同場排在一起，並標記合併列資訊 */
const displayRows = computed(() => {
  const groups = new Map();
  for (const row of props.recommendations || []) {
    const key = matchupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const rows = [];
  for (const list of groups.values()) {
    list.forEach((row, idx) => {
      rows.push({
        ...row,
        _groupKey: matchupKey(row),
        _groupSize: list.length,
        _groupIndex: idx,
      });
    });
  }
  return rows;
});

function spanMethod({ row, columnIndex }) {
  // 合併：聯盟(1)、對戰(2)
  if (columnIndex !== 1 && columnIndex !== 2) {
    return { rowspan: 1, colspan: 1 };
  }
  if (row._groupIndex === 0) {
    return { rowspan: row._groupSize, colspan: 1 };
  }
  return { rowspan: 0, colspan: 0 };
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 從分析文案抽出三向/雙選提示，讓使用者不只看到「法國勝」 */
function threeWayHint(row) {
  const text = row?.reasoning || '';
  const dir = text.match(/方向：[^.|]+/);
  if (dir) return translatePick(dir[0].trim());
  const m = text.match(/三向[^|]+/);
  if (m) return m[0].trim();
  const m2 = text.match(/雙選[^|]+/);
  return m2 ? m2[0].trim() : '';
}

function evTag(ev) {
  if (ev >= 0.08) return 'success';
  if (ev >= 0.05) return 'warning';
  return 'info';
}
</script>

<style scoped>
.sort-hint { font-size: 12px; color: #909399; margin: 0 0 8px; }
.sub { font-size: 12px; color: #909399; }
.group-n { color: #409eff; }
.direction-hint { color: #e6a23c; margin-top: 2px; }
.live-tag { margin-right: 4px; vertical-align: middle; }
.pos { color: #67c23a; font-weight: 600; }
.prob-em { color: #67c23a; }
</style>
