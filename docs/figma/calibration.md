# Figma 读取与手机版视觉校准

校准日期：2026-10-08。

本次使用已连接的 Figma MCP 实际读取了文件 `cP2IZhFbGvnjbQTluorCGO`，没有沿用交接文档中的未验证设计假设。

## 已读取节点

- 首页 [`3527:5152`](https://www.figma.com/design/cP2IZhFbGvnjbQTluorCGO/AI-Lab-2026Q3?node-id=3527-5152)：完整设计 context、375 × 1099 截图、变量定义。参考截图保存在 [home-reference.png](home-reference.png)。
- 视觉参考 [`2957:28207`](https://www.figma.com/design/cP2IZhFbGvnjbQTluorCGO/AI-Lab-2026Q3?node-id=2957-28207)：该节点是 canvas「9/14 会后改版RollingGo机票+变量全替换」，并非单个 frame。通过 metadata 实际读取其结构，随后读取以下可见子 frame 的完整 context 和截图。
- `2957:29295`：单程机票列表，确认白色卡片、灰色背景、8px 圆角、深蓝选择态、红色价格。
- `2957:30262`：订单详情，确认深蓝主色、白色信息卡和底部操作区域。
- `2957:36686`：出行信息卡，确认正文排版、间距和分割线。

## 已应用依据

| 设计值 | 实现 |
| --- | --- |
| 主品牌 `#000947` | 搜索按钮、套餐选择、日历选择、导航和预订按钮 |
| 第二品牌 `#e90245` | 商品价格、套餐合计、预订与收银台报价 |
| 背景 `#ffffff` / `#f3f3f3` | 白色卡片、浅灰表单与详情背景 |
| 边框 `#e8e8e8` / 分割线 `#eeeeee` | 表单、商品卡、资料与搜索行 |
| 卡片圆角 8px / 按钮圆角 6px | 首页、商品、套餐、表单和收银台 |
| 手机左右边距 16px | 首页搜索卡、详情及表单内容 |
| 标题 18px/26px、正文 14px/22px、辅助正文 12px/20px | 首页分区和主要文字层级 |

首页使用 Figma 返回的原始背景照片，已下载到 `public/design/home-header.png`，构建后由同源静态路径提供。它是品牌头部的设计装饰；商品图片仍完整来自商品 API。照片源尺寸 735 × 976，实际头部槽位使用 `cover`，没有将 frame 截图作为界面素材，也没有在前端保留临时 Figma URL。

首页保留第三个「活动」Tab 和目的地必填、日期/成人选填的搜索流程。将原橙色大标题初稿改为指定首页的照片头部与叠放搜索卡，并去掉底部附加营销文案。未复制 Figma 中的示例航班、示例价格、系统状态栏、小程序胶囊、付款动作或航旅资料。

活动商品页、套餐、预订资料和 DEMO 收银台沿用已有可操作布局，只统一指定视觉语言。这是从指定机票/首页设计适配出的活动流程，不能称为一份未提供的活动 frame 的逐像素复刻。字体使用系统 `PingFang SC` 及系统字体回退；没有凭空下载或捆绑未提供的专有字体。

## 验证证据

- TypeScript 构建检查通过。
- Vite `dist/client` 构建和 Sites Worker 构建通过；Worker 报告 5 个公开资产，不打包运行时凭据。
- 在实际 Chrome、390 × 844 手机 viewport 中运行 `tests/browser_acceptance.py`，**7/7 场景通过**；所有 `/api/*` 响应均由官方公开示例夹具拦截，商品图为明确的测试图。
- 已人工查看首页、预订资料和 DEMO 收银台截图；测试还检查页面无横向溢出、页面错误和未匹配 API 请求。
- 修复第一项验收中的同步等待：搜索后的旧商品标题与新商品标题相同，原等待可在旧图片被替换前结束；现在先等待目的地商品响应与加载完成，再检查图片。

截图位于已忽略的 `artifacts/browser/`，文件名均包含 `official-fixture`：

- `01-home-official-fixture.viewport.png`
- `02-catalog-official-fixture.viewport.png`
- `04-product-overview-official-fixture.viewport.png`
- `04-product-detail-official-fixture.viewport.png`
- `05-booking-official-fixture.viewport.png`
- `06-confirmation-official-fixture.viewport.png`

以上是视觉和公开接口契约验收，**不是本次部署的真实 API 验收**；真实 API 与默认 HTTPS 地址必须由部署环境安全绑定 `DIDA_API_KEY` 后另行验证。
