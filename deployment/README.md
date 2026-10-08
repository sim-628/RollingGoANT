# ANT Sites 部署

## 当前状态（2026-10-08）

接手 GitHub main，原始提交 `dac9e773182605360190bf4b4e2ffc1943511a90`。

Sites 项目 `appgprj_6ac76e7113d4819198e9d90830476ccc` 已创建，默认来源由平台返回。部署成功后的真实地址与版本将在此记录。

新项目安全配置检查为 revision 0、无变量。本机 `DIDA_API_KEY` 存在状态为 false。已请求用户在 Sites 项目安全设置绑定 **DIDA_API_KEY（Secret）**；不在源码、Git、命令、聊天或前端存放密钥值。

完整真实商品手机验收待安全绑定；在此之前只报告构建、mock/官方夹具验收和部署基础设施结果，不用旧环境联调截图代替线上验证。默认地址通过真实验收后才添加 `ant.devdemo.cc`，DNS类型与目标必须由平台实际返回。

## 同源后端

Sites 使用 Cloudflare Workers，正式入口为 `dist/server/index.js` 的默认 `{fetch(request, env, ctx)}`。`server/worker.mjs` 只从运行时 `env.DIDA_API_KEY` 读取秘密。浏览器请求同一来源 `/api/*`；固定供应商 `https://didatickettest.wysiwysi.com/api/distribution/v1`。

Node 开发/本地生产和 Worker 共用 `server/gateway-core.mjs` 的路由白名单、参数限制、供应商响应大小限制、密钥脱敏及 BigInt 报价校验。Worker 完整比较 POST Origin；不转发浏览器 Authorization；拒绝供应商重定向；保留正常 TLS。

Worker 的 `/api/orders` 只向供应商 `/orders/validate` 发送请求，返回 `mode: validated` 和本地草稿编号。没有真实订单创建、付款、取消或结算路由，legacy live环境变量不起作用。库存、日历和订单验证不缓存；目录成功响应短缓存。

限流由平台注入的 `cf-connecting-ip` 标识客户端，忽略 `x-forwarded-for`。每 isolate 每分钟180请求、POST额外20请求限额；这是内存级限流，不是全局分布式配额。平台重新生成env对象不重置网关；Secret变化则丢弃旧缓存。

`build-worker.mjs` 只嵌入 `dist/client/` 的公共 Vite产物，与网关一起打包成一个Worker，不需要猜测静态资源绑定。公开响应带CSP和安全头，隐藏文件、源码、环境文件无法读取。`.openai/hosting.json` 只有项目身份，不含秘密。

## 构建和验收

Node 24.5+，使用锁文件：

```sh
npm ci
npm run build
node scripts/validate-worker.mjs
npm test
npm start
```

`npm start` 的 Node静态根为 `dist/client/`，默认3000；Sites构建入口为 `dist/server/index.js`。不能单独上传前端。

本次 Node契约26/26、Worker契约25/25通过，编译Worker冒烟验证通过。移动端官方夹具验收7/7通过，Figma证据见 `docs/figma/calibration.md`；夹具不在生产前端加载。

原环境真实商品105到DEMO收银台的历史结果保存在 `docs/verification.json`，不作为本次线上验收证据。复杂旅客字段与必填checkbox的供应商契约限制继续保留，见 `server/extra-info-contract.md`。

## 发布与后续

通过 Sites官方源代码helper推送准确源状态并打包，通过原生版本/部署工具发布。保留项目ID及成功版本，不重新创建项目。修改Secret后，对已有保存版本重新部署以应用新env revision。

真实验收需先读 `/api/health`（存在状态而非凭据值），再检查城市/商品/详情/日历真实授权。使用合成联系人到DEMO收银台，检查图片、API及页面错误、手机溢出、最终报价，绝不创建真实订单或支付。

默认URL通过后，在同一项目添加 `ant.devdemo.cc`，按返回记录交由阿里云DNS管理员配置，等待所有权与TLS完成，再检查自定义域名同源/API流程。
