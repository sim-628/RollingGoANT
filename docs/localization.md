# 中文地名与分类显示

`src/localization.ts` 只转换显示名称，不修改供应商城市编号、国家编号、分类编号或请求参数。搜索可同时匹配原始名称和中文显示名称。

## 覆盖范围

2026-10-08 对公开接口完成只读核对：

- `/api/catalog/cities`：457 个目的地，29 个国家／地区。
- `/api/catalog/categories`：15 个主分类、107 个子分类。
- `/api/catalog/products?page=N&limit=50`：顺序读取 63 页，共 3,114 件商品。供应商网关上限是每页 50 件。
- 去重后的回归样本包含 565 种非空城市名称、43 种非空国家名称（含繁简中文别名）及 161 种分类名称，另保留空名称作为缺失数据样本。商品分类本身共 147 种，其余分类来自目的地分类目录。

目的地目录缺失但商品中存在的英文城市名称已加入静态中文映射。国家采用名称到 ISO 两字母地区码的映射，再使用 `Intl.DisplayNames('zh-CN')` 输出中文；`country_code` 是供应商数字编号，不能当作 ISO 码。香港、澳门、台湾地区与中国大陆的显示单独处理。已有纯中文地名保留。

## 名称来源与处理原则

公开商品目录是原始地名和分类名称的依据。常用地名采用通行中文名；缺少稳定中文名的小型行政区采用中文音译，并保留“县／区／郡”等行政区含义。音译是应用显示选择，不声称全部都是官方指定中文译名。

参考核对的第一方地理／旅游资料：

- [澳大利亚旅游局中文目的地地图](https://www.australia.com/zh-tw/explore.html)：主要澳大利亚城市名称；显示转换为简体。
- [印度尼西亚旅游局巴厘岛介绍](https://www.indonesia.travel/cn/zh-cn/destination/bali-nusa-tenggara/bali/bali)：库塔及巴厘岛目的地名称。
- [新西兰旅游局罗托鲁瓦介绍](https://www.newzealand.com/cn/rotorua/)与[简体中文旅游地图](https://www.newzealand.com/assets/Tourism-NZ/PDFs/16572-IST-Touring-Map-Simplified-Chinese-01-19-Web.pdf)：新西兰目的地名称及地理对应关系。
- [冰岛布劳斯科加比格兹市政府](https://www.blaskogabyggd.is/is/thjonusta/ymis-frodleikur/frodleikur-um-blaskogabyggd-1)与[诺尔杜廷市政府](https://www.nordurthing.is/is)：长名称的市镇身份，中文采用音译。
- [意大利陶瓷区市镇联合政府](https://www.distrettoceramico.mo.it/)：`Unione dei comuni del Distretto Ceramico` 保留其联合行政区含义。

完整快照只保存名称和国家代码，不保存图片、价格、个人信息或凭据，位于 `scripts/localization-fixtures.json`。可运行：

```sh
node --experimental-strip-types --test scripts/localization.test.mjs
```

回归检查覆盖所有当前名称而且禁止已知名称使用泛化兜底。未来供应商新增且尚无映射的英文名称会显示“当地目的地／其他地区／其他体验”，不会把英文直接泄漏到中文选项或地名标签。显示函数不推测或改写商品自身地理信息；原始商品元数据中的错误应在供应商数据侧更正。
