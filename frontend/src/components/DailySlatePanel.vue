<template>
  <div class="daily-slate">
    <div class="slate-toolbar">
      <div class="slate-meta">
        <span class="tz-tag">香港時間 (UTC+8)</span>
        <span v-if="slate?.from"> {{ slate.from }} ~ {{ slate.to }}</span>
        <span v-if="slate?.totalPicks != null" class="total">共 {{ slate.totalPicks }} 條推薦</span>
        <span v-if="slate?.summary?.totalSuggestedStake" class="stake-sum">
          建議總額 {{ slate.summary.totalSuggestedStake }}元
        </span>
      </div>
      <div class="slate-filters">
        <el-radio-group v-model="strategyFilter" size="small" @change="loadSlate">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="flat_bet">均注</el-radio-button>
          <el-radio-button label="parlay_anchor">錨腿</el-radio-button>
        </el-radio-group>
        <el-select v-model="days" size="small" style="width: 110px" @change="loadSlate">
          <el-option :value="3" label="3 天" />
          <el-option :value="7" label="7 天" />
          <el-option :value="14" label="14 天" />
        </el-select>
      </div>
    </div>

    <el-alert
      v-if="enabledLeagues.length"
      type="info"
      :closable="false"
      show-icon
      class="league-alert"
    >
      <template #title>
        已啟用：{{ enabledLeagues.join(' · ') }}
      </template>
    </el-alert>

    <div v-loading="loading">
      <el-empty
        v-if="!loading && !slate?.dates?.some((d) => d.picks.length)"
        description="暫無推薦 — 請點擊上方「同步並分析」拉取各聯盟初盤"
      />

      <el-collapse v-else v-model="expandedDates" class="date-collapse">
        <el-collapse-item
          v-for="day in slate?.dates || []"
          :key="day.date"
          :name="day.date"
        >
          <template #title>
            <div class="day-header">
              <span class="day-label">
                {{ day.label }}
                <el-tag v-if="day.isToday" size="small" type="warning" effect="plain">今天</el-tag>
              </span>
              <span class="day-stats">
                <template v-if="day.summary.count">
                  {{ day.summary.count }} 條
                  <span v-if="day.summary.bySport.baseball"> · 棒球 {{ day.summary.bySport.baseball }}</span>
                  <span v-if="day.summary.bySport.football"> · 足球 {{ day.summary.bySport.football }}</span>
                  <span v-if="day.summary.bySport.basketball"> · 籃球 {{ day.summary.bySport.basketball }}</span>
                  <span v-if="day.summary.bySport.tennis"> · 網球 {{ day.summary.bySport.tennis }}</span>
                  <span v-if="day.summary.totalSuggestedStake"> · 建議 {{ day.summary.totalSuggestedStake }}元</span>
                </template>
                <template v-else>無推薦</template>
              </span>
            </div>
          </template>

          <el-table
            v-if="day.picks.length"
            :data="day.picks"
            stripe
            size="small"
            class="day-table"
          >
            <el-table-column label="時間" width="100">
              <template #default="{ row }">{{ row.local_time || formatTime(row.commence_time) }}</template>
            </el-table-column>
            <el-table-column label="聯盟" width="100">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="
                    row.sport_category === 'football'
                      ? 'success'
                      : row.sport_category === 'basketball'
                        ? 'warning'
                        : row.sport_category === 'tennis'
                          ? 'danger'
                          : ''
                  "
                >
                  {{ row.league_name || leagueLabel(row.league) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="對戰" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ formatMatchup(row.away_team, row.home_team) }}</div>
                <el-tag v-if="row.is_started" type="warning" size="small" effect="plain">進行中</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="序位" width="64">
              <template #default="{ row }">
                <el-tag v-if="row.rank_label" size="small" :type="row.pick_rank === 1 ? 'success' : 'info'">
                  {{ row.rank_label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="盤口" width="72">
              <template #default="{ row }">{{ marketLabel(row.market) }}</template>
            </el-table-column>
            <el-table-column label="推薦" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ translatePick(row.pick) }}</template>
            </el-table-column>
            <el-table-column label="賠率" width="64">
              <template #default="{ row }">{{ row.odds_decimal?.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="勝率" width="64">
              <template #default="{ row }">{{ (row.model_prob * 100).toFixed(1) }}%</template>
            </el-table-column>
            <el-table-column label="EV" width="72">
              <template #default="{ row }">
                <el-tag size="small" type="success">+{{ (row.ev * 100).toFixed(1) }}%</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="建議" width="64">
              <template #default="{ row }">
                <strong v-if="row.suggested_stake != null">{{ row.suggested_stake }}元</strong>
              </template>
            </el-table-column>
            <el-table-column label="策略" width="64">
              <template #default="{ row }">
                <span v-if="row.bet_strategy === 'flat_bet'" class="str-flat">均注</span>
                <span v-else-if="row.bet_strategy === 'parlay_anchor'" class="str-anchor">錨腿</span>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getSlate } from '../api/index.js';
import { marketLabel } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick } from '../utils/teams.js';

const props = defineProps({
  autoLoad: { type: Boolean, default: true },
});

const loading = ref(false);
const slate = ref(null);
const strategyFilter = ref('');
const days = ref(7);
const expandedDates = ref([]);

const enabledLeagues = computed(() => {
  if (!slate.value?.enabledLeagues) return [];
  const b = (slate.value.enabledLeagues.baseball || []).join('/');
  const f = (slate.value.enabledLeagues.football || []).join('/');
  const k = (slate.value.enabledLeagues.basketball || []).join('/');
  const t = slate.value.enabledLeagues.tennis ? 'ATP/WTA' : '';
  return [
    b && `棒球 ${b}`,
    f && `足球 ${f}`,
    k && `籃球 ${k}`,
    t && `網球 ${t}`,
  ].filter(Boolean);
});

function formatTime(iso) {
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

function pickExpandedDates(data) {
  const today = data?.dates?.find((d) => d.isToday);
  const withPicks = (data?.dates || []).filter((d) => d.picks.length).map((d) => d.date);
  if (today?.picks?.length) return [today.date];
  if (withPicks.length) return [withPicks[0]];
  return data?.dates?.[0]?.date ? [data.dates[0].date] : [];
}

async function loadSlate() {
  loading.value = true;
  try {
    const res = await getSlate({
      days: days.value,
      betStrategy: strategyFilter.value || undefined,
    });
    slate.value = res.data;
    expandedDates.value = pickExpandedDates(res.data);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (props.autoLoad) loadSlate();
});

defineExpose({ loadSlate, slate });
</script>

<style scoped>
.daily-slate { margin-top: 4px; }
.slate-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.slate-meta { font-size: 13px; color: #606266; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.tz-tag { background: #f4f4f5; padding: 2px 8px; border-radius: 4px; color: #909399; }
.total { font-weight: 600; color: #303133; }
.stake-sum { color: #67c23a; font-weight: 600; }
.slate-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.league-alert { margin-bottom: 12px; }
.date-collapse { border: none; }
.day-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; width: 100%; padding-right: 12px; }
.day-label { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.day-stats { font-size: 13px; color: #909399; margin-left: auto; }
.day-table { margin-bottom: 8px; }
.str-flat { color: #409eff; font-size: 12px; }
.str-anchor { color: #67c23a; font-size: 12px; }
</style>
