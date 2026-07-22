<template>
  <div class="daily-slate">
    <div class="toolbar">
      <div class="toolbar-left">
        <el-radio-group v-model="viewFilter" size="small">
          <el-radio-button label="all">全部初盤</el-radio-button>
          <el-radio-button label="actionable">關注/均注</el-radio-button>
          <el-radio-button label="flat_bet">僅均注</el-radio-button>
        </el-radio-group>
        <el-select v-model="days" size="small" style="width: 96px" @change="loadSlate">
          <el-option :value="2" label="2 天" />
          <el-option :value="3" label="3 天" />
          <el-option :value="7" label="7 天" />
        </el-select>
      </div>
      <div class="toolbar-meta">
        <span v-if="visibleGameCount != null">{{ visibleGameCount }} 場</span>
        <span v-if="updatedLabel" :title="updatedAbsolute">· {{ updatedLabel }}</span>
      </div>
    </div>

    <p class="hint">
      香港時間分日 · 美職晚場多半在「明天」· 開賽後 1 小時內仍顯示／補算初盤
    </p>

    <div v-loading="loading">
      <el-empty
        v-if="!loading && !visibleDays.length"
        :description="emptyText"
      />

      <section v-for="day in visibleDays" :key="day.date" class="day-block">
        <header class="day-title">
          <span>{{ day.label }}</span>
          <el-tag v-if="day.isToday" size="small" type="warning" effect="plain">今天</el-tag>
          <span class="day-count">{{ day.games.length }} 場</span>
        </header>

        <article
          v-for="game in day.games"
          :key="`${game.game_id}|${game.away_team}|${game.home_team}`"
          class="game-card"
          :class="{
            'is-flat': hasFlat(game),
            'is-primary': hasPrimary(game) && !hasFlat(game),
            'is-started': game.is_started,
          }"
        >
          <div class="game-top">
            <span class="league">{{ game.league_name || leagueLabel(game.league) }}</span>
            <span class="time">{{ game.local_time || formatTime(game.commence_time) }}</span>
            <el-tag v-if="game.is_started" type="warning" size="small" effect="dark">
              進行中 · 初盤推送
            </el-tag>
            <el-tag v-else size="small" type="info" effect="plain">初盤</el-tag>
          </div>

          <div class="matchup">{{ formatMatchup(game.away_team, game.home_team) }}</div>

          <div v-if="!game.picks?.length" class="pick-empty">
            尚無初盤推薦 — 請點「同步並分析」補算（開賽 1 小時內可補）
          </div>

          <div
            v-for="(pick, idx) in game.picks"
            :key="pick.id || `${pick.market}-${pick.pick}-${idx}`"
            class="pick-row"
            :class="{ lead: idx === 0, muted: idx > 0 && !isActionablePick(pick) }"
          >
            <div class="pick-main">
              <span class="badge" :class="badgeClass(pick)">{{ badgeText(pick) }}</span>
              <span class="market">{{ marketLabel(pick.market) }}</span>
              <strong class="pick-name">{{ translatePick(pick.pick) }}</strong>
            </div>
            <div class="pick-nums">
              <span class="odds">@{{ pick.odds_decimal?.toFixed(2) }}</span>
              <span class="prob">{{ (pick.model_prob * 100).toFixed(0) }}%</span>
              <span class="ev">+{{ (pick.ev * 100).toFixed(1) }}%</span>
              <span v-if="pick.suggested_stake != null" class="stake">{{ pick.suggested_stake }}元</span>
            </div>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getSlate } from '../api/index.js';
import { marketLabel, tierLabel } from '../utils/market.js';
import { formatMatchup, leagueLabel, translatePick } from '../utils/teams.js';

const props = defineProps({
  autoLoad: { type: Boolean, default: true },
  /** baseball | basketball | football | tennis | all — 空／all 為跨運動 */
  sport: { type: String, default: 'baseball' },
});

const loading = ref(false);
const slate = ref(null);
/** all | actionable | flat_bet — 預設關注／均注，避免樣本／觀察淹沒可下單層 */
const viewFilter = ref('actionable');
const days = ref(2);

function isActionablePick(p) {
  return p.bet_strategy === 'flat_bet' || p.tier === 'primary';
}

function filterPicks(picks) {
  const list = picks || [];
  if (viewFilter.value === 'flat_bet') {
    return list.filter((p) => p.bet_strategy === 'flat_bet');
  }
  if (viewFilter.value === 'actionable') {
    return list.filter(isActionablePick);
  }
  // 「全部」也不展示樣本（樣本非可下單層，易與滾球污染單混淆）
  return list.filter((p) => p.tier !== 'sample');
}

function sortPicks(picks) {
  return [...picks].sort((a, b) => {
    const rank = (p) => {
      if (p.bet_strategy === 'flat_bet') return 0;
      if (p.tier === 'primary') return 1;
      if (p.tier === 'watch') return 2;
      return 3;
    };
    return rank(a) - rank(b) || (b.model_prob || 0) - (a.model_prob || 0);
  });
}

const visibleDays = computed(() => {
  const dates = slate.value?.dates || [];
  return dates
    .map((day) => {
      const games = (day.games || [])
        .map((g) => {
          const picks = sortPicks(filterPicks(g.picks));
          // 「全部」時：無推薦的場次也要顯示；篩均注/關注時只留有命中的
          if (!picks.length) {
            if (viewFilter.value === 'all') return { ...g, picks: [] };
            return null;
          }
          return { ...g, picks };
        })
        .filter(Boolean);
      return { ...day, games };
    })
    .filter((d) => d.games.length);
});

const visibleGameCount = computed(() =>
  visibleDays.value.reduce((n, d) => n + d.games.length, 0)
);

const emptyText = computed(() => {
  if (viewFilter.value === 'flat_bet') return '目前沒有均注精選';
  if (viewFilter.value === 'actionable')
    return '目前沒有關注／均注（觀察／樣本不算可下單；可切「全部初盤」看觀察）';
  return '暫無初盤推薦 — 請點擊上方「同步」按鈕';
});

function formatHkAbsolute(iso) {
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

function formatHkRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return formatHkAbsolute(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  return formatHkAbsolute(iso);
}

const updatedAbsolute = computed(() => formatHkAbsolute(slate.value?.updatedAt));
const updatedLabel = computed(() => {
  if (!slate.value?.updatedAt) return '';
  return formatHkRelative(slate.value.updatedAt);
});

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function hasFlat(game) {
  return (game.picks || []).some((p) => p.bet_strategy === 'flat_bet');
}

function hasPrimary(game) {
  return (game.picks || []).some((p) => p.tier === 'primary');
}

function badgeText(pick) {
  if (pick.bet_strategy === 'flat_bet') return '均注';
  if (pick.bet_strategy === 'parlay_anchor') return '錨腿';
  return tierLabel(pick.tier);
}

function badgeClass(pick) {
  if (pick.bet_strategy === 'flat_bet') return 'flat';
  if (pick.tier === 'primary') return 'primary';
  if (pick.tier === 'sample') return 'sample';
  return 'watch';
}

async function loadSlate() {
  loading.value = true;
  try {
    const params = { days: days.value };
    if (props.sport && props.sport !== 'all') params.sport = props.sport;
    const res = await getSlate(params);
    slate.value = res.data;
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
.daily-slate { margin-top: 2px; }
.toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.toolbar-left { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.toolbar-meta { font-size: 12px; color: #86909c; }
.hint { margin: 0 0 14px; font-size: 12px; color: #86909c; }

.day-block { margin-bottom: 20px; }
.day-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 700;
}
.day-count { margin-left: auto; font-size: 12px; font-weight: 500; color: #86909c; }

.game-card {
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
}
.game-card.is-flat { border-color: #91caff; background: #f7fbff; }
.game-card.is-primary { border-color: #b7eb8f; }
.game-card.is-started { border-style: dashed; }

.game-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.league {
  font-size: 11px;
  font-weight: 600;
  color: #4e5969;
  background: #f2f3f5;
  padding: 2px 7px;
  border-radius: 4px;
}
.time { font-size: 12px; color: #86909c; }
.matchup {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 10px;
  letter-spacing: -0.01em;
}

.pick-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #f0f0f0;
}
.pick-row.lead { border-top: none; padding-top: 0; }
.pick-row.muted { opacity: 0.72; }
.pick-empty {
  font-size: 12px;
  color: #86909c;
  padding: 6px 0 2px;
}
.pick-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
}
.badge.flat { background: #1677ff; color: #fff; }
.badge.primary { background: #52c41a; color: #fff; }
.badge.watch { background: #fff7e6; color: #d48806; }
.badge.sample { background: #f5f5f5; color: #8c8c8c; }
.market { font-size: 12px; color: #86909c; }
.pick-name { font-size: 14px; }
.pick-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: #4e5969;
}
.odds { font-weight: 600; color: #1f2329; }
.prob { color: #1677ff; font-weight: 600; }
.ev { color: #52c41a; font-weight: 600; }
.stake { color: #1f2329; font-weight: 700; }

@media (max-width: 640px) {
  .pick-row { flex-direction: column; align-items: flex-start; }
  .matchup { font-size: 15px; }
}
</style>
