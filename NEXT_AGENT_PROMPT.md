# 给下一位 agent 的 prompt

复制以下内容开启下一次任务：

```text
请接手 GitHub 仓库 https://github.com/sim-628/RollingGoANT 的 main 分支。先读 HANDOFF.md、README.md、deployment/README.md 和 server/extra-info-contract.md。

目标：将现有 RollingGo ANT 手机端 Demo 发布到 ChatGPT Sites 的默认 HTTPS 地址，实际验收后再把阿里云管理的 ant.devdemo.cc 引向该站点。请直接完成已授权的构建、修复和发布工作，不重复确认已确定的需求。

保留游客端流程：首页第三个「活动」Tab → 目的地搜索（必填）＋日期范围（选填，可同日）＋成人数量（选填）→ 真实商品列表／详情／套餐／日期／数量 → 预订资料 → DEMO 收银台。所有商品、图片、套餐、价格和库存必须来自 Dida API；不要编造评分、销量、优惠或场次。演示到收银台停止，绝不能创建供应商真实订单、调用支付或结算。当前后端已固定为校验草稿模式。

API 文档：https://didatickettest.wysiwysi.com/api/distribution/docs/ 。通过环境和 Sites 项目的安全设置复用或绑定 DIDA_API_KEY，先检查现有绑定和真实读取再要求补充缺失配置。不得把密钥值写进聊天、Git、VITE_*、浏览器或前端构建。需要 API 域 didatickettest.wysiwysi.com 和商品图片域 didatickettest.oss-cn-hongkong.aliyuncs.com，保留 TLS 验证。

优先用真正可调用的 Figma MCP 读取文件 cP2IZhFbGvnjbQTluorCGO：现有首页 node 3527-5152，视觉参考 node 2957-28207，校准 Klook 手机端的活动展示方式。上个环境没有读到 frame，因此当前界面只是初稿，未完成像素校准。

先确认 Sites 原生发布工具和实际运行时。这是 React/Vite 前端＋Node 同源 API 网关，不能只上传 dist。若 Sites 使用 Worker，完成正式适配并保留原网关安全及报价核验边界。使用原生发布／部署状态工具，不猜私有接口，不静默换托管平台。

使用 Node 24.5+ 和锁文件安装，运行构建和适当测试。已有 26 项 API 测试、7 项手机验收通过；真实日游 105 的两成人当次报价 USD 66.86，真实图与完整验证草稿到收银台已通过，不得把价格或统计硬编码。复杂旅客字段仍有已记录局限。启动新的网关和浏览器，先验证安全授权读取；上个环境跨工具旧后台曾有未明原因 401，同执行上下文的新网关＋浏览器成功。浏览器若需既有 NSS 证书库权限，通过运行工具处理，勿改 HOME 或忽略 TLS 错误。

完成后给我真实可打开的 Sites 默认地址、手机验收结果和剩余限制。再按平台实际域名方案处理 ant.devdemo.cc。若能力确实缺失，准确指出缺失工具，不声称已经发布。
```
