<template>
  <section class="truth-panel" v-loading="loading">
    <header class="toolbar">
      <div>
        <h2 class="panel-title">今日鎖定 B 組合包</h2>
        <p class="panel-sub">
          獨贏主倉 + Hybrid 大小 · 單場 ${{ packageStake }} · 串關 ${{ parlayStake }}（一半）· 可看選邊僅開賽前
          {{ releaseHoursBefore || 8 }} 小時內放出
        </p>
      </div>
      <el-button size="small" plain :loading="loading" @click="loadTruth">重新載入</el-button>
    </header>

    <p v-if="lockedBPackage?.note" class="package-note">{{ lockedBPackage.note }}</p>
    <p v-if="stakeGuideText" class="package-note stake-guide">{{ stakeGuideText }}</p>

    <p v-if="highEvShrinkNote" class="shadow-overlay-note" :class="{ apply: highEvShrinkApply }">
      {{ highEvShrinkNote }}
    </p>

    <div v-if="packageSingles.length" class="picks-block">
      <div class="block-label">
        單場合集（獨贏 {{ lockedBPackage?.moneylineCount || 0 }} · 大小 {{ lockedBPackage?.totalsCount || 0 }}）
      </div>
      <table class="picks-table">
        <thead>
          <tr>
            <th>市場</th>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">賠率</th>
            <th class="num">模型</th>
            <th class="num">EV</th>
            <th class="num">注碼</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in packageSingles"
            :key="`${item.market}-${item.gameId}-${item.pick}`"
            :class="{ 'is-top': item.market === 'h2h' && item.rank === 1 }"
          >
            <td>{{ item.marketLabel || item.market }}</td>
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick">{{ item.pick || '—' }}</td>
            <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
            <td class="num">{{ percent(item.modelProbability) }}</td>
            <td class="num">{{ percent(item.expectedValue) }}</td>
            <td class="num">${{ item.stakeUsd || packageStake }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="starParlayTickets.length || parlaySecondary || starParlayBundle" class="picks-block parlay-block">
      <div class="block-label">
        獨贏 Star 串關（每票 ${{ parlayStake }} · 單場的一半）
        <span v-if="starParlayBundle?.moneylineLegCount" class="block-meta">
          · 今日可看獨贏 {{ starParlayBundle.moneylineLegCount }} 場
        </span>
      </div>
      <p class="package-note stake-guide">
        注碼：單場各 ${{ packageStake }}；下方每張串關 ${{ parlayStake }}（勿與單場同額）
      </p>
      <p v-if="starParlayBundle?.howToBet" class="hint">{{ starParlayBundle.howToBet }}</p>
      <p v-else-if="starParlayBundle?.rule" class="hint">{{ starParlayBundle.rule }}</p>

      <div
        v-for="(ticket, tIdx) in starParlayTickets"
        :key="ticket.id || `star-${tIdx}`"
        class="parlay-card star-ticket"
      >
        <div class="parlay-title">
          <span class="ticket-idx">票 {{ tIdx + 1 }}</span>
          {{ ticket.label }}
          <span class="ticket-stake">下 ${{ ticket.suggestedStakeUsd || parlayStake }}</span>
        </div>
        <p class="parlay-line">
          <template v-for="(leg, idx) in ticket.legs" :key="`${ticket.id}-${idx}`">
            <span v-if="idx"> × </span>
            <strong>R{{ leg.rank }}</strong>
            {{ leg.pick }}（{{ formatOdds(leg.oddsDecimal) }}）
            <span class="leg-matchup">{{ leg.matchup }}</span>
          </template>
        </p>
        <p class="parlay-combined">
          合計約 {{ formatOdds(ticket.combinedOdds) }}
          · {{ ticket.legCount }} 串 1
        </p>
      </div>

      <p v-if="!starParlayTickets.length" class="hint">
        {{ starParlayBundle?.reason || '可看獨贏不足 2，暫無 Star 串關' }}
      </p>
      <p class="hint forbid-note">禁止：四場獨贏長串（四串）。日 TopK 維持 3，不因串關升 4。</p>

      <div v-if="parlaySecondary?.available" class="parlay-card satellite-ticket">
        <div class="parlay-title">
          衛星混串（可選・分帳）：{{ parlaySecondary.label }}
          <span class="ticket-stake">下 ${{ parlaySecondary.suggestedStakeUsd || parlayStake }}</span>
        </div>
        <p class="parlay-line">
          <template v-for="(leg, idx) in parlaySecondary.legs" :key="`sat-${idx}`">
            <span v-if="idx"> × </span>
            {{ leg.pick }}（{{ formatOdds(leg.oddsDecimal) }}）
            <span class="leg-matchup">{{ leg.matchup }}</span>
          </template>
          · 合計約 {{ formatOdds(parlaySecondary.combinedOdds) }}
          <span v-if="parlaySecondary.sameGame"> · 同場</span>
        </p>
        <p class="hint">{{ parlaySecondary.rule }} · 不佔獨贏主倉</p>
      </div>
      <p v-else-if="parlaySecondary" class="hint">衛星混串：{{ parlaySecondary.reason }}</p>

      <p v-if="lockedBPackage?.parlays?.note" class="hint">{{ lockedBPackage.parlays.note }}</p>
    </div>

    <div v-if="dailyTop.length" class="picks-block">
      <div class="block-label">可看選邊（獨贏明細）</div>
      <table class="picks-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">賠率</th>
            <th class="num">模型</th>
            <th class="num">市場</th>
            <th class="num">EV</th>
            <th class="num">分差</th>
            <th class="num">資料</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in dailyTop" :key="item.gameId" :class="{ 'is-top': item.rank === 1 }">
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick">{{ item.pick || '—' }}</td>
            <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
            <td class="num">{{ percent(item.modelProbability) }}</td>
            <td class="num">{{ percent(item.marketProbability) }}</td>
            <td class="num">{{ percent(item.expectedValue) }}</td>
            <td class="num">{{ score(item.expectedRunMargin) }}</td>
            <td class="num data-ok">{{ item.dataScorePct ?? '—' }}%</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="!loading" class="picks-block empty-picks">
      <div class="block-label">可看選邊</div>
      <p class="hint">
        現在沒有可下選邊。
        <template v-if="heldUntilRelease.length">
          已有 {{ heldUntilRelease.length }} 場過鎖定 B 門檻，開賽前
          {{ releaseHoursBefore }} 小時才放出（嚴格防過早下注）。
        </template>
        <template v-else>
          今日場次已在；等關鍵資料齊、過門檻且進入放出時窗後會出現選邊。
        </template>
      </p>
    </div>

    <div v-if="heldUntilRelease.length" class="picks-block held-block">
      <div class="block-label">
        已過門檻・未放出（{{ heldUntilRelease.length }}）· 開賽前 {{ releaseHoursBefore }}h
      </div>
      <table class="picks-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">賠率</th>
            <th class="num">距開賽</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in heldUntilRelease" :key="`held-${item.gameId}`">
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick muted">—</td>
            <td class="num muted">—</td>
            <td class="num">約 {{ formatHoursUntil(item.hoursUntilCommence) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        故意不顯示選邊與賠率，避免過早下手。進入時窗後會出現在上方「可看選邊」。
      </p>
    </div>

    <div v-if="totalsHybridPicks.length" class="picks-block totals-sat primary-sat">
      <div class="block-label">
        大小分 Hybrid 衛星（主打 · 均注 ${{ totalsSatStake }}）
      </div>
      <table class="picks-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">盤口</th>
            <th class="num">賠率</th>
            <th class="num">EV</th>
            <th>路徑</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in totalsHybridPicks" :key="`tot-h-${item.gameId}`">
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick">{{ item.pick || '—' }}</td>
            <td class="num">{{ item.line ?? '—' }}</td>
            <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
            <td class="num">{{ percent(item.expectedValue) }}</td>
            <td class="path">{{ hybridPathLabel(item) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        與鎖定 B 分離；均注 ${{ totalsSatStake }}。Under=raw；Over=投手公園去偏。
        {{ totalsSatelliteHybrid?.note || '' }}
      </p>
    </div>

    <div
      v-if="!loading && !totalsHybridPicks.length && (dailyTop.length || (todayFunnel?.upcoming || 0) > 0)"
      class="picks-block totals-sat"
    >
      <div class="block-label">大小分 Hybrid 衛星</div>
      <p class="hint">今日無過閘可下 Hybrid（時窗內 + 資料齊）。不動獨贏規則。</p>
      <p v-if="totalsHybridHeld.length" class="hint">
        已過大小閘但未放出／缺先發 {{ totalsHybridHeld.length }} 場
        （例：{{ totalsHybridHeld[0].matchup }}
        <template v-if="totalsHybridHeld[0].holdReason === 'data_incomplete_pitchers'"> · 缺先發</template>
        <template v-else> · 約 {{ formatHoursUntil(totalsHybridHeld[0].hoursUntilCommence) }} 後進時窗</template>）。
      </p>
      <p v-if="totalsHybridBlockedNotable.length" class="hint">
        強訊號被硬閘：{{ totalsHybridBlockedNotable[0].matchup }}
        傾向{{ totalsHybridBlockedNotable[0].side === 'under' ? '小' : '大' }}
        {{ totalsHybridBlockedNotable[0].line }}
        · {{ (totalsHybridBlockedNotable[0].reasons || []).join('、') || '未過閘' }}。
        <template v-if="(totalsHybridBlockedNotable[0].reasons || []).includes('total_line_above_maximum')">
          （衛星盤口上限 {{ totalsHybridMaxLine }}，洛磯等高盤會擋）
        </template>
      </p>
    </div>

    <div v-if="totalsHybridHeld.length && totalsHybridPicks.length" class="picks-block held-block">
      <div class="block-label">大小分・已過閘未放出（{{ totalsHybridHeld.length }}）</div>
      <p class="hint">
        <template v-for="(item, idx) in totalsHybridHeld.slice(0, 4)" :key="item.gameId">
          <span v-if="idx">；</span>{{ item.matchup }}
          <template v-if="item.holdReason === 'data_incomplete_pitchers'">（缺先發）</template>
          <template v-else>（約 {{ formatHoursUntil(item.hoursUntilCommence) }}）</template>
        </template>
      </p>
    </div>

    <div v-if="totalsUnderOnlyPicks.length" class="picks-block totals-sat research-sat">
      <div class="block-label">大小分 Under 對照</div>
      <table class="picks-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">盤口</th>
            <th class="num">賠率</th>
            <th class="num">EV</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in totalsUnderOnlyPicks" :key="`tot-u-${item.gameId}`">
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick">{{ item.pick || '—' }}</td>
            <td class="num">{{ item.line ?? '—' }}</td>
            <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
            <td class="num">{{ percent(item.expectedValue) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ totalsSatelliteUnderOnly?.note || '' }}</p>
    </div>

    <div v-if="totalsSatellitePicks.length" class="picks-block totals-sat research-sat">
      <div class="block-label">大小分 both（對照研究）</div>
      <table class="picks-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th>對陣</th>
            <th>選邊</th>
            <th class="num">盤口</th>
            <th class="num">賠率</th>
            <th class="num">模型</th>
            <th class="num">市場</th>
            <th class="num">EV</th>
            <th class="num">|μ−線|</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in totalsSatellitePicks" :key="`tot-${item.gameId}`">
            <td class="col-rank">{{ item.rank }}</td>
            <td class="matchup">{{ item.matchup }}</td>
            <td class="pick">{{ item.pick || '—' }}</td>
            <td class="num">{{ item.line ?? '—' }}</td>
            <td class="num">{{ formatOdds(item.oddsDecimal) }}</td>
            <td class="num">{{ percent(item.modelProbability) }}</td>
            <td class="num">{{ percent(item.marketProbability) }}</td>
            <td class="num">{{ percent(item.expectedValue) }}</td>
            <td class="num">{{ score(item.absGap) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">寬線對照，非預設實投。{{ totalsSatellite?.note || '' }}</p>
    </div>

    <div v-if="!loading && !dailyTop.length && dataLag?.stale" class="empty-picks stale">
      <p class="empty-title">本機沒有今日場次</p>
      <p class="empty-body">
        資料已停更，最後快照
        {{ formatTime(dataLag?.lastCapturedAt) || '未知' }}。
        請點右上角「同步今日 MLB」拉取賽程與初盤。
      </p>
    </div>

    <div v-if="!loading && !dailyTop.length && !dataLag?.stale" class="empty-picks">
      <p class="empty-title">現在沒有可下選邊</p>
      <p class="empty-body">
        見下方：「分析完成・未入選」是已算完但被鎖定 B 排除；「資料未齊」是還沒辦法正式判斷。
      </p>
      <p v-if="todayFunnelText" class="empty-body funnel-line">{{ todayFunnelText }}</p>
    </div>

    <div v-if="!loading && todayFunnel && (dailyTop.length > 0 || todayFunnel.upcoming > 0)" class="funnel-strip">
      <span>今日場次 {{ todayFunnel.upcoming }}</span>
      <span>資料未齊 {{ todayFunnel.pendingData }}</span>
      <span>已分析 {{ todayFunnel.analyzedReady }}</span>
      <span>未放出 {{ todayFunnel.passedGatesHeld || heldUntilRelease.length }}</span>
      <span>可看選邊 {{ todayFunnel.selected }}</span>
      <span v-if="topFunnelReason">主因 {{ topFunnelReason }}</span>
      <span v-if="pitcherGapText">先發 {{ pitcherGapText }}</span>
    </div>

    <div v-if="analyzedExcluded.length" class="picks-block">
      <div class="block-label">分析完成・未入選（{{ analyzedExcluded.length }}）</div>
      <table class="picks-table">
        <thead>
          <tr>
            <th>開賽（港）</th>
            <th>對陣</th>
            <th class="num">資料</th>
            <th>結果</th>
            <th>未入選原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="game in analyzedExcluded" :key="`ex-${game.truthSnapshotId}`">
            <td class="time-cell">{{ formatTime(game.commenceTime) }}</td>
            <td class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</td>
            <td class="num data-ok">
              {{ game.dataReadiness?.scorePct ?? Math.round((game.completeness || 0) * 100) }}%
            </td>
            <td class="status-cell">{{ analyzedResultLabel(game) }}</td>
            <td class="missing">{{ exclusionReasonText(game) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">已完成模型分析；未過鎖定 B（EV／賠率／分差等）故不進可看選邊。</p>
    </div>

    <div v-if="pendingData.length" class="picks-block blocked">
      <div class="block-label">資料未齊・暫不入選（{{ pendingData.length }}）</div>
      <table class="picks-table">
        <thead>
          <tr>
            <th>開賽（港）</th>
            <th>對陣</th>
            <th class="num">資料</th>
            <th>還缺</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="game in pendingData" :key="`pend-${game.truthSnapshotId}`">
            <td class="time-cell">{{ formatTime(game.commenceTime) }}</td>
            <td class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</td>
            <td class="num data-bad">
              {{ game.dataReadiness?.scorePct ?? Math.round((game.completeness || 0) * 100) }}%
            </td>
            <td class="missing">{{ missingCriticalText(game.dataReadiness?.missingCritical) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">關鍵資料未齊，不做正式入選判斷；齊了之後會進上面兩類之一。</p>
    </div>

    <details class="meta-fold" v-if="upcomingGames.length">
      <summary>展開資料清單</summary>
      <article v-for="game in upcomingGames" :key="`detail-${game.truthSnapshotId}`" class="game-card">
        <header class="game-head">
          <div>
            <div class="matchup">{{ game.awayTeam }} @ {{ game.homeTeam }}</div>
            <div class="time">{{ formatTime(game.commenceTime) }}</div>
          </div>
          <div class="status-plain">
            <span :class="game.dataReadiness?.recommendationAllowed ? 'data-ok' : 'data-bad'">
              {{ bucketLabel(game) }}
              ·
              {{ game.dataReadiness?.scorePct ?? Math.round((game.completeness || 0) * 100) }}%
            </span>
          </div>
        </header>

        <ul class="evidence-list">
          <li
            v-for="item in readinessChecklist(game)"
            :key="item.key"
            :class="{
              critical: item.blockRecommend,
              ok: item.ok,
              soft: !item.ok && item.softOk,
              bad: !item.softOk,
            }"
          >
            <span class="ev-weight">w{{ item.weight }}</span>
            <span class="ev-state">{{ item.statusLabel || stateSymbol(item.status) }}</span>
            <span>
              <strong v-if="item.blockRecommend">[關鍵]</strong>
              {{ item.label || labelFor(item.key) }}
              <span v-if="item.summary" class="ev-summary">— {{ item.summary }}</span>
            </span>
          </li>
        </ul>
      </article>
    </details>

    <el-empty
      v-if="!loading && !games.length"
      description="尚無 MLB 賽前快照。點右上角重新載入；若仍空，需後端先同步今日賽程。"
    />
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { getMlbPrematchTruth } from '../api/index.js';

const loading = ref(false);
const truth = ref(null);

const games = computed(() => truth.value?.games || []);
const dailyTop = computed(() => truth.value?.expectedRunsTop || []);
const heldUntilRelease = computed(() => truth.value?.heldUntilRelease || []);
const releaseHoursBefore = computed(
  () => truth.value?.releasePolicy?.hoursBefore ?? 8
);
const dataLag = computed(() => truth.value?.dataLag || null);
const sameDayParlay = computed(() => truth.value?.sameDayParlay || null);
const totalsSatellite = computed(() => truth.value?.totalsSatellite || null);
const totalsSatellitePicks = computed(() => totalsSatellite.value?.picks || []);
const totalsSatelliteUnderOnly = computed(() => truth.value?.totalsSatelliteUnderOnly || null);
const totalsUnderOnlyPicks = computed(() => totalsSatelliteUnderOnly.value?.picks || []);
const totalsSatelliteHybrid = computed(() => truth.value?.totalsSatelliteHybrid || null);
const totalsHybridPicks = computed(() => totalsSatelliteHybrid.value?.picks || []);
const totalsHybridHeld = computed(() => totalsSatelliteHybrid.value?.held || []);
const totalsHybridBlockedNotable = computed(
  () => totalsSatelliteHybrid.value?.blockedNotable || []
);
const totalsHybridMaxLine = computed(
  () => Number(totalsSatelliteHybrid.value?.maxTotalLine) || 10
);
const totalsSatStake = computed(
  () =>
    Number(totalsSatelliteHybrid.value?.suggestedStakeUsd) ||
    Number(totalsSatelliteUnderOnly.value?.suggestedStakeUsd) ||
    50
);
const lockedBPackage = computed(() => truth.value?.lockedBPackage || null);
const packageSingles = computed(() => lockedBPackage.value?.singles || []);
const packageStake = computed(
  () => Number(lockedBPackage.value?.flatStakeUsd) || totalsSatStake.value || 50
);
const parlayStake = computed(
  () =>
    Number(lockedBPackage.value?.parlayStakeUsd) ||
    Number(starParlayBundle.value?.suggestedStakeUsd) ||
    Math.round(packageStake.value / 2) ||
    25
);
const starParlayBundle = computed(
  () => lockedBPackage.value?.parlays?.star || null
);
const starParlayTickets = computed(
  () =>
    lockedBPackage.value?.parlays?.tickets ||
    lockedBPackage.value?.parlays?.star?.tickets ||
    []
);
const parlayPrimary = computed(() => lockedBPackage.value?.parlays?.primary || sameDayParlay.value);
const parlaySecondary = computed(() => lockedBPackage.value?.parlays?.secondary || null);
const stakeGuideText = computed(() => {
  const g = lockedBPackage.value?.stakeGuide;
  if (g?.text) return `注碼紀律：${g.text}（串關 = 單場 ÷ 2）`;
  return `注碼紀律：單場 $${packageStake.value} → 串關 $${parlayStake.value}`;
});

function hybridPathLabel(item) {
  if (item?.hybridPath === 'raw_under') return 'Under·raw';
  if (item?.hybridPath === 'pitcher_debiased_over') return 'Over·投手去偏';
  if (item?.hybridPath === 'raw_over') return 'Over·raw';
  return item?.side === 'under' ? 'Under' : item?.side === 'over' ? 'Over' : '—';
}
const todayFunnel = computed(() => truth.value?.todayFunnel || null);
const highEvShrink = computed(() => truth.value?.highEvShrinkShadow || null);
const highEvShrinkApply = computed(() => Boolean(highEvShrink.value?.appliesToVisiblePicks));
const highEvShrinkNote = computed(() => {
  const s = highEvShrink.value;
  if (!s?.enabled && s?.mode === 'off') return null;
  if (!s?.mode || s.mode === 'off') return null;
  const diff = s.diff;
  const deltaBits =
    diff && !diff.sameSlots
      ? ` · 對照差：+${(diff.added || []).length}/−${(diff.dropped || []).length} 場`
      : diff?.sameSlots
        ? ' · 今日與正式名額相同'
        : '';
  const obs = s.observation?.status ? ` · 觀察：${s.observation.status}` : '';
  if (s.mode === 'apply') {
    return `影子 overlay shrink_w15_l15 已套用至可看選邊（非升格常數）${obs}`;
  }
  return `影子 overlay shrink_w15_l15 對照中（正式選邊不變）${deltaBits}${obs}`;
});

const selectedIds = computed(() => new Set(dailyTop.value.map((row) => row.gameId)));
const heldIds = computed(() => new Set(heldUntilRelease.value.map((row) => row.gameId)));

const upcomingGames = computed(() =>
  [...games.value].sort((a, b) =>
    String(a.commenceTime || '').localeCompare(String(b.commenceTime || ''))
  )
);

/** 關鍵資料未齊：尚未做正式入選判斷 */
const pendingData = computed(() =>
  upcomingGames.value.filter((game) => !game.dataReadiness?.recommendationAllowed)
);

/**
 * 分析完成但未入選：資料齊、已有分類結果，且不在可看選邊。
 * （含嚴格擋下與 value_watch 觀察級）
 */
const analyzedExcluded = computed(() =>
  upcomingGames.value.filter((game) => {
    if (!game.dataReadiness?.recommendationAllowed) return false;
    if (selectedIds.value.has(game.gameId)) return false;
    if (heldIds.value.has(game.gameId)) return false;
    return Boolean(game.expectedRuns?.moneylineClassification) || Boolean(game.research?.status);
  })
);

const labels = {
  fixture: '官方賽程匹配',
  odds: '初盤雙邊賠率',
  venue: '球場名稱',
  starting_pitchers: '雙方預定先發',
  official_history: '官方戰績特徵',
  model_history: '模型同口徑歷史',
  bullpen: '牛棚負荷',
  lineup: '確認打線',
  injuries: '傷停名單',
  pitcher_injury_intel: '先發傷病情報',
  park: '球場係數',
  weather: '天氣',
  travel_rest: '旅行／休息',
};

const reasonLabels = {
  expected_value_below_threshold: 'EV 不足',
  expected_run_margin_below_threshold: '分差不足',
  model_probability_below_threshold: '模型勝率不足',
  pick_odds_below_minimum: '賠率低於下限',
  pick_odds_above_maximum: '賠率高於上限',
  pick_early_exits_higher_than_opponent: '選邊先發早退偏多',
  moneyline_either_side_odds_too_short: '任一邊賠率過低',
  h2h_bookmakers_below_minimum: '開盤 book 數不足',
  feature_out_of_distribution: '特徵超出訓練分佈',
  pitcher_identity_incomplete: '先發身份不完整',
  strict_pit_starter_required: '先發 PIT 身份未齊',
  regime_routes_to_totals: '路線改走大小球',
  both_stable_starters_prefer_totals_under: '雙穩先發偏 unders',
  abs_gap_below_threshold: '總分差不足',
  edge_vs_market_below_threshold: '相對市場優勢不足',
  mean_prob_disagree: '均值與機率方向不一致',
  totals_market_missing: '缺大小分盤口',
  totals_prediction_missing: '缺總分預測',
  total_line_above_maximum: '大小分盤口過高',
  regime_totals_primary_moneyline_secondary: '獨贏為次優先',
  one_sided_collapse_risk_no_auto_totals_lean: '單邊崩盤風險',
};

const funnelReasonLabels = {
  ...reasonLabels,
  starting_pitchers: '雙方預定先發未齊',
  odds: '初盤未齊',
  fixture: '賽程未齊',
  model_history: '模型歷史未齊',
  data_incomplete: '資料未齊',
  locked_b_excluded: '未過鎖定 B',
  baseline_market_gap_below_threshold: '相對市場優勢不足',
  paper_entry_window_not_due: '尚未到可建帳時點',
};

const topFunnelReason = computed(() => {
  const top = todayFunnel.value?.topReasons?.[0];
  if (!top) return '';
  return `${funnelReasonLabels[top.reason] || top.reason}×${top.n}`;
});

const todayFunnelText = computed(() => {
  if (!todayFunnel.value?.upcoming) return '';
  const held = todayFunnel.value.passedGatesHeld || heldUntilRelease.value.length || 0;
  const passedTotal =
    todayFunnel.value.passedGatesTotal ??
    todayFunnel.value.selected + held;
  const parts = [
    `今日共 ${todayFunnel.value.upcoming} 場`,
    `資料未齊 ${todayFunnel.value.pendingData}`,
    `已分析未入選約 ${Math.max(0, todayFunnel.value.analyzedReady - passedTotal)}`,
  ];
  if (held > 0) parts.push(`過門檻未放出 ${held}`);
  parts.push(`可看選邊 ${todayFunnel.value.selected}`);
  if (topFunnelReason.value) parts.push(`最常見卡點：${topFunnelReason.value}`);
  return parts.join(' · ');
});

const pitcherGapText = computed(() => {
  const g = todayFunnel.value?.pitcherGap;
  if (!g) return '';
  const bits = [];
  if (g.missingCritical) bits.push(`缺先發閘 ${g.missingCritical}`);
  if (g.conflictingIl) bits.push(`IL衝突 ${g.conflictingIl}`);
  if (g.identityIncomplete) bits.push(`身份不完整 ${g.identityIncomplete}`);
  if (g.strictPitFallback) bits.push(`非嚴格PIT ${g.strictPitFallback}`);
  if (g.preferredCompleteOverPartial) bits.push(`保留完整快照 ${g.preferredCompleteOverPartial}`);
  return bits.join(' · ');
});

/** 入選判斷用的主因（略過僅附註的 regime 次要標籤） */
const PRIMARY_EXCLUDE_REASONS = new Set([
  'expected_value_below_threshold',
  'expected_run_margin_below_threshold',
  'model_probability_below_threshold',
  'pick_odds_below_minimum',
  'pick_odds_above_maximum',
  'pick_early_exits_higher_than_opponent',
  'moneyline_either_side_odds_too_short',
  'h2h_bookmakers_below_minimum',
  'feature_out_of_distribution',
  'pitcher_identity_incomplete',
  'strict_pit_starter_required',
  'regime_routes_to_totals',
  'both_stable_starters_prefer_totals_under',
]);

function labelFor(key) {
  return labels[key] || key;
}

function stateSymbol(state) {
  if (state === 'verified') return '齊';
  if (state === 'partial') return '部分';
  return '缺';
}

function missingCriticalText(list = []) {
  if (!list?.length) return '—';
  return list.map((row) => row.label || labelFor(row.key)).join('、');
}

function readinessChecklist(game) {
  if (game.dataReadiness?.checklist?.length) {
    return game.dataReadiness.checklist;
  }
  return (game.evidence || []).map((item) => ({
    key: item.key,
    label: labelFor(item.key),
    weight: '—',
    status: item.status,
    statusLabel: stateSymbol(item.status),
    summary: item.summary,
    blockRecommend: ['odds', 'starting_pitchers', 'fixture', 'model_history'].includes(item.key),
    ok: item.status === 'verified',
    softOk: item.status === 'verified' || item.status === 'partial',
  }));
}

function analyzedResultLabel(game) {
  const tier = game.expectedRuns?.moneylineClassification?.tier || game.researchTier;
  if (tier === 'value_watch') return '觀察級（未嚴格入選）';
  return '已分析・排除';
}

function exclusionReasonText(game) {
  const reasons =
    game.expectedRuns?.moneylineClassification?.reasons ||
    game.research?.rejectionReasons ||
    [];
  const primary = reasons.filter((r) => PRIMARY_EXCLUDE_REASONS.has(r));
  const use = primary.length ? primary : reasons.slice(0, 2);
  if (!use.length) return '未過鎖定 B 綜合門檻';
  return use.map((r) => reasonLabels[r] || r).join('、');
}

function bucketLabel(game) {
  if (selectedIds.value.has(game.gameId)) return '已入選';
  if (heldIds.value.has(game.gameId)) return '過門檻・未到放出時窗';
  if (!game.dataReadiness?.recommendationAllowed) return '資料未齊';
  return '已分析未入選';
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
}

function formatOdds(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function formatHoursUntil(value) {
  const h = Number(value);
  if (!Number.isFinite(h)) return '—';
  if (h >= 10) return `${Math.round(h)}h`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.max(0, Math.round(h * 60))}m`;
}

function score(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function loadTruth() {
  loading.value = true;
  try {
    const result = await getMlbPrematchTruth({
      from: new Date().toISOString(),
    });
    truth.value = result.data || null;
  } finally {
    loading.value = false;
  }
}

defineExpose({ loadTruth });
</script>

<style scoped>
.truth-panel {
  display: grid;
  gap: 16px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #111;
}

.panel-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: #666;
}

.shadow-overlay-note {
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: #444;
  border-left: 3px solid #888;
  background: #f7f7f7;
}

.shadow-overlay-note.apply {
  border-left-color: #333;
  background: #f0f0f0;
  font-weight: 500;
}

.picks-block {
  border: 1px solid #ddd;
  background: #fff;
}

.picks-block.blocked {
  border-color: #bbb;
  background: #fafafa;
}

.picks-block.held-block {
  border-color: #c4c4c4;
  background: #f7f7f7;
}

.picks-block.empty-picks .hint {
  padding: 12px;
  margin: 0;
}

.pick.muted,
.num.muted {
  color: #999;
}

.block-label {
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  font-size: 12px;
  font-weight: 600;
  color: #333;
}

.picks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.picks-table th,
.picks-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  text-align: left;
  vertical-align: middle;
}

.picks-table th {
  font-size: 11px;
  font-weight: 600;
  color: #666;
  background: #fafafa;
}

.picks-table tbody tr:last-child td {
  border-bottom: none;
}

.picks-table tr.is-top td {
  background: #f7f7f7;
  font-weight: 500;
}

.col-rank {
  width: 36px;
  color: #666;
  font-variant-numeric: tabular-nums;
}

.num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.matchup {
  font-weight: 500;
  color: #111;
}

.pick {
  font-weight: 600;
  color: #111;
}

.missing,
.status-cell {
  color: #555;
  font-size: 12px;
}

.time-cell {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.data-ok {
  color: #1a1a1a;
  font-weight: 600;
}

.data-bad {
  color: #888;
  font-weight: 600;
}

.hint {
  margin: 0;
  padding: 8px 12px;
  font-size: 11px;
  color: #777;
  border-top: 1px solid #eee;
}

.package-note {
  margin: 0 0 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #444;
  background: #f7f7f5;
  border: 1px solid #e8e8e4;
}

.package-note.stake-guide {
  background: #eef6f1;
  border-color: #c5e0d0;
  color: #0b6e4f;
  font-weight: 600;
}

.parlay-block .parlay-card {
  padding: 10px 12px;
  border-top: 1px solid #eee;
}

.parlay-block .star-ticket {
  background: #fafaf8;
  margin-bottom: 6px;
  border: 1px solid #ebebe6;
  border-radius: 4px;
  border-top: 1px solid #ebebe6;
}

.parlay-block .satellite-ticket {
  margin-top: 10px;
  background: #f5f7fa;
  border: 1px dashed #c5cdd8;
  border-radius: 4px;
}

.parlay-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ticket-idx {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  background: #2c3e50;
  color: #fff;
  border-radius: 3px;
}

.ticket-stake {
  margin-left: auto;
  font-size: 12px;
  color: #0b6e4f;
  font-weight: 700;
}

.leg-matchup {
  font-size: 11px;
  color: #888;
  font-weight: 400;
}

.parlay-combined {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: #1a1a1a;
}

.forbid-note {
  color: #8a4b08 !important;
}

.block-meta {
  font-weight: 400;
  color: #777;
  font-size: 12px;
}

.parlay-hint {
  border-top: 1px solid #eee;
  background: #fafafa;
}

.parlay-hint .block-label {
  border-bottom: none;
  padding-bottom: 0;
}

.parlay-line {
  margin: 0;
  padding: 4px 12px 0;
  font-size: 13px;
  color: #222;
}

.funnel-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 8px 12px;
  font-size: 12px;
  color: #555;
  border: 1px solid #e8e8e8;
  background: #fcfcfc;
}

.funnel-line {
  margin-top: 8px;
}

.empty-picks {
  padding: 20px 16px;
  border: 1px dashed #ccc;
  background: #fff;
  text-align: center;
}

.empty-picks.stale {
  border-color: #999;
  background: #fafafa;
}

.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #222;
}

.empty-body {
  margin: 8px 0 0;
  font-size: 13px;
  color: #666;
  line-height: 1.5;
}

.meta-fold {
  border: 1px solid #e5e5e5;
  padding: 8px 12px;
  background: #fff;
}

.meta-fold > summary {
  cursor: pointer;
  font-size: 12px;
  color: #555;
  font-weight: 600;
}

.game-card {
  margin-top: 12px;
  padding: 12px 0;
  border-top: 1px solid #eee;
}

.game-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 8px;
}

.time {
  font-size: 12px;
  color: #777;
  margin-top: 2px;
}

.status-plain {
  font-size: 12px;
  color: #555;
  white-space: nowrap;
}

.evidence-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.evidence-list li {
  display: grid;
  grid-template-columns: 42px 36px 1fr;
  gap: 8px;
  align-items: start;
  font-size: 12px;
  color: #444;
  padding: 4px 0;
  border-bottom: 1px solid #f0f0f0;
}

.evidence-list li.critical.bad {
  background: #f5f5f5;
}

.evidence-list li.ok .ev-state {
  color: #111;
  font-weight: 600;
}

.evidence-list li.bad .ev-state {
  color: #888;
}

.ev-weight {
  font-variant-numeric: tabular-nums;
  color: #888;
  font-size: 11px;
}

.ev-state {
  font-size: 11px;
}

.ev-summary {
  color: #777;
  font-weight: 400;
}
</style>
