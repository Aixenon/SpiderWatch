<script setup lang="ts">
import { loginURL } from "../session";
import { GITHUB_MARK_PATH } from "../../../src/github-mark";
</script>

<template>
  <section class="access-login" aria-label="登录 SpiderWatch">
    <a class="github-login" :href="loginURL"><svg viewBox="0 0 16 16" aria-hidden="true"><path :d="GITHUB_MARK_PATH" /></svg><span>使用 GitHub 登录</span></a>
  </section>
</template>

<style scoped>
.access-login{display:grid;place-items:center;min-height:calc(100dvh - 88px);padding:32px 0}
.github-login{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:44px;min-width:240px;max-width:100%;padding:10px 24px;border:1px solid transparent;border-radius:8px;background:#24292f;color:#fff;font-size:14px;line-height:22px;font-weight:600;transition:background .15s}
.github-login svg{width:20px;height:20px;fill:currentColor;flex-shrink:0}
.github-login:hover{background:#343b43}
:root[data-theme=dark] .github-login{background:#f0f3f6;color:#24292f}
:root[data-theme=dark] .github-login:hover{background:#dce3eb}
</style>
