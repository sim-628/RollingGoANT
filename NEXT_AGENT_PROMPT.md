# 后续接手 Prompt

```text
接手 https://github.com/sim-628/RollingGoANT 的main。先读HANDOFF.md的最新状态、deployment/README.md、docs/sites-verification.json、docs/figma/calibration.md和server/extra-info-contract.md。

默认Sites地址 https://rollinggo-ant.pushen987.chatgpt.site 已发布、用户明确授权公开访问，匿名Chrome390×844手机真实API流程到DEMO收银台通过。站点项目ID appgprj_6ac76e7113d4819198e9d90830476ccc，复用.openai/hosting.json，不能新建重复Site。DIDA_API_KEY已绑定Sites Secret revision1，先回读名称/秘密标记并验证真实授权，不索取已有密钥，也不把值带入前端/Git/命令/聊天。

正式Worker位于server/worker.mjs，共用gateway-core.mjs的参数/报价契约。Worker只支持manual/follow，现使用manual并拒绝所有3xx；不能回退redirect:error。npm run build生成dist/client与dist/server/index.js，node scripts/validate-worker.mjs检查实际入口。Node/Worker52项和官方夹具手机7项通过。供应商固定测试基址、白名单、同源POST、限流、脱敏、库存与报价无缓存全部保留。

Figma指定节点已实际读取并校准，证据docs/figma/calibration.md。所有商品数据和商品图片只用供应商API；品牌首页背景是Figma设计素材。演示只校验生成本地草稿到DEMO收银台，绝不能创建正式订单或付款。复杂旅客字段及必填checkbox的限制保留。

默认地址真实验收已通过，自定义域名 https://ant.devdemo.cc 已由Sites添加，国际阿里云三条DNS已回读、原六条未变，Sites域名/TLS均active。自定义域名实际流程证据见docs/custom-domain-verification.json。保持既有DNS，不改NS或其他记录。额外iPhone Simulator Safari只读验收见docs/ios-safari-verification.json；本机没有连接实体手机，不把模拟器或手机视口称作物理真机。

Sites通过官方source helper推送、打包及原生版本/部署流程。保持public访问政策；用save_site_version后deploy_site_version，不再用owner-private专用发布工具。最终给真实可打开线上地址与准确验收/限制。
```
