<template>
  <section v-if="report" class="score-card">
    <header>
      <strong>預期得分模型 v1</strong>
      <el-tag :type="decision.eligible ? 'success' : 'danger'" size="small">
        {{ decision.eligible ? '通過市場外測' : '研究中・禁止推薦' }}
      </el-tag>
    </header>

    <div class="metrics">
      <span>2026 n={{ effectiveFinal.samples || 0 }}</span>
      <span>總分 MAE {{ number(effectiveFinal.totalRunsMae, 2) }}</span>
      <span>單隊 RMSE {{ number(effectiveFinal.sideRunsRmse, 2) }}</span>
      <span>獨贏 Brier {{ number(effectiveFinal.pitModelMoneyline?.brier) }}</span>
      <span>獨贏市場 {{ number(effectiveFinal.pitMarketMoneyline?.brier) }}</span>
      <span>大小 Brier {{ number(effectiveFinal.totals?.brier) }}</span>
      <span>大小市場 {{ number(effectiveFinal.pitMarketTotals?.brier) }}</span>
      <span>
        正EV ROI {{ percent(effectiveFinal.moneylineBetDiagnostics?.positiveEv?.roi) }}
        (n={{ effectiveFinal.moneylineBetDiagnostics?.positiveEv?.samples || 0 }})
      </span>
      <span>歷史先發 PIT {{ percent(summary.starterIdentityCoverage?.finalObserved?.rate) }}</span>
    </div>

    <p v-if="!decision.eligible">
      封鎖原因：{{ decision.blockReasons?.map(reasonLabel).join('、') }}
    </p>
    <small>{{ summary.warning }}</small>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { getMlbExpectedRunsValidation } from '../api/index.js';

const report = ref(null);
const summary = computed(() => report.value?.summary || {});
const effectiveFinal = computed(() =>
  summary.value.routedFinalObserved || summary.value.finalTest || {}
);
const decision = computed(() => summary.value.deploymentDecision || {});

const labels = {
  final_test_reused_for_feature_repair: '2026已用於特徵修復，不是全新外測',
  historical_starter_identity_not_pit_replayable: '歷史先發身份不是賽前快照',
  score_model_does_not_beat_moneyline_market: '獨贏概率未勝過市場',
  score_model_does_not_beat_totals_market: '大小球概率未勝過市場',
};

function reasonLabel(reason) {
  return labels[reason] || reason;
}

function number(value, digits = 4) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
}

async function loadValidation() {
  const result = await getMlbExpectedRunsValidation();
  report.value = result.data || null;
}

onMounted(loadValidation);
defineExpose({ loadValidation });
</script>

<style scoped>
.score-card { display: grid; gap: 8px; padding: 12px; border: 1px solid #ffd591; border-radius: 8px; background: #fff; }
header, .metrics { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
header { justify-content: space-between; }
.metrics, p, small { color: #4e5969; font-size: 12px; }
p { margin: 0; color: #cf1322; }
</style>
