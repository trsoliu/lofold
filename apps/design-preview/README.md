# LoFold 设计预览

从仓库根目录执行 `pnpm dev:preview`，打开 [本机预览](http://127.0.0.1:1421/apps/design-preview/)。Python 3 只在回环地址提供静态文件。

入口有 [邮箱演示](index.html)、[交互审阅](review.html) 和 [品牌与主题](directions.html)。`pnpm --filter @lofold/design-preview build` 产出 `dist/`。保留整个目录，双击产物中的 `apps/design-preview/index.html` 可离线使用。
