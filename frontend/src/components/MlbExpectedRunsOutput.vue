<template>
  <div class="er-output">
    <div class="er-line">
      <span class="k">預期得分</span>
      <span>客 {{ number(prediction.awayExpectedRuns) }}</span>
      <span>主 {{ number(prediction.homeExpectedRuns) }}</span>
      <span>總 {{ number(prediction.expectedTotal) }}</span>
      <span>主勝 {{ percent(prediction.markets?.homeWinProbability) }}</span>
      <span>{{ classificationLabel(expectedRuns.moneylineClassification?.tier) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  expectedRuns: {
    type: Object,
    required: true,
  },
});

const prediction = computed(() => props.expectedRuns.prediction || {});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function percent(value) {
  return Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%`
    : '—';
}

function classificationLabel(tier) {
  if (tier === 'recommendation') return '嚴格方向';
  if (tier === 'value_watch') return '觀察';
  return '不列入';
}
</script>

<style scoped>
.er-output {
  margin-top: 8px;
  font-size: 12px;
  color: #555;
}
.er-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.k {
  color: #888;
}
</style>
