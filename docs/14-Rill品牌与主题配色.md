# LoFold · 品牌与主题配色

2026 年 11 月 21 日确认产品名为 **LoFold**。名称由六个字母组成，读作 Lo-Fold。Lo 取自 Local，Fold 取折信收好之意。中文寓意「来信在手，心里有数」，对应在本机管理和查找邮件。英文 slogan 为 **All your inboxes, in one place.**

标志由两块折纸轮廓和一条弯折留白组成，适用于应用图标、侧栏和浏览器标签页。[SVG 标志](../packages/branding/lofold.svg) · [十种主题预览](../apps/design-preview/directions.html)

## 先看专业配色资料

| 来源 | 本轮怎么用 |
| --- | --- |
| Adobe Color | 看色轮上的色相间距和配色关系，确认七种彩色覆盖红、橙、黄、绿、青、蓝、紫。工具也提供色觉差异模拟与对比度入口。[Adobe Color 色轮](https://color.adobe.com/create/color-wheel) · [配色可访问性工具](https://color.adobe.com/create/color-accessibility) |
| Radix Colors | 用 12 级色阶区分背景、控件、选中、按钮和强调文字。七种彩色取官方包 3.0.0 的 sRGB 色阶，曜金参考 Gold Dark。实际按钮根据对比度调深。[官方色阶](https://www.radix-ui.com/colors/docs/palette-composition/scales) · [色阶用途](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · [色值来源](https://github.com/radix-ui/colors) |
| IBM Carbon | 参考中性色承载密集内容与黑白主题分层的做法。黑、白与曜金各使用独立的侧栏、列表和阅读底色。[Carbon 色彩总览](https://www.carbondesignsystem.com/building-blocks/foundations/color/overview) |
| W3C WCAG 2.2 | 普通文字采用 4.5:1 界线，关键非文字控件提示采用 3:1 界线。本轮计算采用 sRGB 相对亮度。[文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) · [非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |

## 三种用法筛选

| 方案 | 对照结果 |
| --- | --- |
| 中性底和彩色按钮 | 类似 Carbon 的中性结构。按钮和选中条最易辨认，整个邮箱切换后的色彩变化偏小。保留其白色和黑色底色分层。 |
| 侧栏浅染、正文近中性 | 采用 Radix 的分角色色阶。侧栏、选中态和主按钮都能体现主题，正文仍有稳定的阅读对比。七种彩色采用这一版。 |
| 满色侧栏 | 以 Radix 第 9 阶为满色侧栏做对照，主题识别最强。未经调节的红色侧栏与统一深色文字比为 4.16:1，低于 4.5:1。部分色系需要一套专门的文字和状态搭配，且会增加长时间阅读的大面积色彩。 |

原始实色直接配白字时，红、橙、黄、绿、青、蓝分别为 3.91、2.97、1.26、3.16、3.00、3.26:1，紫为 5.39:1。红、橙、绿、青、蓝以第 9 阶向第 12 阶压深至按钮至少 4.8:1，黄色保留明亮底并配深色字。选中态另外调整强调字色，保留文字标签、焦点和左侧标线。

## 筛后的十种主题

| 主题 | 侧栏 | 主按钮 | 按钮文字 |
| --- | --- | --- | --- |
| 白色 | `#F4F4F4` | `#242424` | `#FFFFFF` |
| 黑色 | `#101010` | `#EEEEEE` | `#181818` |
| 红色 | `#FFDBDC` | `#CC3F45` | `#FFFFFF` |
| 橙色 | `#FFDFB5` | `#BB5318` | `#FFFFFF` |
| 黄色 | `#FFF394` | `#FFE629` | `#202020` |
| 绿色 | `#D6F1DF` | `#288157` | `#FFFFFF` |
| 青色 | `#CAF1F6` | `#057C98` | `#FFFFFF` |
| 蓝色 | `#D5EFFF` | `#0573CF` | `#FFFFFF` |
| 紫色 | `#EBE4FF` | `#6E56CF` | `#FFFFFF` |
| 曜金 · 尊享 | `#121211` | `#E0C58F` | `#211A0F` |

曜金使用暖黑背景和香槟金强调色，黄色使用浅色背景。十种主题都能在原型里直接选择。单独打开 LoFold 后，可在「工作区设置 → 主题色」切换并保存在当前浏览器。

[品牌与十种主题色总览](../output/brand/LoFold-品牌与十种主题色.png) · [1024 px 应用图标](../output/brand/LoFold-图标-1024.png) · [曜金桌面](../output/playwright/LoFold/曜金-桌面.png) · [曜金手机](../output/playwright/LoFold/曜金-手机.png)

## 浏览器验证

十种主题逐一打开桌面和手机预览。抽测主按钮、选中筛选、快捷文件夹、阅读正文和侧栏标签的文字对比，所有组合最低为 4.81:1。阅读工具栏上的焦点色与背景最低为 5.91:1。手机读信工具按钮实测至少 40 px，独立工作区的主题切换在刷新后仍生效。

从[离线包](../output/本地邮箱-离线原型.zip)解压打开 `directions.html`，在 360 px 视口验证了十个主题入口及曜金欢迎页到示例邮件回复的流程。未观察到外部网络请求或脚本错误。

## 英文名称初筛

2026 年 11 月 21 日检索 LoFold 和 Lo Fold，本轮公开索引中未发现同名邮箱客户端或 AI 助手。App Store 中国区返回 0 条，美国区返回 2 条模糊匹配，均无同名应用。GitHub 找到同名个人仓库和音乐生成项目。正式商标与上架名称可用性待核验。[同名音乐项目](https://github.com/lchbssr/Lofold)
