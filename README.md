# SpiderWatch

使用cloudflare Workers + DO 功能实现服务器等终端设备的性能监控面板。
## 食用方法
1. Cloudflare Workers导入仓库：根目录`/`，构建留空，部署`npm run deploy`，预览`npm run preview`。
2. 为Worker绑定自定义域名。
3. 创建GitHub OAuth应用，回调填`https://域名/panel/auth/github/callback`。访问面板，按提示填写登录变量并保存部署。
