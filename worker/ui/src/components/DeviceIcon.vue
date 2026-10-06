<script setup lang="ts">
import { computed } from "vue";
import { getDeviceIcon } from "../../../public/device-icons.js";
const props = defineProps<{ name?: string }>();
const icon = computed(() => getDeviceIcon(props.name));
</script>

<template>
  <svg class="device-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path v-for="(path, index) in icon.paths" :key="index" :d="path" /></svg>
</template>
