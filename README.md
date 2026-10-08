# RollingGo ANT

手机游客端活动 Demo，覆盖首页「活动」入口、目的地搜索、商品列表、详情、套餐与日期选择、预订资料和演示收银台。演示到收银台结束，不创建供应商订单、不调用支付。

## 当前 Sites 接续状态（2026-10-08）

已接手 main（原始提交 `dac9e77`），真实读取两个指定 Figma 节点并校准视觉。已新增正式的 Cloudflare Worker `fetch` 网关，与 Node 共用输入及报价契约；构建同时生成前端和同源 API，不是仅上传静态页面。

Sites 项目：`appgprj_6ac76e7113d4819198e9d90830476ccc`。新项目安全环境变量检查为空，本机没有继承 `DIDA_API_KEY`。须由用户在 Sites 安全设置添加同名 Secret，后续部署应用该环境版本后再做真实供应商验收。历史联调记录不代表本项目已绑定或已验收。

原 Node 契约 26 项与 Worker 契约 25 项通过。当前 Figma 依据见 `docs/figma/calibration.md`；当前部署路径见 `deployment/README.md`。

## 已实现

- 首页酒店、机票、活动三个并列 Tab，活动位于第三个。
- 目的地必填；日期范围和成人数量选填，起止日期可同日。空日期及人数也能查询目的地商品。
- 商品、图片、描述、套餐、SKU、价格、库存与资料规则来自 DidaTicket API；正式应用没有测试商品或离线替代数据。
- 目录接口没有日期／人数过滤参数，这两个条件保留到套餐选择环节确认，界面有说明。
- 支持分类、分页、图片轮播、价格日历、库存及截止时间、套餐人数限制、联系人和动态附加资料、报价变化后的再次确认。
- 商品目录缺少有效正数价格时显示「选择套餐查看价格」；套餐以真实日历报价计算，不把婴儿零价作为成人价格。
- 本站 `/api/orders` 只验证资料和最终报价，然后返回明确标记的草稿；收银台显示 DEMO 状态，没有付款入口。

## 运行

要求 Node **24.5+**。先在安全环境设置绑定 `DIDA_API_KEY`，不要将密钥放入命令、代码或前端变量。

```sh
cd /workspace/RollingGoANT
npm ci --cache /workspace/.cache/rollinggo-ant/npm --no-fund --no-audit
npm run dev
```

默认前端 5173、API 8787；可以通过 `ANT_WEB_PORT` 和 `ANT_API_PORT` 同时指定其他空闲端口。Vite 使用同源代理，保留浏览器来源检查。当前实例曾用 5175／8917 验证开发 API；新网关与浏览器在同一受控执行上下文完成了生产流程验收。

生产运行：

```sh
npm run build
npm start
```

默认生产端口 3000，同一个 Node 进程提供 `dist/client/` 和同源 API。Sites 部署使用 `dist/server/index.js` 的标准 Worker 入口。不要把仓库目录作为静态根目录，也不要只部署前端文件而漏掉安全 API 网关。

## 环境配置

| 名称 | 说明 |
| --- | --- |
| `DIDA_API_KEY` | 必须，供应商服务端凭据；禁止使用 `VITE_*` 变量。 |
| `ANT_API_PORT` | 开发 API 端口，默认 8787。 |
| `ANT_WEB_PORT` | 开发前端端口，默认 5173。 |
| `PORT` | 生产端口，默认 3000。 |

服务遵循环境代理和 CA 配置，保留 TLS 验证。`.env.example` 不含凭据；服务器不会自动读取环境文件。

网络需要供应商 API `didatickettest.wysiwysi.com` 和图片 `didatickettest.oss-cn-hongkong.aliyuncs.com`。图片域名已补进云环境草稿；真实 JPEG 和浏览器页面均已验证成功，商品及预订缩略图原始宽度 3000，最终图片失败数为 0。不能仅以网络清单判断访问状态。

## 验证

```sh
npm run build
npm test
python3 tests/browser_acceptance.py --base-url http://127.0.0.1:5175
python3 tests/live_browser_smoke.py --base-url http://127.0.0.1:5175 --product-code 105
python3 tests/live_cashier_smoke.py --base-url http://127.0.0.1:5175
```

浏览器验证需开发服务、Python Playwright 和 Chromium。验收夹具来自公开 API 示例，仅在测试时拦截请求；正式站点不加载这些内容。

当前实例已安全绑定供应商凭据，并验证 **457 个城市、3,114 个商品**。真实商品 105 的七个套餐、实际行程内容、附加资料规则和成人价格日历已接入；示例日期成人单价 US$33.43，最低两人合计 US$66.86。实时价格和库存仍可能变化。

26 项 API 契约测试和 7 项手机模拟验收通过。真实手机检查使用合成资料完成详情、日期选择、预订资料和演示收银台，供应商校验报价 USD 66.86，未创建订单或支付，图片及 API／页面错误数均为 0。最终验收需网关与浏览器处于同一受控执行上下文；旧后台进程曾出现未明原因的 401。公开交接证据见 [docs/verification.json](docs/verification.json)，截图见 [交接文档](HANDOFF.md)。

## 外部依赖

1. **Figma 校准**：本次已通过 Figma MCP 读取指定首页及视觉参考画面，完成主色、价格色、卡片及手机搜索区域校准。由于活动 Demo 与原酒店首页的内容不同，属于基于设计语言的校准，不能称为所有页面逐像素完全复刻。
2. **附加资料提交契约**：代表日游已用供应商无副作用校验确认 `content`／`selected` 及每位旅客的 `sku_code`／从 1 开始的 `index`。非空旅客字段的精确提交容器尚未验证；含必填 checkbox 的已知不兼容套餐会提示选择其他套餐。详见 `server/extra-info-contract.md`。
3. **场次**：实际日历缺少场次列表的套餐会提示无法预订，不生成虚构时间。
4. **发布**：本次 Sites 原生能力可用，已经创建项目；发布与真实验收状态以 [发布交接](deployment/README.md) 的当前记录为准。默认地址验收通过前不接 `ant.devdemo.cc`。

后续部署请先读 [HANDOFF.md](HANDOFF.md) 和 [NEXT_AGENT_PROMPT.md](NEXT_AGENT_PROMPT.md)。服务契约详见 [server/README.md](server/README.md)，浏览器验证方式详见 [tests/README.md](tests/README.md)。
