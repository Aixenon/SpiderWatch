import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import "./style.css";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("./views/Overview.vue") },
    { path: "/server/:id", component: () => import("./views/ServerDetail.vue") },
    { path: "/admin", component: () => import("./views/Admin.vue") },
    { path: "/settings", component: () => import("./views/Settings.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(to => {
  if (to.path !== "/admin" || !Object.hasOwn(to.query, "tab")) return;
  if (to.query.tab === "settings" || to.query.tab === "usage") return { path: "/settings", replace: true };
  const { tab: _tab, ...query } = to.query;
  return { path: "/admin", query, replace: true };
});

createApp(App).use(router).mount("#app");
