# 插件市场 API

> **状态（2026-10-28）**：本文即客户端 **2.0.0.0** 的实现契约。1.9.0.0 及更早的「配色值式」清单已废弃。

阅读器与市场之间只有三个约定：**清单地址**、**清单结构**、**包体校验**。

## 1. 清单

```
GET {marketBase}/index.json
Accept: application/json
```

- 必须 HTTPS，`Content-Type: application/json; charset=utf-8`，UTF-8 编码。
- 建议 `Cache-Control: max-age=300`，阅读器本地另有 10 分钟缓存与「手动刷新」。
- 允许镜像：阅读器内置的镜像站会聚合 GitHub 与自有托管，返回同构 JSON。

响应：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-26T03:00:00Z",
  "count": 3,
  "items": [
    {
      "id": "theme-light-moon",
      "kind": "theme",
      "name": "清月（浅色）",
      "version": "1.0.0",
      "author": "秋夕月拾旧",
      "summary": "浅色纸感 + 靛蓝强调色，适合白天与投影。",
      "homepage": "https://github.com/QiuXiYueShiJiu/QX-PDFreader",
      "download": "https://example.com/packages/theme-light-moon/1.0.0.zip",
      "sha256": "8f14e45fceea167a5a36dedd4bea2543...（64 位十六进制）",
      "size": 184320,
      "tags": ["浅色", "纸感"],
      "minAppVersion": "1.0.9.0",
      "license": "PolyForm-Noncommercial-1.0.0",
      "theme": {
        "theme": "paper",
        "themeLayout": "normal"
      }
    }
  ]
}
```

字段约束见 `schema/plugin.schema.json`。要点：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 全局唯一，`^[a-z0-9][a-z0-9-]{2,63}$`，上架后不可改 |
| `kind` | 是 | `theme` / `plugin` |
| `name` | 是 | 展示名，≤ 40 字 |
| `version` | 是 | 语义化版本 `MAJOR.MINOR.PATCH` |
| `summary` | 是 | 一句话，≤ 80 字 |
| `download` | 是 | `https://` 直链，必须直出 zip（不接受 HTML 页面） |
| `sha256` | 是 | 包体 SHA-256（小写十六进制） |
| `size` | 是 | 包体字节数（用于进度与上限判断） |
| `minAppVersion` | 否 | 低于此版本不展示安装按钮 |
| `theme` | kind=theme 时必填 | `{ theme, themeLayout }`，与设置页枚举一致 |

## 2. 包体

- 格式：zip（UTF-8 文件名），根目录必须有 `manifest.json`：

```json
{
  "id": "theme-light-moon",
  "version": "1.0.0",
  "kind": "theme",
  "appMin": "1.0.9.0",
  "files": [{ "path": "theme.json", "sha256": "..." }]
}
```

- 主题包 `theme.json`：`{ "theme": "paper", "themeLayout": "normal", "tokens": { "--bg": "244 240 232" } }`
- 包体积上限：10 MB（主题包一般 < 2 MB，含背景图另算，上限 20 MB）。

## 3. 校验与失败处理

1. 下载完成先算 `sha256`，不符 → 删除临时文件，提示「校验失败，已取消安装」。
2. `size` 与实际字节数不符 → 同上。
3. `id` 已安装且版本相同 → 提示已安装；版本更高 → 走「更新」。
4. 解析 `manifest.json` 失败 → 提示「包结构不正确」。

## 4. 兼容与迁移

- `schemaVersion` 目前为 `1`。新增字段**只能可选**；破坏性改动用新版本号并在阅读器侧按版本分支解析。
- 阅读器对未知字段**忽略**，不报错。

## 5. 参考实现

`index.json` 就是一个静态文件。可以放在任意静态托管（GitHub Pages / 对象存储 / 反向代理），
阅读器设置页「商店地址」可改成自定义 `marketBase`（`settings.marketBase`）。
