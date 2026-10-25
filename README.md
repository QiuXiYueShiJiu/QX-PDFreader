# 秋夕-PDF阅读器

> 面向课堂与自习的**本地 PDF 阅读器**：批注、画笔、选中改字、扫描页 OCR、PDF 工具箱、触摸操作，一屏之内全部离线完成。

<p align="center">
  <img src="docs/screenshots/01-main.png" alt="主界面" width="920" />
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4" />
  <img alt="electron" src="https://img.shields.io/badge/Electron-33-47848F" />
  <img alt="react" src="https://img.shields.io/badge/React-18-61DAFB" />
  <img alt="version" src="https://img.shields.io/badge/version-1.0.8.2-2E7D32" />
  <img alt="license" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange" />
</p>

---

## 这是什么

一个装在教室一体机或办公电脑上的 PDF 阅读器。它不追求「什么格式都能开」，而是把**上课与批注真正会做的事**做顺：

- 一边投影一边在原文上画重点、写批注；
- 学生做错的那句话，**直接改成正确表述**（不是贴便签盖住）；
- 试卷是扫描件、没有文字层时，**识别一遍就能选中、复制、修改**；
- 老师用手直接点、长按、拖，不必先找鼠标；
- 备课要合并、拆分、加水印、导 Word/Excel，不必再装第二个软件。

文档、批注、OCR 全部在本机完成，**不上传文件**；只有「检查更新」会访问 GitHub 或镜像站。

---

## 这一版新增（1.0.8.2）

- **资源管理器里直接看到 PDF 首页**：安装后在资源管理器的「大图标 / 超大图标」视图下，PDF 会显示自己的首页缩略图（Windows 原生缩略图提供器，按文件修改时间与大小缓存，换页即失效重渲染）
- **连续滚动不再「到页界跳一下」**：修正翻到页边界时的定位抖动
- **批注浮条跟随主题**：浮条颜色随当前主题包变化，不再是固定深色
- **若干隐私与文案清理**：仓库与安装包里不再出现内部部署信息

## 功能总览

### 零、新建文档（1.0.7.0 新增）

- 顶部「新建」直接生成空白 PDF：**1~200 页**、A4 / A3 / Letter、纵向 / 横向、纯白 / 米黄纸 / 浅灰
- 建完就是新标签，原文档不动

### 一、阅读

| 能力 | 说明 |
|---|---|
| 三种视图 | 单页 / 连续滚动 / **双栏**（第 1 页起两两配对，像翻开的书） |
| 缩放 | 适应宽度、适应整页、实际大小、连续缩放、`Ctrl` + 滚轮、触屏双指捏合，最高 600% |
| 页面导航 | 左侧缩略图、文档目录（PDF 书签）、页码直达、上一页 / 下一页、右侧竖排翻页 |
| 全文搜索 | `Ctrl + F`，结果按页列出并高亮，点一条直接跳过去 |
| 多标签 | 一次打开多份文档，标签可拖动排序，关闭前提示未导出编辑 |
| 旋转 | 90° 循环旋转，画布与文字层同步 |
| 主题 | **3 个主题包、13 档配色**：默认包 11 档（亮色 / 暖灰 / 米黄护眼 / 护眼绿 / 深色 / 深夜蓝 / 高对比 等）、Metro（直角扁平）、**液态玻璃**（半透明磨砂 + 可调圆角与模糊）。每包独立记住设置，三包共用 8 色强调色预设 + 取色器；另可选 **Office 2019 布局** |
| 记忆 | 记住上次阅读位置、最近文件、界面缩放 |
| 自动更新 | 静默检查 **GitHub Releases 与镜像站（并行取较新者）**，查到即提示并自动下载，装不装由你决定；设置页可只用 GitHub / 只用镜像站，也能手动检查 |

### 二、批注与画笔

- **文字批注**：高亮、下划线、删除线、便签，多色可选；
- **自由画笔**：压感笔迹、荧光笔、直线、矩形 / 椭圆、箭头、文字标注、插图；
- **橡皮**：像真实橡皮一样**局部擦除**，大小可调，不整笔删除；
- **撤销 / 重做 / 一键清空**：清空也可撤销；
- **漫游模式**：画面放大后拖动浏览，不误建批注。

### 三、选择与改字（本版重点）

选中原文 → 浮出工具条 → **复制 / 改文字 / 格式 / 高亮 / 下划线**：

- **自动继承原文字号、颜色、字体、粗细、斜体**，改完几乎看不出接缝；
- **多行替换**：一次替换整段，按行逐行遮盖，保留换行与段落；
- **改格式**：12 档字号（8–32）+ 6 种颜色，原位替换、不叠加白块；
- **导出即烘焙**：批注与编辑结果写进「导出为新 PDF」，源文件不动。

### 四、扫描页 OCR

- 一键识别当前页（简体中文 + 英文）；
- 识别结果是**真正的文字层**：可选中、可复制、可**直接改文字**；
- 首次识别约 3–5 秒，同一页可重复识别；
- 语言包与 wasm 引擎随安装包分发，运行时不下载任何东西。

### 五、PDF 工具箱（23 张工具卡）

| 分组 | 工具 |
|---|---|
| 文件级处理 | 合并、拆分、水印（中文/平铺）、压缩、加密与解密、PDF ↔ 图片、Word/Excel/PPT → PDF |
| 文档级编辑 | 页面整理（排序/删除/旋转/裁剪）、页眉页脚与页码、贝茨编号、属性与元数据、书签、附件、表单填写、创建表单、签名、归档 PDF/A、打印、提图、**两份 PDF 比较**、批量处理、导出 Word / Excel、**安全遮盖（永久删除）** |

### 六、课堂辅助

- **聚光灯**：只照亮指针附近，引导注意力；
- **黑屏**：讲评时压暗屏幕，让学生抬头；
- **放大镜**：局部放大正文，小字号教材也能看清；
- 退出统一按 `Esc`，或再点一次右侧按钮；
- **触屏**：单指拖动光圈 / 镜头、双指捏合调大小、外缘圆点精调；遮罩上拖动不会把底下的 PDF 滚走，拖到页面边缘也不会出现白圈。

### 七、触摸

- 长按 360ms 选词、双击选词、拖动扩选；
- 一按就拖＝平移页面（带惯性），轻点灰底取消选区；
- 双指捏合缩放，缩放锚点跟着手指走；
- 左右两侧工具条按拇指可达范围排布，粗指针下按钮加大到 42px 以上。

### 八、文件关联与右键菜单

图片文件同样可以双击打开：.png / .jpg / .jpeg / .webp / .bmp / .gif / .svg / .avif 都注册到本软件（每种格式一套图标）。同一张图第二次打开走缓存，实测 4000×3000 从 245ms 降到 5ms。

- 安装后双击 **PDF** 与 **图片**（png / jpg / jpeg / webp / bmp / gif / svg / avif）都能直接打开；
- 只为没有默认程序的扩展名登记关联，不动你原来设好的默认程序；
- 卸载时连同关联键一起清掉，不留空壳。

### 九、第一版体验

- 启动时右下角一条**声明浮层**：本软件免费提供、早期版本 bug 较多、有问题请联系作者；可关闭，也可勾「知道了，不再提示」永久隐藏。

---

## 界面与功能截图

> 截图均取自标准版（1.0.7.0），隐藏窗口 + 1800×1125 视口，未做任何后期修改。

### 阅读与导航

| 主界面（连续滚动 + 缩略图） | 单页视图 |
|---|---|
| ![主界面](docs/screenshots/01-main.png) | ![单页](docs/screenshots/02-single.png) |

| 双栏视图（第 1 页起两两配对） | 文档目录（PDF 书签） |
|---|---|
| ![双栏](docs/screenshots/03-facing.png) | ![目录](docs/screenshots/04-outline.png) |

| 全文搜索（结果直接跳页） | PDF 工具箱首页（23 张工具卡） |
|---|---|
| ![搜索](docs/screenshots/05-search.png) | ![工具箱](docs/screenshots/13-tools.png) |

### 批注、画笔与选择

| 高亮 / 下划线 / 删除线 / 便签 | 画笔手写（三色压感笔迹） |
|---|---|
| ![批注](docs/screenshots/06-annotate.png) | ![画笔](docs/screenshots/07-pen.png) |

| 选中文字浮条 | 改文字（自动继承字号颜色） |
|---|---|
| ![选择](docs/screenshots/08-select.png) | ![改文字](docs/screenshots/09-edit-text.png) |

| 改格式（12 档字号 + 6 色） | 内容编辑物件（涂白 / 矩形 / 椭圆 / 文字 / 图片） |
|---|---|
| ![改格式](docs/screenshots/10-format.png) | ![内容编辑](docs/screenshots/11-content-edit.png) |

### OCR 与工具箱

| 扫描页 OCR（识别后可直接选中修改） | 工具箱详情：水印（中文、平铺、旋转） |
|---|---|
| ![OCR](docs/screenshots/12-ocr.png) | ![水印](docs/screenshots/14-tools-advanced.png) |

### 设置与更新

| 设置 · 外观（3 个主题包 + 13 档配色 + 强调色 + 背景图 + 界面缩放） | 设置 · 阅读（缩放 / 位置 / 快捷键） |
|---|---|
| ![设置外观](docs/screenshots/18-settings-appearance.png) | ![设置阅读](docs/screenshots/19-settings-reading.png) |

| 发现新版本（自动下载后可一键安装） | 启动声明浮层 |
|---|---|
| ![更新](docs/screenshots/20-update.png) | ![声明](docs/screenshots/21-disclaimer.png) |

### 课堂遮罩（触屏可拖）

| 聚光灯（光圈内保持亮度） | 黑屏（讲评时全屏压暗） |
|---|---|
| ![聚光灯](docs/screenshots/15-spotlight.png) | ![黑屏](docs/screenshots/16-blackboard.png) |

| 放大镜（洞内跟随放大） | 画笔手写（三色压感笔迹） |
|---|---|
| ![放大镜](docs/screenshots/17-magnifier.png) | ![画笔](docs/screenshots/07-pen.png) |

### 主题（13 档配色 / 3 个主题包）

> **1.0.7.0 重做**：先选主题包，再在包内挑配色——**默认包 11 档** / **Metro**（直角扁平）/ **液态玻璃**（半透明磨砂 + 可调圆角 0~24px、模糊 0~30px）。每个包单独记住自己的设置（默认包记配色、Metro 记强调色、玻璃包记圆角与模糊）。另有 **Office 2019 布局**（方角、竖排图标 + 文字、accent 下划线页签）可在设置 → 界面布局切换。

| 暗色 | 米黄护眼（默认） |
|---|---|
| ![暗色](docs/screenshots/22-theme-dark.png) | ![护眼](docs/screenshots/23-theme-sepia.png) |

| Metro（直角扁平） | 液态玻璃（半透明磨砂 + 可调圆角/模糊） |
|---|---|
| ![Metro](docs/screenshots/24-theme-metro.png) | ![液态玻璃](docs/screenshots/25-theme-glass.png) |

| 自定义图片背景（可调压暗与模糊） | 设置 · 外观（三个主题包 + 13 档配色 + 强调色） |
|---|---|
| ![背景图](docs/screenshots/26-background.png) | ![主题面板](docs/screenshots/27-themes-panel.png) |

| Office 2019 布局（方角 / 竖排图标 + 文字 / accent 下划线页签） | 13 档配色总览 |
|---|---|
| ![Office 布局](docs/screenshots/28-office-layout.png) | ![配色总览](docs/screenshots/29-theme-palettes.png) |

## 插件市场（主题扩展包）

除了内置的 13 档配色，还可以从**插件市场**装第三方配色。市场只下发颜色值，不下发代码。

**两个源，同一份 schema**：优先镜像站 `contact/plugins.php`，失败自动回落到
`raw.githubusercontent.com/QiuXiYueShiJiu/QX-PDFreader/main/plugins/index.json`。
只在**打开市场面板时**拉一次清单（10 分钟缓存），不随启动联网。

| 收录 | 作者 | 说明 |
|---|---|---|
| 青岚 `qinglan` | 秋夕月拾旧 | 青绿冷调护眼配色，低饱和低对比 |

包格式（`plugins/<id>.json`，颜色写 `R G B` 或 `#hex`）：

```json
{
  "id": "qinglan",
  "name": "青岚",
  "version": "1.0.0",
  "author": "秋夕月拾旧",
  "desc": "一句话说明，120 字以内",
  "theme": {
    "accent": "#2f7d6d", "bg": "#eef5f2", "surface": "#f8fbfa",
    "text": "#20302c", "muted": "#5d746e", "border": "#cfe0da",
    "readerBg": "#e7f0ec"
  }
}
```

提交一个主题包：① 加 `plugins/<id>.json`；② 在 `plugins/index.json` 的 `items` 里加同一条
（颜色归一成 `R G B`）；③ `count` +1；④ 提 PR。合并后客户端下次打开市场即可看到。

校验规则：七色齐全、`R G B` 每段 0–255、`id`/`name` 非空、`desc` ≤ 120 字；
任一条不合法会被服务器与客户端**双向丢弃**（面板里不会出现半个坏包）。

---

## 下载与安装

到本仓库的 **Releases** 页面下载：

- 文件名：`秋夕-PDF阅读器-1.0.8.2-安装程序.exe`
- 双击安装，可自选安装目录；
- 「选择附加任务」页可分别勾选**桌面快捷方式**与**开始菜单快捷方式**（默认都勾，开始菜单统一放在「秋夕-教学软件」文件夹）；
- 静默安装（批量部署）：`秋夕-PDF阅读器-1.0.8.2-安装程序.exe /S`
- 校验：同一 Release 附有 `SHA256SUMS.txt`，可用 `certutil -hashfile 秋夕-PDF阅读器-1.0.8.2-安装程序.exe SHA256` 对比。

系统要求：Windows 10 / 11（x64）。安装包未做代码签名，首次运行若出现 SmartScreen 提示，选择「更多信息 → 仍要运行」。

> **卸载提醒**：卸载会一并删除 `%APPDATA%\秋夕月拾旧-PDF阅读器` 下的用户数据（阅读位置、最近文件、批注）。需要保留请先备份该目录。

---

## 快速上手

1. 打开 PDF：`Ctrl + O`，或把文件拖进窗口；
2. 左侧选「选择」→ 在文字上拖动（触屏长按）→ 浮出工具条；
3. 点「改文字」→ 输入新内容 → 回车或点「替换」；
4. 想标重点就直接点「高亮 / 下划线」；想手写就切「画笔」；
5. 扫描件点顶部溢出菜单「识别扫描页文字」，识别完就能选中文字；
6. 备课要合并、加水印、导 Word：点顶栏「工具箱」；
7. 讲评时用右侧「聚光 / 黑屏 / 放大镜」，退出按 `Esc`。

### 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl + O` | 打开 PDF |
| `Ctrl + F` | 搜索全文 |
| `Ctrl + 0` / `Ctrl + +` / `Ctrl + -` | 适应宽度 / 放大 / 缩小 |
| `Ctrl + R` | 顺时针旋转 90° |
| `Ctrl + S` | 打开设置 |
| `Ctrl + Z` / `Ctrl + Y` | 撤销 / 重做 |
| `←` / `→`、`PageUp` / `PageDown` | 上一页 / 下一页 |
| `Esc` | 退出当前工具 / 遮罩 / 关闭面板 |

---

## 隐私

- **文档不上传**：PDF 的打开、渲染、批注、OCR 全在本机完成；
- **不收集**：没有账号、没有埋点、没有崩溃上报；
- **联网只有两类，都可关**：① 启动后（设置里可关）与设置页手动的「检查更新」，只取 GitHub Releases 与本项目镜像站的版本信息；② 打开插件市场面板时拉一次主题清单（10 分钟缓存，先镜像站、失败回落 GitHub raw）。两类请求都不带文档内容、账号或机器标识；
- **数据位置**：最近文件、阅读位置、批注、设置都在 `%APPDATA%\秋夕月拾旧-PDF阅读器`，删掉即恢复初始状态。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 33（单窗口 + 多标签，隐藏窗口可跑完整回归） |
| 界面 | React 18 + TypeScript + zustand |
| 构建 | electron-vite 2 + electron-builder 25 |
| 渲染 | pdf.js 4（`TextLayer` 文字层 + canvas 画布） |
| 导出 / 工具箱 | pdf-lib + @cantoo/pdf-lib + fontkit，docx / xlsx 自研 writer |
| OCR | tesseract.js 5（简中 + 英文语言包，本地 wasm） |

### 目录结构

```
├─ src
│  ├─ main          Electron 主进程（窗口、IPC、文件、更新、PDF 工具）
│  ├─ preload       上下文隔离的桥（window.pdfApp）
│  ├─ shared        主/渲染共享类型与工具实现
│  └─ renderer      界面：DocumentView、AnnotationLayer、edit/*、ocr/*、components/advanced/*、store
├─ tools            回归脚本（CDP 驱动隐藏窗口，27 支）
├─ scripts          构建 / 打包 / 版本 / 资源复制 / 交付打包
├─ build            图标、NSIS 安装器模板、打包参数
├─ tests/fixture    测试用 PDF
└─ docs             截图与示例文档
```

---

## 从源码构建

需要 Node.js 22+ 与 Windows 10/11。

```powershell
npm install
npm run dev                         # 开发运行
npm run build                       # 产出 out/
node scripts\build-installers.mjs   # 打包安装程序
```

安装目录、品牌文案、快捷方式命名等交付参数在 `build/packaging.json`，构建脚本会把它渲染进 NSIS 安装器脚本（`build/installer.nsh.in`）。

## 回归测试

套件用 CDP 驱动**隐藏窗口**跑真实交互（鼠标 / 触摸 / 滚轮事件都是原生注入，不是合成 DOM 事件），共 27 支：

```powershell
node tools\check-licenses.mjs                # 许可证闸门
node tools\run-verify-suite.mjs --dev 9401   # 全量（约 6 分钟）
node tools\run-verify-suite.mjs --dev 9401 verify-select.mjs   # 单支
```

---

## 许可证

本项目使用 **PolyForm Noncommercial License 1.0.0**（PNC 1.0）：

- ✅ 个人使用、学习、研究、非营利教学——随便用，可以改；
- ✅ 可以 fork、二次开发，用于教学与非商业用途；
- ❌ **不得用于商业用途**（随硬件销售、付费培训、商业产品内置、SaaS 等）；
- 商业授权请通过 Issues 联系作者。

完整条款见 [LICENSE](LICENSE)；版权与第三方组件声明见 [NOTICE](NOTICE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

> PolyForm Noncommercial 不是 OSI 认可的开源协议：源码公开可读、可改，但商业使用需要另行授权。

## 第三方组件

Electron、React、pdf.js、pdf-lib、tesseract.js 等组件的版权与许可证声明见 `THIRD-PARTY-NOTICES.md`。

## 免责声明

本软件按「现状」提供，不附带任何明示或暗示的担保。因使用本软件造成的任何数据丢失或损失，作者不承担责任。请自行备份重要文档与批注。

---

<p align="center"><sub>秋夕月拾旧 · 2026</sub></p>
