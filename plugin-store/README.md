# 秋夕-PDF阅读器 · 插件市场（Plugin Store）

本仓库只放**清单与规则**，不放可执行代码。阅读器通过 HTTPS 拉取市场托管方的 `index.json`，
按条目下载主题包 / 插件包（zip），校验 SHA-256 后再安装。

## 目录

```
index.example.json         # 清单样例（改字段前对着它抄；线上文件名为 index.json）
schema/plugin.schema.json  # 条目结构（JSON Schema 2020-12）
docs/API.md                # 接口与字段约定
docs/PUBLISHING.md         # 上架流程
packages/<id>/<version>/   # 可选：由维护者托管的包体（也可用 Release 附件直链）
```

## 这是什么

- **主题包**：一套 `theme` / `themeLayout` / 调色变量 + 可选背景图，安装后出现在「设置 → 外观」。
- **功能插件**：目前占位（`kind: "plugin"`）。阅读器只做“下载 → 校验 → 落盘”，
  不执行第三方代码，避免引入任意代码执行面。

## 安全与隐私

- 清单与包体都走**普通 HTTPS 静态文件**，不带任何校验值（内置校验值通道只用于官方静默部署发行版，不在本仓库）。
- 阅读器只信任清单里显式的 `https://` 直链，拒绝 `file:`、`javascript:`、本地地址。
- 每个包必须给 `sha256` 与 `size`，校验不过直接丢弃并提示。
- 不收集任何用户信息；不做统计上报。

## 许可

- 清单与文档：CC BY 4.0
- 主题包与其资源：随包声明的许可，缺省为 PolyForm Noncommercial 1.0.0
