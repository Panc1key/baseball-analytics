<template>
  <NpbPrematchPanel ref="npbRef" />
</template>

<script setup>
import { ref } from 'vue';
import NpbPrematchPanel from './NpbPrematchPanel.vue';

const npbRef = ref(null);

async function reload() {
  await npbRef.value?.reload?.();
}

defineExpose({ reload });
</script>
