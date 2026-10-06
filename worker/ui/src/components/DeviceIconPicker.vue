<script setup lang="ts">
import { DEVICE_ICONS, type DeviceIconID } from "../../../public/device-icons.js";
import DeviceIcon from "./DeviceIcon.vue";
defineProps<{ modelValue: string }>();
defineEmits<{ "update:modelValue": [value: DeviceIconID] }>();
</script>

<template>
  <fieldset class="device-icon-picker"><legend>设备图标</legend><div class="device-icon-grid"><button v-for="icon in DEVICE_ICONS" :key="icon.id" type="button" class="secondary icon-choice" :aria-label="`图标：${icon.label}`" :aria-pressed="modelValue === icon.id" @click="$emit('update:modelValue', icon.id)"><DeviceIcon :name="icon.id" /><span>{{ icon.label }}</span></button></div></fieldset>
</template>
