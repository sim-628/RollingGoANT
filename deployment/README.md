# ANT Sites 部署

## 当前状态（2026-10-08）

接手 GitHub main，原始提交 `dac9e773182605360190bf4b4e2ffc1943511a90`。

Sites 项目 `appgprj_6ac76e7113d4819198e9d90830476ccc` 已创建，默认来源由平台返回。默认地址已发布并公开，无需登录。已验收运行时代码提交 `d2767a6f1e96b14edecb0ee4179a37228409a8bf`；后续提交仅补充交接与验收证据。

初始安全检查为 revision 0、无变量，本机 `DIDA_API_KEY` 存在状态为 false。随后已通过 Sites 原生工具绑定 **DIDA_API_KEY（Secret）**，revision 1，并重新部署应用。密钥不在源码、Git、命令或前端中。

默认 HTTPS 已发布：`https://rollinggo-ant.pushen987.chatgpt.site`，用户已明确授权公开访问，当前无需登录。匿名真实 API 手机流程已通过，证据见 `docs/sites-verification.json`；在此之前只报告构建、mock/官方夹具验收和部署基础设施结果，不用旧环境联调截图代替线上验证。默认地址通过真实验收后才添加 `ant.devdemo.cc`，DNS类型与目标必须由平台实际返回。

## 同源后端

Sites 使用 Cloudflare Workers，正式入口为 `dist/server/index.js` 的默认 `{fetch(request, env, ctx)}`。`server/worker.mjs` 只从运行时 `env.DIDA_API_KEY` 读取秘密。浏览器请求同一来源 `/api/*`；固定供应商 `https://didatickettest.wysiwysi.com/api/distribution/v1`。

Node 开发/本地生产和 Worker 共用 `server/gateway-core.mjs` 的路由白名单、参数限制、供应商响应大小限制、密钥脱敏及 BigInt 报价校验。Worker 完整比较 POST Origin；不转发浏览器 Authorization；使用 Workers 支持的 `redirect: manual` 并显式拒绝供应商所有 3xx 重定向；保留正常 TLS。

Worker 的 `/api/orders` 只向供应商 `/orders/validate` 发送请求，返回 `mode: validated` 和本地草稿编号。没有真实订单创建、付款、取消或结算路由，legacy live环境变量不起作用。库存、日历和订单验证不缓存；目录成功响应短缓存。

限流由平台注入的 `cf-connecting-ip` 标识客户端，忽略 `x-forwarded-for`。每 isolate 每分钟180请求、POST额外20请求限额；这是内存级限流，不是全局分布式配额。平台重新生成env对象不重置网关；Secret变化则丢弃旧缓存。

`build-worker.mjs` 只嵌入 `dist/client/` 的公共 Vite产物，与网关一起打包成一个Worker，不需要猜测静态资源绑定。Worker响应带CSP和安全头，隐藏文件、源码、环境文件无法读取。线上API安全头已读回；平台CDN提供的首页/静态资源读回未带应用CSP，不能把编译入口检查当作所有线上静态头已生效。`.openai/hosting.json` 只有项目身份，不含秘密。

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

本次 Node契约26/26、Worker契约26/26通过，编译Worker冒烟验证通过。移动端官方夹具验收7/7通过，Figma证据见 `docs/figma/calibration.md`；夹具不在生产前端加载。

原环境真实商品105到DEMO收银台的历史结果保存在 `docs/verification.json`，不作为本次线上验收证据。复杂旅客字段与必填checkbox的供应商契约限制继续保留，见 `server/extra-info-contract.md`。

## 发布与后续

通过 Sites官方源代码helper推送准确源状态并打包，通过原生版本/部署工具发布。保留项目ID及成功版本，不重新创建项目。修改Secret后，对已有保存版本重新部署以应用新env revision。

真实验收需先读 `/api/health`（存在状态而非凭据值），再检查城市/商品/详情/日历真实授权。使用合成联系人到DEMO收银台，检查图片、API及页面错误、手机溢出、最终报价，绝不创建真实订单或支付。

默认URL通过后，在同一项目添加 `ant.devdemo.cc`，按返回记录交由阿里云DNS管理员配置，等待所有权与TLS完成，再检查自定义域名同源/API流程。

## 本次默认地址真实验收

2026-10-08，公开地址使用新 Chrome 上下文、390×844 手机视口与正常 TLS，无 Sites 访问令牌，完整流程到 DEMO 收银台通过。代表商品105、套餐23D、两成人，供应商当次最终报价 USD 66.86。原图与预订缩略图 naturalWidth 均3000；图片失败、API错误、页面异常和横向溢出均0。仅供应商校验，没有创建订单或付款；此结果不能推广为全部商品与复杂旅客资料已联调。

`docs/sites-verification.json` 是本次线上真实结果，区别于 `docs/verification.json` 的原环境历史结果。官方夹具7/7及Node/Worker52/52通过。构建产物扫描未包含供应商密钥前缀；Sites Secret回读仅返回名称和is_secret=true，值隐藏。

曾出现的502已通过原生Worker日志确认是Workers不支持redirect:error；现已改为manual并显式拒绝所有3xx。新增重定向拒绝测试覆盖301/302/303/307/308，密钥不转发到其他来源。

公开访问政策变更后重新部署已保存版本，匿名health为200、configured=true、order_mode=validate；匿名真实流程再次通过。自定义域名已由原生工具添加，国际阿里云已保存并回读下述准确记录（TTL 600 秒、启用），原有六条记录未变：

| 类型 | devdemo.cc主机记录 | 平台返回的值 |
| --- | --- | --- |
| CNAME | ant | custom-domains.chatgpt.site. |
| TXT | _openai-site-verification.ant | openai-site-verification=gxZUf9KDsofYlzuhCgRzjZlnKgXwDexbwc-rU99YMuk |
| TXT | _cf-custom-hostname.ant | 2bec74cf-7c6e-4c4d-af93-24d74778d82c |

2026-10-08T10:54:12Z，Sites 回读 status=active、provider_status=active、ssl_status=active、last_error=null。ns7/ns8 权威查询三条记录均匹配；匿名 https://ant.devdemo.cc/api/health 返回200、configured=true、order_mode=validate。随后匿名 Chrome 手机视口完整真实 API 流程到 DEMO 收银台通过，报价 USD 66.86，图片/API/页面错误0、无溢出；没有创建订单或付款。结果见 docs/custom-domain-verification.json。

额外 iPhone 17 / iOS 26.5 Simulator Safari 已只读检查真实首页、城市、目录和商品105详情，无 TLS 警告，证据 docs/ios-safari-verification.json；没有在 Safari 填资料或到达收银台。本机 devicectl 未发现实体手机，不能将移动视口或 Simulator 结果称为物理手机验收。
