# 附加信息：真实只读验证证据

2026-10-08 使用已绑定的服务端认证，仅调用供应商 `/orders/validate`，未创建订单或支付。所有联系人均为合成测试资料。

商品 `105`、套餐 `23D`、出行时间 `2026-10-12 00:00:00`、成人 SKU `3OIQM5X` × 2 的验证成功返回 `valid: true`，真实报价 `USD 66.86`，单价 `33.43`。

已验证的预订补充信息结构：

```json
[
  {
    "key": "contact_way_no",
    "selected": [
      { "key": "contact_way_no_whatsapp", "content": "86-13800000000" }
    ]
  },
  { "key": "1234740", "content": "Berjaya Times Square Entrance (infront Starbucks)" },
  { "key": "10369658", "selected": [{ "key": "109227656", "content": "" }] },
  { "key": "10369659", "selected": [{ "key": "109227803", "content": "" }] }
]
```

以上键及选项都来自对应套餐的真实 `/packages/extra-info`。它们仅作为验证证据，不能硬编码为其他商品的默认值。文本字段使用 `content`，选中选项嵌在父字段的 `selected` 数组中；选项自身要求填写文本时，该文本放在选项对象的 `content`。

同一次成功请求的旅客条目：

```json
[
  { "sku_code": "3OIQM5X", "index": 1, "extra_info": [] },
  { "sku_code": "3OIQM5X", "index": 2, "extra_info": [] }
]
```

此套餐返回的旅客附加字段规则为空，但验证接口仍要求每位旅客一项。使用 `unit_index` 或省略旅客条目被供应商拒绝；`sku_code` 与 `index: 1, 2` 通过。尚未验证有必填旅客字段时 `extra_info` 内部的序列化结构，也未验证日期、数字、多选等复杂字段。

商品 105 的原始供应商列表响应当前返回 `price: "0.00", currency: "USD"`；本站 API 同样返回该值，没有本地价格补充或换算。预订价格以真实 SKU 日历与订单验证报价为准，成人报价仍为 `USD 33.43`。列表起价的零值不能代表成人免费。

## 带旅客字段的套餐：仍有前置契约阻断

同日进一步检查商品 `10Y1`、套餐 `8DN4`。真实 SKU 日历返回 `AKTCFAWQ`（Participant），`2026-10-12 09:00:00`、`USD 36.46`、库存 `12`。该套餐要求 15 个旅客字段，含文本、出生日期、电话国家选项和单选。

订单验证首先检查预订层必填字段 `1098371`，类型为 `checkbox`（高风险活动声明），该字段没有选项。有限的提交形式诊断尚未通过：`content` 使用 `"true"`、`"1"`、`"yes"`、`"on"` 或布尔值，以及 `value`、`checked`、`accepted`、`is_checked` 布尔形式，均返回 `1401 / extra info 1098371 is required`；将该键放入 `selected` 则返回 `selected option is invalid`。

因此这些请求尚未进入旅客字段验证，不能把它们作为 `unit_extra_info[].extra_info` 非空容器、`mobile` 国家选择或日期字段提交格式的成功证据。需要供应商补充 `checkbox` 请求契约后继续确认；目前没有修改上游规则、跳过声明或声称已经通过完整验证。
