<script setup lang="ts">
import { loginURL } from "../session";
import { GITHUB_MARK_PATH } from "../../../src/github-mark";
</script>

<template>
  <section class="access-login" aria-labelledby="login-title">
    <div class="panel login-card">
      <span class="login-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5c0 4.8 3.1 8.3 7.5 10 4.4-1.7 7.5-5.2 7.5-10V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg></span>
      <h1 id="login-title">SpiderWatch</h1>
      <a class="github-login" :href="loginURL"><svg viewBox="0 0 16 16" aria-hidden="true"><path :d="GITHUB_MARK_PATH" /></svg><span>使用 GitHub 登录</span></a>
    </div>
  </section>
</template>

<style scoped>
.access-login{display:grid;place-items:center;min-height:calc(100dvh - 120px);padding:32px 0}
.login-card{width:min(100%,400px);padding:36px;text-align:center;margin:0}
.login-symbol{display:grid;place-items:center;margin:0 auto 24px;width:52px;height:52px;background:var(--panel-soft);border:1px solid var(--line);border-radius:14px;color:var(--muted)}
.login-symbol svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:24px;letter-spacing:-.5px;margin:0 0 28px}
.github-login{display:flex;align-items:center;justify-content:center;gap:10px;min-height:44px;width:100%;padding:10px 16px;border:1px solid transparent;border-radius:8px;background:#24292f;color:#fff;font-size:14px;line-height:22px;font-weight:600;transition:background .15s}
.github-login svg{width:20px;height:20px;fill:currentColor;flex-shrink:0}
.github-login:hover{background:#343b43}
:root[data-theme=dark] .github-login{background:#f0f3f6;color:#24292f}
:root[data-theme=dark] .github-login:hover{background:#dce3eb}
@media(max-width:480px){.login-card{padding:28px 22px}}
</style>
