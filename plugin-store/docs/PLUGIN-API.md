# 插件运行时 API（`.qxplugin`）

> 版本：客户端 **2.0.1.0** 起。本文是实现契约，与 `src/main/plugins.ts` 一一对应。
> 市场清单协议见 [API.md](./API.md)；类型声明见 [`../schema/qxplugin.d.ts`](../schema/qxplugin.d.ts)。

## 0. 两种扩展，别混

| | 主题包（theme） | 插件（plugin） |
|---|---|---|
| 能做什么 | **只换配色**，纯数据 | **执行代码**，调用受控 API |
| 入口 | 设置 → 外观 → 主题商店 | 右栏 → 插件商店 |
| 包内文件 | `manifest.json` + `theme.json` | `manifest.json` + `main.js` |
| 权限 | 无（不执行代码） | 五项，见 §3 |
| 风险 | 无 | 可读写文件 / 联网，安装前请核对权限 |

## 1. 包结构

`.qxplugin` 就是一个 zip，根目录必须平铺（不要多套一层目录）：

```
my-plugin.qxplugin
├── manifest.json     必需
├── main.js           必需（或 manifest.main 指定的文件名）
└── icon.png          可选，64×64，商店列表里显示
```

## 2. manifest.json

```json
{
  "id": "my-word-counter",
  "name": "字数统计",
  "version": "1.0.0",
  "author": "某某",
  "description": "统计当前页字数并弹窗显示",
  "minAppVersion": "2.0.1.0",
  "permissions": ["document.read", "ui.dialog"],
  "main": "main.js"
}
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9._-]{1,63}$`，全局唯一，装过之后不要改（改了等于另一个插件） |
| `name` | ✅ | 展示名，建议 ≤ 20 字 |
| `version` | ✅ | 语义化版本 `MAJOR.MINOR.PATCH` |
| `author` | | 作者署名 |
| `description` | | 一句话说明，商店详情页显示 |
| `minAppVersion` | | 低于此版本的客户端不加载 |
| `permissions` | | 不写 = 无任何权限，见 §3 |
| `main` | | 入口文件名，默认 `main.js` |
| `icon` | | 图标文件名 |

## 3. 五项权限

**不声明就调不了**：调用时直接抛错，错误信息带插件 id 与权限名，用户在弹框里能看到是谁越权。

| 权限 | 放行什么 | 具体行为 | 风险提示 |
|---|---|---|---|
| `document.read` | 读当前文档 | `document.getPath()` / `document.getText()` | 会拿到文件路径与当前页全文 |
| `files.write` | 写文件 | `files.save(name, content)`，**必须走系统保存对话框** | 只能写到用户亲自选的路径 |
| `network` | 联网 | `net.fetchText(url)`，只允许 `http/https` | 请求经系统代理与证书链 |
| `ui.dialog` | 弹原生框 | `ui.notify()` / `ui.confirm()` | 插件不能自绘窗口，只能用系统对话框 |
| `settings.write` | 读写设置 | `settings.get()`；**`set()` 当前未开放**，会抛错 | 本版只读 |

> 当前版本 `settings.set()` 是显式未开放的桩：调用会抛
> 「修改设置需要在界面上显式确认，当前版本尚未开放写入」。写声明时不要依赖它。

## 4. 运行时对象 `api`

入口 `main.js` 必须导出 `activate(api)`：

```js
module.exports = {
  activate(api) {
    api.commands.register({
      id: 'count',
      label: '统计字数',
      run() {
        const text = api.document.getText()
        api.ui.notify(`当前页 ${text.replace(/\s/g, '').length} 字`)
      }
    })
  }
}
```

### 4.1 `api.manifest`

只读快照：`{ id, name, version, permissions }`。**不要**试图改它。

### 4.2 `api.document` — 需 `document.read`

| 方法 | 返回 | 说明 |
|---|---|---|
| `getPath()` | `string` | 当前文档路径；未打开文档时为空串 |
| `getText()` | `string` | 当前页纯文本（由渲染层在翻页时推送） |

### 4.3 `api.files` — 需 `files.write`

| 方法 | 返回 | 说明 |
|---|---|---|
| `await save(defaultName, content)` | `string` | 弹保存对话框后写入 UTF-8 文本；用户取消返回 `''` |

只能写文本，不支持二进制；路径由用户在选择框里决定，插件无法指定。

### 4.4 `api.net` — 需 `network`

| 方法 | 返回 | 说明 |
|---|---|---|
| `await fetchText(url)` | `string` | 只接受 `http(s)`，非 2xx 抛 `HTTP <code>`，返回 body 文本 |

没有 `fetch`、没有 `XMLHttpRequest`——沙箱里也没有 `require`，网络只能走这里。

### 4.5 `api.ui` — 需 `ui.dialog`

| 方法 | 返回 | 说明 |
|---|---|---|
| `notify(message)` | `void` | 原生信息框，单个「好」按钮 |
| `await confirm(message)` | `boolean` | 原生「取消 / 确定」，确定返回 `true` |

### 4.6 `api.settings` — 需 `settings.write`

| 方法 | 返回 | 说明 |
|---|---|---|
| `get()` | `object` | 当前返回空对象（接口占位） |
| `set()` | — | **抛错**，本版未开放 |

### 4.7 `api.commands`

| 方法 | 说明 |
|---|---|
| `register({ id, label, run })` | 注册命令，出现在上栏「工具」选项卡的「插件」组 |

- 命令的全局 id 是 `<插件 id>:<你的 id>`，不会和别的插件撞名；
- 三个字段缺一不可，`run` 必须是函数；
- `run` 抛错时，客户端会弹原生框问「禁用还是重试」，选重试只重试一次。

## 5. 沙箱边界（重要）

插件运行在 `node:vm` 上下文里，注入的全局只有：

```
module / exports / console / api / setTimeout / clearTimeout
```

**没有** `require`、`process`、`fetch`、`document`、`window`、`Buffer`。
所以：不能用 npm 包、不能读环境变量、不能直接碰 DOM、不能起子进程。

- 入口代码同步执行有 **5 秒超时**，超时直接判加载失败；
- `console.*` 会带上 `[plugin:<id>]` 前缀输出到主进程日志；
- 加载失败（清单坏了 / 代码抛异常）不会崩应用，插件被标记为错误并在商店里显示原因。

## 6. 调试

1. 把插件目录放进 `%APPDATA%\秋夕月拾旧-PDF阅读器\plugins\<id>\`
   （`manifest.json` 与 `main.js` 平铺在这一层）；
2. 重启应用，主进程日志里会出现 `[plugin] 已加载 <id>@<version>`；
3. 改完代码需要重启应用才会重新加载（当前版本不做热重载）。

## 7. 版本兼容承诺

- 新增 API 一律**只增不改**；已有方法的签名不变。
- 破坏性变更会提升 `minAppVersion` 并在本文档标注迁移说明。
- 客户端遇到 `manifest.json` 里不认识的字段会忽略，不报错。
