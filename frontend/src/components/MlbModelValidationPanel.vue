<template>
  <section v-if="report" class="validation-card">
    <header>
      <strong>模型驗證狀態</strong>
      <el-tag :type="decision.eligible ? 'success' : 'danger'" size="small">
        {{ decision.eligible ? '通過研究驗收' : '禁止部署' }}
      </el-tag>
    </header>

    <div class="metrics">
      <span>Final test n={{ summary.finalTest?.raw?.samples || 0 }}</span>
      <span>模型 Brier {{ number(summary.finalTest?.raw?.brier) }}</span>
      <span>PIT 市場 Brier {{ number(summary.pitComparison?.market?.brier) }}</span>
      <span>模型 LogLoss {{ number(summary.finalTest?.raw?.logLoss) }}</span>
      <span>PIT 市場 LogLoss {{ number(summary.pitComparison?.market?.logLoss) }}</span>
      <span>Rolling folds {{ decision.rollingFoldsBeatingMarket || 0 }}/{{ decision.rollingFoldsTotal || 0 }} 勝過市場</span>
    </div>

    <p v-if="!decision.eligible">
      封鎖原因：{{ decision.blockReasons?.map(reasonLabel).join('、') || '尚未通過驗證' }}
    </p>
    <small>{{ summary.warning }}</small>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { getMlbModelValidation } from '../api/index.js';

const report = ref(null);
const summary = computed(() => report.value?.summary || {});
const decision = computed(() => summary.value.deploymentDecision || {});

const labels = {
  raw_model_does_not_beat_pit_market: '模型未勝過同批 PIT 市場',
  calibration_did_not_generalize: '校準未在 final test 泛化',
  rolling_fold_stability_insufficient: 'rolling folds 穩定性不足',
  cross_season_validation_unavailable: '尚無跨季驗證資料',
};

function reasonLabel(reason) {
  return labels[reason] || reason;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '—';
}

async function loadValidation() {
  const result = await getMlbModelValidation();
  report.value = result.data || null;
}

onMounted(loadValidation);
defineExpose({ loadValidation });
</script>

<style scoped>
.validation-card { display: grid; gap: 8px; padding: 12px; border: 1px solid #ffccc7; border-radius: 8px; background: #fff; }
header, .metrics { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
header { justify-content: space-between; }
.metrics, p, small { color: #4e5969; font-size: 12px; }
p { margin: 0; color: #cf1322; }
</style>
