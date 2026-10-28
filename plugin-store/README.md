# 秋夕-PDF阅读器 · 插件市场（Plugin Store）

> **⚠ 先读这段（2026-10-27）**
>
> 本仓库下面写的是**安装包式**市场：清单条目带 `download` / `sha256` / `size`，阅读器下载 zip 再安装。
>
> **已发布的 1.9.0.0 还没实现这套**。1.9.0.0 的市场是**配色值式**：清单条目直接带七个配色值
> （`theme.accent/bg/surface/text/muted/border/readerBg`），阅读器校验通过后把它写成一份「自定义主题」
> 并切到 `theme=custom`（`src/renderer/src/store.ts` 的 `installTheme`、校验在
> `src/renderer/src/market-validate.ts` 的 `normalizeMarketItem`）。
>
> 换句话说：**照安装包式去改线上清单，会让 1.9.0.0 的市场变空白**（每条都因缺 `theme` 配色被整条丢弃）。
> 1.9.0.0 的真实硬规则见 [`静态托管规范.md`](./静态托管规范.md) 的「第 0 节」。
> 安装包式（本文件与 `docs/API.md` 描述的这套）是 **1.9.1+ 的规划**，等客户端真做了「下载 zip 装主题包」再启用。

本仓库只放**清单与规则**，不放可执行代码。阅读器通过 HTTPS 拉取 `index.json`，
按条目下载主题包 / 插件包（zip），校验 SHA-256 后再安装。

## 目录

```
index.json                 # 唯一清单入口（阅读器默认拉这个）
schema/plugin.schema.json  # 条目结构（JSON Schema 2020-12）
docs/API.md                # 接口与字段约定
docs/PUBLISHING.md         # 上架流程
packages/<id>/<version>/   # 可选：由维护者托管的包体（也可用 Release 附件直链）
```

## 这是什么

- **主题包**：一套 `theme` / `themeLayout` / 调色凭据 + 可选背景图，安装后出现在「设置 → 外观」。
- **功能插件**：目前占位（`kind: "plugin"`）。阅读器只做“下载 → 校验 → 落盘”，
  不执行第三方代码，避免引入任意代码执行面。

## 安全与隐私

- 清单与包体都走**普通 HTTPS 静态文件**，不带任何凭据（内置凭据通道只用于官方部署发行版，不在本仓库）。
- 阅读器只信任 `index.json` 里显式的 `https://` 直链，拒绝 `file:`、`javascript:`、本地地址。
- 每个包必须给 `sha256` 与 `size`，校验不过直接丢弃并提示。
- 不收集任何用户信息；不做统计上报。

## 许可

- 清单与文档：CC BY 4.0
- 主题包与其资源：随包声明的许可，缺省为 PolyForm Noncommercial 1.0.0
