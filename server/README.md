# ANT 商品服务

Node 24.5+ 原生 HTTP 服务，不依赖第三方服务器框架。浏览器仅请求本站 `/api/*`；供应商凭据只存在服务端环境变量，不写入前端、日志、缓存文件或代码。

```sh
# 先通过环境设置或部署平台安全配置 DIDA_API_KEY。
# 开发：Vite 将 /api 转发到本地 8787。
ANT_API_PORT=8787 node server/index.mjs

# 生产：构建前端后，同一个进程提供 dist 和 API。
PORT=3000 node server/index.mjs

# 不访问真实供应商、不会创建订单的契约测试。
node --test server/index.test.mjs
```

不要把密钥作为命令行参数，也不要使用 `VITE_` 前缀存储密钥。CLI 通过 Node 的 `setGlobalProxyFromEnv()` 保留运行环境注入的 HTTP/HTTPS 代理及 CA 信任，证书验证保持开启。

## 环境变量

| 名称 | 用途 |
| --- | --- |
| `DIDA_API_KEY` | 必需；Dida 分销 API 的服务端 Bearer 凭据。缺少时商品接口返回可诊断的 503。 |
| `ANT_API_PORT` | 可选，开发 API 端口，例如 `8787`；优先于 `PORT`。 |
| `PORT` | 可选，生产端口，默认 `3000`。 |
| `ANT_HOST` | 可选，绑定地址，默认 `0.0.0.0`。 |

上游固定为 `https://didatickettest.wysiwysi.com/api/distribution/v1`。不能传入任意 URL；不实现真实订单创建、支付、取消、余额、订单列表或其他供应商接口。此演示固定为订单验证模式，遗留的 `DIDA_ORDER_MODE=live` 或 `ANT_CHECKOUT_URL` 环境设置不会启用真实下单。

## 浏览器契约

供应商响应保留 `{ success, data }` / `{ success:false, error }` envelope，供应商状态码和业务错误原样传递，凭据字段会防御性隐藏。本站提交接口只返回明确标记的验证草稿。所有供应商请求设置 `Accept-Language: zh-CN`。

| 本站接口 | 必需参数 | 供应商接口 |
| --- | --- | --- |
| `GET /api/catalog/countries` | 无 | `/countries` |
| `GET /api/catalog/cities` | 无；可选 `country_codes` | `/cities` |
| `GET /api/catalog/categories` | 无 | `/categories` |
| `GET /api/catalog/products` | `page`、`limit` | `/products` |
| `GET /api/catalog/prices` | `product_codes`（1–4 个不重复的商品编码） | 商品详情 + 全套餐适用 SKU 日历的只读聚合 |
| `GET /api/catalog/products/:productCode` | 路径商品编码 | `/products/:productCode` |
| `GET /api/catalog/packages/extra-info` | `package_codes` | `/packages/extra-info` |
| `GET /api/catalog/skus/calendar` | `sku_codes`、`start_date`、`end_date` | `/skus/calendar` |
| `POST /api/availability-check` | 套餐数组，JSON 根节点不是对象 | `/availability-check` |
| `POST /api/orders/validate` | 联系人及套餐订单 JSON | `/orders/validate` |
| `POST /api/orders` | 同上；重新验证报价并生成本站草稿 | 仅 `/orders/validate` |
| `GET /api/health` | 无 | 本站状态，不请求供应商，不暴露凭据 |

商品搜索支持供应商已有的 `country_codes`、`city_codes`、`category_codes`、`keyword`、`product_code`、`page` 和 `limit`（1–50）。可选日期、人数用于查询实际 SKU 日历或预订库存；供应商商品搜索本身没有日期／人数参数。日历日期必须使用目的地当地时间 `yyyy-MM-dd HH:mm:ss`，区间不超过 90 天。

商品卡片通过 `/api/catalog/prices?product_codes=1047,104G,105` 异步取得真实起价，列表接口原有 `price` 值不会被改写。返回 `data.prices` 数组，每项包含 `product_code`、`status`（`ready` / `unavailable` / `error`）、`price`、`currency`；完成日历查询的项目另带 `start_date`、`end_date`、`basis: "adult_or_general_unit"`。仅 `ready` 可展示“价格 + 起”；其他项目的价格与币种为 `null`，不能编造兜底价格。非 `ready` 状态也包含 `reason` 用于诊断，浏览器不必展示内部原因。

起价取所有套餐中成人 SKU 的真实单价；没有成人分类的套餐使用非儿童／婴儿的通用 SKU（例如每人、团体、门票）。日历窗口为接下来 90 个日历日期，开始日期不早于供应商要求的 Asia/Shanghai 今天，也不早于任何套餐的目的地今天。仅纳入已发布、有库存、未超过 UTC 截止时间的价格，按四位小数定点整数比较；不以婴儿零价或目录 `0.00` 冒充成人起价，不换算不同币种，不把缺失套餐日历的一部分当作完整最低价。实际单价仍以详情及预订时重新查询的日历和最终报价为准。

每次起价请求最多 4 个商品，每商品最多 100 个适用 SKU；超过时不截断报价，返回 `unavailable`。日历按 20 个 SKU 批量查询，每请求最多 24 次供应商读取，服务内供应商并发最多 4，进行中的不同商品最多 20 个（等待队列最多 16 个），重复商品的进行中请求共享一次读取。超出容量返回可重试的 `error` / `price_busy`。每商品从进入队列起最多运行 22 秒，到期取消排队及上游请求，返回 `error` / `price_timeout`；起价上游单次响应限制 2 MiB，详情和每批日历立即归约为少量商品编码、最低价和币种状态，不跨批保留完整内容。任何后续批次缺失或失败都丢弃部分最低价。仅展示用的起价摘要缓存 30 秒且最多 500 项，错误不缓存；库存、直接日历与订单验证接口仍不缓存。供应商官方日历契约见 [DidaTicket OpenAPI schema](https://didatickettest.wysiwysi.com/api/distribution/schema/?format=json)，当前公开商品已核实使用 `selling_price`、`currency`、`publish_status`、`inventory` 和 `cutoff_time_utc` 字段。

订单联系人固定为 `first_name`、`family_name`、`mobile`，手机号格式为 `86-13800000000`。商品详情的 `contact_info` 是字段规则，不是订单请求形状；例如 `name_english` 规则要求将英文姓名拆到上述两个姓名字段。商品要求的额外信息仍按 `/packages/extra-info` 的真实规则填写。

`/api/orders` 成功响应（报价示例来自本次商品 105 的真实验证，部署时使用实际 API 返回）：

```json
{
  "success": true,
  "data": {
    "mode": "validated",
    "draft_id": "ANT-<uuid>",
    "quote": {
      "currency": "USD",
      "total_amount": "66.86",
      "items": [{
        "package_code": "23D",
        "start_time": "2026-10-12 00:00:00",
        "currency": "USD",
        "selling_total": "66.86",
        "sku_list": [{ "sku_code": "3OIQM5X", "count": 2, "selling_unit_price": "33.43" }]
      }]
    },
    "message": "预订信息已确认。此演示未创建订单或发起支付，下一步由 RollingGo 现有收银台接续。"
  }
}
```

草稿编号不是供应商订单编号。界面展示收银台前的交接状态，不生成支付地址，不创建或支付供应商订单。

`/api/orders` 重新请求供应商最终验证，只有 `valid: true` 且报价具有有效的 `currency`、`total_amount` 和相符的套餐／SKU 数量才确认。每个 SKU 必须传入已确认的 `acceptable_price`，最终单价和总额使用定点整数核对；价格变化返回 HTTP 409、`error.code: "PRICE_CHANGED"` 和 `error.quote` 最新报价，绝不创建订单。浏览器应展示新报价并要求再次确认，不能自动重试。本地可传入 `expected_currency` 和 `expected_total` 检查已确认币种及总额是否变化，这两个字段会在转发供应商前删除。直接调用 `/api/orders/validate` 仍遵守上游可选单价契约，用于读取或诊断初始报价。

当前公开文档给出了附加信息的展示规则，却没有完整定义请求内部结构。已通过商品 105 的真实只读订单验证确认：普通文本使用 `{ key, content }`，单选使用 `{ key, selected: [{ key: optionKey, content: optionText }] }`；每位旅客都需 `unit_extra_info` 条目 `{ sku_code, index: 1..count, extra_info: [] }`，即使对应旅客字段规则为空。详见 [附加信息契约证据](extra-info-contract.md)。有旅客字段的 `extra_info` 内容结构和其他复杂字段类型仍需分别验证，不能把空数组通过当作完整契约已经确认。

国家／城市／分类缓存 5 分钟，商品列表／详情／附加信息缓存 30 秒；SKU 日历、库存验证及订单请求不缓存。缓存仅限内存，有数量上限。JSON 请求限制 128 KiB，API 按连接来源每分钟最多 180 次，其中 POST 最多 20 次。反向代理应额外配置入口限速；服务端不信任客户端提供的 `X-Forwarded-For`。

发布时将本站域名反向代理到本服务端口，并在部署平台安全绑定凭据。此服务可直接由容器／Node 托管平台运行；服务器未内置域名 DNS、TLS 证书或 RollingGo 收银台配置。

## 云环境验证与交接

2026-10-08 在当前云环境中曾出现跨工具长期后台进程返回供应商 401 的情况，根因尚未确认。相同只读商品请求在默认 sandbox 与升级权限上下文、开发／生产 API 和新 Node 进程直接请求供应商时均返回 200，没有证据表明用户密钥丢失，不应因此盲目重绑凭据。

之后在同一个执行上下文启动新 API 网关和新浏览器，真实商品 105 的完整预订演示通过，最终真实验证报价 USD 66.86；图片加载成功，API／页面错误均为零，没有创建订单或支付。迁移到新环境时重新安全绑定 `DIDA_API_KEY`，使用新进程验证商品读取与演示流程；不要把旧后台进程的 401 或当前进程的成功扩大为已经确认所有认证／部署问题的根因。
