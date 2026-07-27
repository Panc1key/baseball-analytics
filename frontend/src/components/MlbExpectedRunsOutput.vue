<template>
  <div class="model-output">
    <span class="output-label">預期得分（{{ expectedRuns.modelVersion }}）</span>
    <span>客 {{ number(prediction.awayExpectedRuns) }}</span>
    <span>主 {{ number(prediction.homeExpectedRuns) }}</span>
    <span>總分 {{ number(prediction.expectedTotal) }}</span>
    <span>主市場 {{ primaryMarketLabel }}</span>
    <span v-if="totalsLeanLabel">大小傾向 {{ totalsLeanLabel }}</span>
    <span>主勝 {{ percent(prediction.markets?.homeWinProbability) }}</span>
    <span>獨贏分級 {{ classificationLabel(expectedRuns.moneylineClassification?.tier) }}</span>
    <span>最大偏離 {{ number(prediction.dataQuality?.maximumAbsoluteZScore) }}σ</span>
    <span>
      主隊貢獻：進攻 {{ signedImpact(homeGroups.offense?.runImpact) }}
      ／對手近期失分 {{ signedImpact(homeGroups.opponentRunPrevention?.runImpact) }}
      ／對手先發 {{ signedImpact(homeGroups.opponentStarter?.runImpact) }}
      ／對手牛棚 {{ signedImpact(homeGroups.opponentBullpen?.runImpact) }}
    </span>
    <span>
      客隊貢獻：進攻 {{ signedImpact(awayGroups.offense?.runImpact) }}
      ／對手近期失分 {{ signedImpact(awayGroups.opponentRunPrevention?.runImpact) }}
      ／對手先發 {{ signedImpact(awayGroups.opponentStarter?.runImpact) }}
      ／對手牛棚 {{ signedImpact(awayGroups.opponentBullpen?.runImpact) }}
    </span>
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
const marketPlan = computed(() =>
  props.expectedRuns.marketPlan || prediction.value.marketPlan || null
);
const homeGroups = computed(() => prediction.value.explanation?.home?.groups || {});
const awayGroups = computed(() => prediction.value.explanation?.away?.groups || {});

const primaryMarketLabel = computed(() => {
  const plan = marketPlan.value;
  if (!plan) return '—';
  if (plan.primaryMarket === 'totals') return '大小球';
  if (plan.primaryMarket === 'moneyline') return '獨贏';
  if (plan.primaryMarket === 'margin') return '分差觀察';
  return plan.primaryMarket;
});

const totalsLeanLabel = computed(() => {
  const lean = marketPlan.value?.totalsLean
    || props.expectedRuns.totalsDecision?.lean
    || prediction.value.totalsDecision?.lean;
  if (lean === 'under') return '小';
  if (lean === 'over') return '大';
  return '';
});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
}

function signedImpact(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const impact = Number(value);
  return `${impact >= 0 ? '+' : ''}${impact.toFixed(2)}`;
}

function classificationLabel(tier) {
  if (tier === 'recommendation') return '嚴格方向';
  if (tier === 'value_watch') return '高賠價值觀察';
  return '不列入';
}
</script>

<style scoped>
.model-output {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #f0f0f0;
  font-size: 12px;
  color: #4e5969;
}
.output-label { color: #86909c; }
</style>
