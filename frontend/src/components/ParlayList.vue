<template>
  <div v-loading="loading">
    <div v-if="meta" class="parlay-meta">
      <span>策略：{{ meta.strategy }}</span>
      <span>每注 ${{ meta.baseStake ?? 1 }}</span>
      <span>每腿賠率 ≥ {{ meta.minLegOdds ?? 1.4 }}</span>
      <span>最多 {{ meta.maxLegs ?? 12 }} 腿</span>
      <span v-if="meta.minLegEv != null">每腿 EV ≥ {{ (meta.minLegEv * 100).toFixed(0) }}%</span>
      <span v-if="parlays.length">共 {{ parlays.length }} 組</span>
    </div>

    <div v-if="parlays.length" class="filter-bar">
      <span class="filter-label">串關類型</span>
      <el-radio-group v-model="legFilter" size="small">
        <el-radio-button label="">
          全部{{ legCountMap.all ? ` (${legCountMap.all})` : '' }}
        </el-radio-button>
        <el-radio-button
          v-for="n in availableLegCounts"
          :key="n"
          :label="String(n)"
        >
          {{ n }}串1 ({{ legCountMap[n] || 0 }})
        </el-radio-button>
      </el-radio-group>
    </div>

    <el-empty v-if="!parlays.length" :description="emptyText" />
    <el-empty v-else-if="!filteredParlays.length" :description="filterEmptyText" />

    <div v-for="group in groupedParlays" :key="group.key">
      <h3 v-if="groupedParlays.length > 1" class="group-title">{{ group.title }}</h3>
      <el-card
        v-for="(p, idx) in group.items"
        :key="p.id || `${group.key}-${idx}`"
        class="parlay-card"
        shadow="hover"
      >
        <div class="parlay-top">
          <el-tag type="success">{{ p.parlay_label || `${p.leg_count || p.legs?.length}串1` }}</el-tag>
          <span class="stake-line">
            下注 <strong>${{ formatMoney(p.suggested_stake ?? 1) }}</strong>
            → 若中 <strong class="payout">${{ formatMoney(p.potential_payout ?? p.combined_odds) }}</strong>
          </span>
          <el-tag v-if="p.is_lottery" type="danger" size="small">長串彩券</el-tag>
        </div>
        <el-alert
          v-if="p.is_lottery"
          type="info"
          :closable="false"
          show-icon
          class="lottery-alert"
          title="長串不要求全中；此為高賠率彩券型，單場均注正 EV 才是長期盈利核心"
        />
        <div class="parlay-summary">{{ translatePick(p.pickSummary || buildSummary(p.legs)) }}</div>
        <div class="parlay-header">
          <span>合計賠率 <strong>{{ p.combined_odds?.toFixed(2) }}</strong></span>
          <span class="hit-prob">模型勝率 <strong>{{ (p.combined_prob * 100).toFixed(2) }}%</strong></span>
          <span v-if="p.combined_implied_prob != null" class="market-prob">
            市場隱含 <strong>{{ formatTinyPct(p.combined_implied_prob) }}</strong>
          </span>
          <span v-if="p.combined_score">評分 {{ p.combined_score?.toFixed(0) }}</span>
          <span>涵蓋 {{ p.games_covered || p.legs?.length }} 場</span>
          <el-tag v-if="p.combined_ev > 0" type="warning" size="small">
            EV +{{ (p.combined_ev * 100).toFixed(1) }}%
          </el-tag>
        </div>
        <ul class="legs">
          <li v-for="(leg, i) in p.legs" :key="i" class="leg-item">
            <div class="leg-num">第 {{ i + 1 }} 腿</div>
            <div class="leg-matchup">
              <el-tag size="small" type="info">{{ leagueLabel(leg.league) }}</el-tag>
              <span>{{ formatMatchup(leg.awayTeam, leg.homeTeam) }}</span>
              <span class="leg-time">{{ formatTime(leg.commenceTime) }}</span>
            </div>
            <div class="leg-pick">
              <strong>{{ marketLabel(leg.market) }} · {{ translatePick(leg.pick) }}</strong>
              <span>@ {{ leg.odds?.toFixed(2) }}</span>
              <el-tag size="small" type="success">勝率 {{ ((leg.modelProb || 0) * 100).toFixed(1) }}%</el-tag>
            </div>
          </li>
        </ul>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { marketLabel, formatGameTime } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick } from '../utils/teams.js';

const props = defineProps({
  parlays: { type: Array, default: () => [] },
  meta: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  emptyText: { type: String, default: '尚無串關推薦' },
});

const formatTime = formatGameTime;
const legFilter = ref('');

const GROUP_LABELS = {
  full_slate: '當日全場',
  best_ev: '正 EV 精選',
  main_markets: '主盤串關',
  best_hit: '最高命中',
  value_hit: '穩健小博大',
  daily_cover: '場次覆蓋',
  combo: '其他組合',
};

function getLegCount(p) {
  return p.leg_count || p.legs?.length || 0;
}

const legCountMap = computed(() => {
  const map = { all: props.parlays.length };
  for (const p of props.parlays) {
    const n = getLegCount(p);
    map[n] = (map[n] || 0) + 1;
  }
  return map;
});

const availableLegCounts = computed(() =>
  Object.keys(legCountMap.value)
    .filter((k) => k !== 'all')
    .map(Number)
    .sort((a, b) => a - b)
);

const filteredParlays = computed(() => {
  if (!legFilter.value) return props.parlays;
  const n = parseInt(legFilter.value, 10);
  return props.parlays.filter((p) => getLegCount(p) === n);
});

const filterEmptyText = computed(() => {
  const n = legFilter.value;
  if (!n) return '尚無符合條件的串關';
  return `目前沒有 ${n}串1 推薦，請選擇其他類型`;
});

const groupedParlays = computed(() => {
  const map = new Map();
  for (const p of filteredParlays.value) {
    const key = p.category || 'combo';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const order = ['best_ev', 'main_markets', 'full_slate', 'best_hit', 'value_hit', 'daily_cover', 'combo'];
  return order
    .filter((k) => map.has(k))
    .map((k) => ({ key: k, title: GROUP_LABELS[k] || k, items: map.get(k) }));
});

watch(
  () => props.parlays,
  () => {
    if (legFilter.value && !availableLegCounts.value.includes(parseInt(legFilter.value, 10))) {
      legFilter.value = '';
    }
  }
);

function buildSummary(legs) {
  return (legs || []).map((l) => l.pick).join(' + ');
}

function formatTinyPct(prob) {
  const pct = prob * 100;
  if (pct < 0.01) return `${pct.toFixed(4)}%`;
  if (pct < 1) return `${pct.toFixed(3)}%`;
  return `${pct.toFixed(2)}%`;
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}
</script>

<style scoped>
.parlay-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #606266;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: #fdf6ec;
  border-radius: 6px;
  border: 1px solid #faecd8;
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.filter-label {
  font-size: 13px;
  color: #606266;
  flex-shrink: 0;
}
.group-title {
  font-size: 15px;
  color: #303133;
  margin: 18px 0 10px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
.group-title:first-of-type { margin-top: 0; }
.parlay-card { margin-bottom: 14px; }
.parlay-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.stake-line { font-size: 14px; color: #303133; }
.payout { color: #e6a23c; }
.parlay-summary {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 10px;
  line-height: 1.5;
  padding: 8px 12px;
  background: #f0f9eb;
  border-radius: 6px;
  border-left: 3px solid #67c23a;
}
.parlay-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
}
.hit-prob strong { color: #67c23a; }
.market-prob strong { color: #909399; font-weight: 600; }
.legs { margin: 0; padding: 0; list-style: none; }
.leg-item {
  padding: 10px 0;
  border-top: 1px solid #ebeef5;
  font-size: 13px;
  color: #606266;
}
.leg-item:first-child { border-top: none; padding-top: 0; }
.leg-num { font-size: 12px; color: #909399; margin-bottom: 4px; }
.leg-matchup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-weight: 500;
  color: #303133;
}
.leg-time { font-size: 12px; color: #909399; font-weight: 400; }
.leg-pick { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
</style>
