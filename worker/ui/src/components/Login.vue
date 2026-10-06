<script setup lang="ts">
import { loginURL, sessionError, startSession } from "../session";
</script>

<template>
  <section class="access-login" aria-labelledby="login-title">
    <div class="panel login-card">
      <span class="login-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5c0 4.8 3.1 8.3 7.5 10 4.4-1.7 7.5-5.2 7.5-10V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg></span>
      <h1 id="login-title">登录 SpiderWatch</h1>
      <p>使用 GitHub 账户登录。</p>
      <a class="button login-button" :href="loginURL">使用 GitHub 登录 <span aria-hidden="true">→</span></a>
      <p v-if="sessionError" role="alert">{{ sessionError }}</p><button class="button-quiet small" @click="startSession">重试</button>
    </div>
  </section>
</template>

<style scoped>
.access-login{display:grid;place-items:center;min-height:calc(100dvh - 120px);padding:32px 0}
.login-card{width:min(100%,400px);padding:36px;text-align:center;margin:0}
.login-symbol{display:grid;place-items:center;margin:0 auto 24px;width:52px;height:52px;background:var(--panel-soft);border:1px solid var(--line);border-radius:14px;color:var(--muted)}
.login-symbol svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:24px;letter-spacing:-.5px}p{font-size:13px;color:var(--muted);margin:12px 0 28px}
.login-button{width:100%;min-height:44px;justify-content:space-between;padding:10px 16px}
small{margin-top:18px;font-size:11px}
@media(max-width:480px){.login-card{padding:28px 22px}}
</style>
