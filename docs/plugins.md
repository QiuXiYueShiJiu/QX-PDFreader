# 主题插件市场

这里的每个包只包含**颜色令牌**。客户端不接受代码、不下载可执行文件，所以第三方包能做的只有改变配色。

- 机器读的清单：[`plugins/index.json`](../plugins/index.json)
- 单包文件：[`plugins/<id>.json`](../plugins/)
- 客户端拉取顺序：镜像站 `contact/plugins.php` → 失败时回落 GitHub raw

raw 地址：

```
https://raw.githubusercontent.com/QiuXiYueShiJiu/QX-PDFreader/main/plugins/index.json
```

## 已收录

| id | 名称 | 版本 | 作者 | 说明 |
|---|---|---|---|---|
| `qinglan` | 青岚 | 1.0.0 | 秋夕月拾旧 | 青绿冷调的护眼配色：低饱和、低对比，长晚自习看久了眼睛不酸 |

## 包格式

```json
{
  "id": "qinglan",
  "name": "青岚",
  "version": "1.0.0",
  "author": "秋夕月拾旧",
  "desc": "一句话说明，≤ 120 字",
  "theme": {
    "accent": "#2f7d6d",
    "bg": "#eef5f2",
    "surface": "#f8fbfa",
    "text": "#20302c",
    "muted": "#5d746e",
    "border": "#cfe0da",
    "readerBg": "#e7f0ec"
  }
}
```

`index.json` 里的一条是同一个包去掉外层包装后的样子，颜色已归一成 `R G B`：

```json
{
  "ok": true,
  "updatedAt": "2026-10-23T01:43:40Z",
  "count": 1,
  "items": [
    {
      "id": "qinglan",
      "name": "青岚",
      "version": "1.0.0",
      "author": "秋夕月拾旧",
      "desc": "……",
      "theme": {
        "accent": "47 125 109",
        "bg": "238 245 242",
        "surface": "248 251 250",
        "text": "32 48 44",
        "muted": "93 116 110",
        "border": "207 224 218",
        "readerBg": "231 240 236"
      }
    }
  ]
}
```

## 七个颜色键

| 键 | 用在哪 |
|---|---|
| `accent` | 主色：按钮、选中、进度条 |
| `bg` | 窗口底色 |
| `surface` | 卡片、侧栏、工具条 |
| `text` | 正文 |
| `muted` | 次要文字、图标 |
| `border` | 分割线、描边 |
| `readerBg` | 阅读区纸张底色 |

## 提交方式

1. Fork 仓库；
2. 新增 `plugins/<id>.json`（见上方格式）；
3. 在 `plugins/index.json` 的 `items` 里追加同构条目，`count` 加一，`updatedAt` 改成当前 UTC 时间；
4. 提 PR，描述里写清配色意图（什么场景、什么光线下好看），最好附一张实际截图。

## 校验规则

客户端与镜像站共用同一套校验，不合规的条目会被直接跳过，不会污染界面：

- 颜色必须是 `R G B` 三段 0–255 的整数，或 `#rrggbb`；
- 七个键缺一不可，缺任何一个整条丢弃；
- `id` 用小写字母、数字与连字符，`name` ≤ 40 字，`desc` ≤ 120 字；
- 不带脚本、可执行文件、外链图片、令牌；市场只负责配色。

## 镜像站

镜像站与 GitHub 同构输出。GitHub 更新后，镜像站需在服务器上跑一次同步任务才会反映新内容；如果你在 PR 里加了包而线上暂时看不到，属于缓存滞后，不是没合进去。
