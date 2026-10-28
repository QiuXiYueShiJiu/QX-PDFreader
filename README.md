# 秋夕-PDF阅读器

<p align="center">
  <img src="docs/screenshots/01-main.png" alt="主界面" width="960" />
</p>

<p align="center">
  <b>一台面向课堂的本地 PDF 阅读器</b><br />
  批注 · 画笔 · 改字 · 扫描页 OCR · PDF 工具箱 · 13 档配色 · 触屏友好 · 零上传
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-2.0.0.0-2f6fed" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4" />
  <img alt="license" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-e5484d" />
  <img alt="offline" src="https://img.shields.io/badge/network-%E5%8F%AA%E6%A3%80%E6%9F%A5%E6%9B%B4%E6%96%B0-16a34a" />
</p>

---

## 目录

- [这是什么](#这是什么)
- [功能总览](#功能总览)
- [界面与截图](#界面与截图)
- [安装](#安装)
- [快捷键](#快捷键)
- [触屏与触控笔](#触屏与触控笔)
- [隐私说明](#隐私说明)
- [技术栈与构建](#技术栈与构建)
- [目录结构](#目录结构)
- [测试与回归](#测试与回归)
- [许可](#许可)
- [常见问题](#常见问题)
- [更新日志](#更新日志)

---

## 这是什么

一个**完全离线**的 Windows PDF 阅读与课堂标注工具。打开即读、随手就画，为「老师在教室一体机上讲题、学生在教室电脑上改错」而设计：

- **本地文件，零上传**：不往任何服务器传文档；只有「检查更新」「主题商店」「插件商店」会访问 GitHub / 镜像站。
- **上栏管文档、下栏管手上**：顶部是 Office 式单条功能区（文件 / 开始 / 工具 / 视图，图标+文字、组名在组底），放打开、插入、页面结构、撤销重做这些**文档级**操作；画笔 / 橡皮 / 调色盘 / 粗细 / 滑动清屏收在**底部悬浮条**里，讲课抬手就能点到。左侧竖排批注与页面栏，右侧竖排视图栏（含插件商店入口），翻页与页码在功能区右端。
- **一体机友好**：按钮按触摸尺寸设计，单指拖选文字、长按选词、双指捏合缩放。
- **不止能读**：改字、改格式、涂白、贴图、OCR 扫描页、23 个 PDF 工具箱、拼版、图片查看。

---

## 功能总览

### 一、阅读与视图

| 能力 | 说明 |
|---|---|
| 连续滚动 / 单页 / 双栏并排 | 双栏从第 1 页起两两配对 |
| 适应宽度 / 适应整页 / 实际大小 | `Ctrl+0` 适应宽度，顶部与右侧都能调 |
| 缩放 | `Ctrl+滚轮`、顶部 `±`、右侧 `±`、双指捏合；25%–600% |
| 旋转 | 每次 90°，页面宽高随之互换 |
| 缩略图 / 目录 / 搜索 | 左侧三页签；点缩略图跳页，目录树直达章节 |
| 全文搜索 | `Ctrl+F`，列出命中页与上下文，点结果直达 |
| 多标签页 | 同窗口多文档，可关闭、可切换 |
| 记忆阅读位置 | 同一文件再次打开自动回到上次那页 |

### 二、批注与画笔

| 能力 | 说明 |
|---|---|
| 高亮 / 下划线 / 删除线 | 选中文字后点浮条，落笔生效 |
| 便签 | 页面任意位置贴一条可展开批注 |
| 自由画笔 | 多档预设色 + 色环自选，粗细滑杆 |
| 橡皮 | 点选或划擦删除笔迹与图形 |
| 形状 | 矩形、椭圆，拖拽绘制，可改颜色与线宽 |
| 图片 | 本地选图贴到页面，可拖动、缩放、旋转 |
| 直线 / 箭头 | 按下拖一条线，松手得到直线或带箭头的指示线，方向不丢，可改颜色线宽 |
| 填充 / 虚线 | 矩形和椭圆可加半透明填充（底下的字仍看得清），四种图形都能改成虚线描边 |
| 涂白 | 白底覆盖旧内容，再写新内容 |
| 撤销 / 重做 / 清空 | 覆盖批注与内容编辑两类操作 |
| 滑动清屏 | 一键隐藏批注显示，讲完再点恢复 |

### 三、选择、改字与改格式

| 能力 | 说明 |
|---|---|
| 拖选文字 | 顶栏切到「选择」后拖动；跨行、反向拖都对 |
| 长按选词 / 双击选词 | 触屏长按约 0.36 秒；鼠标双击选词 |
| 复制 | 复制当前选区 |
| 改文字 | 原位输入新文字，自动继承原字号、颜色、字重、斜体与字体 |
| 改格式 | 12 档字号（8–32）+ 6 色 |
| 高亮 / 下划线 | 选择后一键标注，坐标按字形真实几何计算 |
| 多行替换 | 选区含多行时整段替换，按原行高排布 |

### 四、扫描页 OCR

| 能力 | 说明 |
|---|---|
| 识别当前页 | 顶部溢出菜单「识别扫描页文字」，中文 + 英文 |
| 识别后可选中 | 生成透明文字层，能拖选、复制、改字 |
| 离线运行 | 引擎与语言包随安装包提供，不联网 |

### 五、PDF 工具箱（23 个卡片）

**文件级**：合并 · 拆分 · 水印 · 压缩 · 加密/解密 · 图片互转 · Office/图片转 PDF
**文档级**：页面（排序/删除/旋转/裁剪）· 页眉页脚 · 页码 · 属性 · 书签 · 附件 · 表单填写 · 建表单 · 签名 · 归档(PDF/A) · 打印 · 提图 · 比较 · 批量 · 导出（Word/Excel/文本）· 遮盖

<p align="center">
  <img src="docs/screenshots/13-tools.png" alt="工具箱" width="900" /><br />
  <sub>PDF 工具箱：左侧分类，右侧点卡片开始</sub>
</p>

### 六、新建与图片

| 能力 | 说明 |
|---|---|
| 新建空白 PDF | 页数 1–200、A4/A3/Letter、横向纵向、纯白/米黄/浅灰纸色 |
| 打开图片 | `.png .jpg .jpeg .bmp .gif .webp .svg .avif` 直接当文档看 |
| 图片转 PDF 缓存 | 同一张图第二次打开走缓存（4000×3000 实测 245ms → 5ms） |
| 图片格式关联 | 安装时写入关联，可在「设置 → 默认应用」一键指定 |

### 七、外观：3 个主题包 · 13 档配色

| 主题包 | 包含配色 | 特征 |
|---|---|---|
| **默认** | 浅色 / 暖灰 / 米色 / 护眼绿 / 深色 / 深夜 / 高对比 / 纸墨 / 青梅 / 柔光 / 午夜蓝（11 档） | 圆角柔和，按钮淡阴影 |
| **Metro** | 同 11 档 | 方角切平面，自动切 Office 式功能区布局 |
| **液态玻璃** | 同 11 档 | 半透明玻璃底，可调圆角与模糊半径 |

另有**阅读区底色**（与主题解耦）、**强调色**（8 预设 + 自定义 + 每包默认）、**背景图片**（本地照片/壁纸，压暗与模糊只作用于背景）、**界面缩放** 0.8–1.6×。

<p align="center">
  <img src="docs/screenshots/26-background.png" alt="自定义背景图（已打开文件）" width="49%" />
  <img src="docs/screenshots/31-background-home.png" alt="自定义背景图（主页/未打开文件）" width="49%" />
  <br />
  <sub>自定义背景图：左＝打开文件后的阅读区；右＝主页（未打开文件）同样生效，空态卡片用半透明玻璃保证文字可读</sub>
</p>

<p align="center">
  <img src="docs/screenshots/27-themes-panel.png" alt="设置外观全貌" width="900" /><br />
  <sub>设置 → 外观：主题包、11 档配色、强调色、阅读区底色、背景图片、界面缩放</sub>
</p>

<p align="center">
  <img src="docs/screenshots/29-theme-palettes.png" alt="主题包与配色" width="900" /><br />
  <sub>设置 → 外观：主题包、配色、强调色、阅读区底色、界面布局</sub>
</p>

### 七附、每档配色的「主页 + 打开 PDF」对照

下面 26 张图按同一套操作录制：清空标签 → 拍主页 → 打开示例文档 → 拍阅读态。用来对比每档配色的层次、对比度与按钮可读性。

<details>
<summary><b>默认包 · 11 档配色</b></summary>

| 配色 | 主页（未打开文件） | 打开 PDF |
|---|---|---|
| 浅色 light | ![](docs/screenshots/themes/light-home.png) | ![](docs/screenshots/themes/light-doc.png) |
| 米色 sepia | ![](docs/screenshots/themes/sepia-home.png) | ![](docs/screenshots/themes/sepia-doc.png) |
| 深色 dark | ![](docs/screenshots/themes/dark-home.png) | ![](docs/screenshots/themes/dark-doc.png) |
| 深夜 night | ![](docs/screenshots/themes/night-home.png) | ![](docs/screenshots/themes/night-doc.png) |
| 护眼绿 forest | ![](docs/screenshots/themes/forest-home.png) | ![](docs/screenshots/themes/forest-doc.png) |
| 暖灰 warm | ![](docs/screenshots/themes/warm-home.png) | ![](docs/screenshots/themes/warm-doc.png) |
| 高对比 contrast | ![](docs/screenshots/themes/contrast-home.png) | ![](docs/screenshots/themes/contrast-doc.png) |
| 纸墨 paper | ![](docs/screenshots/themes/paper-home.png) | ![](docs/screenshots/themes/paper-doc.png) |
| 午夜蓝 midnight | ![](docs/screenshots/themes/midnight-home.png) | ![](docs/screenshots/themes/midnight-doc.png) |
| 青梅 plum | ![](docs/screenshots/themes/plum-home.png) | ![](docs/screenshots/themes/plum-doc.png) |
| 柔光 glow | ![](docs/screenshots/themes/glow-home.png) | ![](docs/screenshots/themes/glow-doc.png) |

</details>

<details>
<summary><b>Metro 包</b>（方角 + 功能区布局）</summary>

| 主页 | 打开 PDF |
|---|---|
| ![](docs/screenshots/themes/metro-home.png) | ![](docs/screenshots/themes/metro-doc.png) |

</details>

<details>
<summary><b>液态玻璃包</b>（半透明外壳 + 大圆角）</summary>

| 主页 | 打开 PDF |
|---|---|
| ![](docs/screenshots/themes/glass-home.png) | ![](docs/screenshots/themes/glass-doc.png) |

</details>

### 八、课堂模式

| 模式 | 说明 |
|---|---|
| 聚光灯 | 全屏压暗，只留可拖动光斑；双指或外缘圆点调大小 |
| 黑屏 | 整屏纯黑，讲题时只看老师 |
| 放大镜 | 圆形镜片 2.2×，镜内重绘放大画面，可拖动、可调倍率 |
| 旋转 | 90° 快速转屏 |

三种模式都支持**鼠标拖动、手指拖动、滚轮/双指缩放**，`Esc` 随时退出。

### 九、拼版印刷

把一页切成多页拼到一张纸上（N-up），或按骑马订顺序重排，适合把 A4 试卷拼成 A3 双栏打印。

### 十、更新、主题商店与插件商店

| 能力 | 说明 |
|---|---|
| 检查更新 | 设置页手动检查；启动后自动检查一次（可关） |
| 双通道 | GitHub Releases + 镜像站，自动取版本更高的一边，同版本优先镜像 |
| 下载与校验 | 下载安装包后校验 SHA256，再询问是否立即安装 |
| 紧急回滚 | 最近 3 个安装包留在本地，可一键装回旧版；设置与批注不动 |
| 主题商店 | 「设置 → 外观 → 主题商店」，浏览 / 一键装回配色包，可切 GitHub 或镜像源 |
| 插件商店 | 右栏入口，装的是能执行代码的插件；清单声明权限，没声明就拦 |
| 市场仓库 | [`plugin-store/`](plugin-store/README.md)：`index.json` 清单 + [API 规范](plugin-store/docs/API.md) + [JSON Schema](plugin-store/schema/plugin.schema.json) + [上架流程](plugin-store/docs/PUBLISHING.md) |
| 清单自检 | `node tools/check-market.mjs`（校验 id 唯一、https 直链、sha256 长度、主题枚举） |

### 十一、其它

- **PDF 文件缩略图**：装好后资源管理器直接显示 PDF 首页缩略图（原生提供器，非图标）。
- **文件图标**：PDF / PNG / JPG / JPEG / WEBP / BMP / GIF / SVG / AVIF 九种各一套。
- **插入 / 删除空白页**：功能区「插入」组的「加页」「删页」，当场加一张与上一页同尺寸的空白页、或删掉当前页；改动写在工作副本上，原 PDF 不动。
- **稳定性**：单实例锁、异常退出不丢批注、标签恢复。

---

## 界面与截图

### 主界面与阅读

| 主界面 | 单页 |
|---|---|
| ![主界面](docs/screenshots/01-main.png) | ![单页](docs/screenshots/02-single.png) |

| 双栏并排 | 目录 |
|---|---|
| ![双栏](docs/screenshots/03-facing.png) | ![目录](docs/screenshots/04-outline.png) |

| 全文搜索 | 工具箱 |
|---|---|
| ![搜索](docs/screenshots/05-search.png) | ![工具箱](docs/screenshots/13-tools.png) |

### 批注与画笔

| 高亮/下划线/删除线/便签 | 自由画笔 |
|---|---|
| ![批注](docs/screenshots/06-annotate.png) | ![画笔](docs/screenshots/07-pen.png) |

| 拖选文字 | 改文字 |
|---|---|
| ![选择](docs/screenshots/08-select.png) | ![改文字](docs/screenshots/09-edit-text.png) |

| 改格式 | 内容编辑 |
|---|---|
| ![改格式](docs/screenshots/10-format.png) | ![内容编辑](docs/screenshots/11-content-edit.png) |

### OCR 与工具箱

| 扫描页 OCR | 水印设置 |
|---|---|
| ![OCR](docs/screenshots/12-ocr.png) | ![水印](docs/screenshots/14-tools-advanced.png) |

### 课堂模式

| 聚光灯 | 黑屏 |
|---|---|
| ![聚光灯](docs/screenshots/15-spotlight.png) | ![黑屏](docs/screenshots/16-blackboard.png) |

| 放大镜 |
|---|
| ![放大镜](docs/screenshots/17-magnifier.png) |

### 设置与更新

| 外观设置 | 阅读设置 |
|---|---|
| ![设置外观](docs/screenshots/18-settings-appearance.png) | ![设置阅读](docs/screenshots/19-settings-reading.png) |

| 检查更新 | 插入 / 删除空白页 |
|---|---|
| ![更新](docs/screenshots/20-update.png) | ![页面](docs/screenshots/21-page-edit.png) |

### 主题与布局

| 深色 | 米色 |
|---|---|
| ![深色](docs/screenshots/22-theme-dark.png) | ![米色](docs/screenshots/23-theme-sepia.png) |

| Metro | 液态玻璃 |
|---|---|
| ![Metro](docs/screenshots/24-theme-metro.png) | ![玻璃](docs/screenshots/25-theme-glass.png) |

| 自定义背景图 | Office 式布局 |
|---|---|
| ![背景图](docs/screenshots/26-background.png) | ![Office 布局](docs/screenshots/28-office-layout.png) |

---

### 主题商店、插件商店与分屏

| ![](docs/screenshots/32-plugin-store.png) | ![](docs/screenshots/34-plugin-installed.png) |
|---|---|
| **插件商店 · 发现**：清单来自 GitHub（可切镜像），可搜索排序，安装前能看到它要哪些权限 | **插件商店 · 已装**：每个插件能停用 / 卸载，权限逐条列出 |
| ![](docs/screenshots/33-compare.png) | ![](docs/screenshots/18-settings-appearance.png) |
| **分屏对比**：右半区是只读参考窗，跟左半区各滚各的 | **设置 → 外观**：主题商店入口在「主题包」下面 |

## 安装

### 两个版本怎么选

| | 标准版 | 快速版 |
|---|---|---|
| 安装方式 | 向导（可选目录与快捷方式） | 一路到底静默装好 |
| 适合 | 自己电脑、需要挑安装位置 | 教室一体机、批量部署 |
| 文件名 | `秋夕-PDF阅读器-2.0.0.0-安装程序.exe` | `PDF阅读器-快速安装.exe` |

### 安装步骤

1. 双击安装包，按向导下一步（标准版可改安装目录）。
2. 安装目录默认在 D 盘，装好后桌面与开始菜单都有快捷方式。
3. 想成为 PDF/图片的默认打开程序：**设置 → 应用 → 默认应用 → 按文件类型指定**，选「秋夕-PDF阅读器」。

### 静默安装（批量部署）

```bat
PDF阅读器-快速安装.exe /S
```

### 校验安装包

```powershell
Get-FileHash .\秋夕-PDF阅读器-2.0.0.0-安装程序.exe -Algorithm SHA256
```

---

## 快捷键

| 按键 | 作用 |
|---|---|
| `Ctrl+O` | 打开文件 |
| `Ctrl+F` | 搜索 |
| `Ctrl+0` | 适应宽度 |
| `Ctrl++` / `Ctrl+-` | 放大 / 缩小 |
| `←` `→` / `PageUp` `PageDown` | 上一页 / 下一页 |
| `Home` / `End` | 首页 / 末页 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Esc` | 退出笔 / 橡皮 / 选择 / 课堂模式 |
| `Ctrl+W` | 关闭当前标签 |

---

## 触屏与触控笔

- 单指：拖动平移；「选择」工具下拖动选字。
- 长按约 0.36 秒：选一个词；继续拖动扩大到下一个词。
- 双击：选词（「选择」工具下不再触发缩放）。
- 双指：捏合缩放；课堂模式下调光斑/镜片大小。
- 触控笔：落笔即画，笔杆按钮可临时变橡皮（取决于驱动）。
- 浮条按钮在触屏上放宽到 40px 以上，避免点不中。

---

## 隐私说明

- **不联网也能用**：阅读、批注、OCR、工具箱全部本地完成。
- **不上传文档**：没有账号、没有云端同步、没有埋点。
- **唯一的网络请求**：检查更新、主题商店与插件商店的清单，只下载版本信息、配色清单与安装包。
- **本地数据目录**：`%APPDATA%\秋夕月拾旧-PDF阅读器`（设置、批注、最近文件、图片缓存、更新下载）。
- **卸载会清理**：卸载程序会删除上述数据目录与文件关联。

---

## 技术栈与构建

| 层 | 使用 |
|---|---|
| 运行时 | Electron 33 |
| 界面 | React 18 + TypeScript + zustand |
| PDF | pdfjs-dist 4.10（渲染/文字层）、pdf-lib 1.17（生成/编辑/导出） |
| OCR | tesseract.js（chi_sim + eng，离线） |
| 构建 | electron-vite 2.3 + electron-builder 25 |
| 缩略图 | 原生 COM 处理器（`native/shell-thumb`） |

```bat
npm install
npm run typecheck
npm run build
node scripts\build-installers.mjs
```

产物在 `release\`。

---

## 目录结构

```
src/
  main/           主进程：窗口、IPC、文件、更新、缩略图注册
  preload/        contextBridge：window.pdfApp
  renderer/       React 界面（组件、样式、store）
  shared/         主进程与渲染层共享的类型与默认设置
native/shell-thumb/  原生 PDF 缩略图提供器（C++）
tools/            截图、回归用例、各道自检闸门
build/            图标、NSIS 脚本、打包配置
docs/             示例文档与截图
```

---

## 测试与回归

仓库带一套真实驱动的回归用例（CDP 驱动隐藏窗口）：

```bat
node tools\run-verify-suite.mjs --dev 9411
```

覆盖 30 余支：渲染与缩放、文字层对齐、双栏配对、标签页、搜索、批注、画笔、橡皮、选择、改文字、换格式、OCR、工具箱、拼版、新建空白 PDF、主题包（13 档）、课堂模式、触屏手势、退出流程等。

另外几道自检闸门：

```bat
node tools\check-privacy.mjs      :: 公开树无内部路径/单位名称/凭据
node tools\check-readme.mjs       :: README 版本与截图引用一致
node tools\check-licenses.mjs     :: 依赖许可无强传染
```

---

## 许可

本项目采用 **PolyForm Noncommercial License 1.0.0**：

- ✅ 个人学习、教学、非商业项目：免费使用与修改
- ⚠️ 商业用途需单独授权
- 📄 再分发请保留 `LICENSE`、`NOTICE`、`SOURCE.txt` 与 `THIRD-PARTY-NOTICES.md`

---

## 常见问题

**Q：为什么第一次打开大图有点慢？**
A：首次要把图片封装成 PDF 再渲染，之后走缓存（同一张图 5ms 左右）。

**Q：PDF 文件图标 / 缩略图没变？**
A：Windows 有图标缓存。装好后若仍是旧图标，注销一次或重启资源管理器即可；缩略图需要「查看 → 中等图标/大图标」以上。

**Q：怎么把 PDF 设成默认打开方式？**
A：`设置 → 应用 → 默认应用 → 按文件类型指定` 选「秋夕-PDF阅读器」。Windows 10/11 不允许程序静默抢默认。

**Q：批注会丢吗？**
A：批注存在本地数据目录并随文档自动保存；异常退出后重开会恢复。导出的 PDF 会把批注烧进页面。

**Q：能读加密 PDF 吗？**
A：工具箱「加密」可以加/解密码；带打开密码的 PDF 需先解密再读。

---

## 更新日志

### 2.0.0（2026-10-28）

- **主题商店与插件商店分家**：主题（配色包）入口在「设置 → 外观 → 主题商店」；插件商店留在右侧竖排栏，面板分「发现 / 已装」两页，可搜索、排序、看权限、停用与卸载。
- **第三方插件体系**：插件包 `.qxplugin`（zip + manifest.json），跑在主进程沙箱里，权限必须在清单里声明（读文档、写文件、联网、弹窗、改设置），没说就拦。装完当场可用，命令出现在功能区「开始」的「插件」组。
- **分屏对比**：右半区开第二个 PDF 做只读参考窗，左右各滚各的；上栏「对比」按钮与标签右键两个入口，导出 / 打印 / OCR 仍按左侧主文档。
- **紧急回滚**：更新时保留最近 3 个安装包，设置页可一键回滚到任意旧版；同一版本不允许回滚；连续两次启动失败会主动问要不要回滚。
- **右栏永不滚动**：按窗口高度自动降档（藏文字标签、缩按钮），极矮窗口把翻页与缩放收进浮层，右栏本身不再出现滚动条。
- **图片工具改浮层面板**：入口从右侧悬浮按钮搬到功能区「工具 → 图片处理」，面板可拖动、不挡阅读区。
- **标题栏修好了**：Metro 主题下窗口标题栏不再变成浅底白字；强调色偏浅时前景色会自动转深。
- **设置简化**：去掉形同虚设的「界面布局」开关（现在只有 Office 式一种），正式版不再出现任何特殊版本的说明文字。
- 验证体系扩到 **40 支**：新增插件商店、分屏对比、紧急回滚、右栏高度分档、图片浮层、主题商店清单、商店分类与详情七支用例，全绿。

### 1.9.0（2026-10-27）

- **上栏 Office 功能区 + 下栏画笔悬浮条**：上栏是单条功能区（文件 / 开始 / 工具 / 视图，组内「图标 + 文字」、组名在组底，宽度不够先降密度、再逐项收进「更多」菜单，也能整体收起成细带），只放文档级操作；**画笔 / 橡皮 / 调色盘 / 粗细 / 滑动清屏**全部搬到屏幕底部的悬浮条，讲课抬手就点到，不再和文档操作挤在一起。
- **右栏换成插件商店**：右栏去掉「工具箱」入口（工具都在上栏「工具」选项卡里），空出来的位置给「插件商店」——默认从 GitHub 拉清单，连不上或想更快时可在面板右上角切到镜像源。
- **插入 / 删除空白页**：开始 页 插入 组新增 加页 删页，改动写在工作副本上，原文件不动。
- **直线 / 箭头**：插入 组新增两种手绘图形，按下拖一条线，松手得到直线或带箭头的指示线；方向按归一化端点保存（横线、竖线、斜线都不会被压成同一个框），可改颜色与线宽，选中后能拉伸。
- **填充 / 虚线**：矩形与椭圆可加约 22% 不透明度的填充（圈重点时原文仍读得清），矩形、椭圆、直线、箭头都能改成虚线描边；两个开关既作用于下一笔，也立刻改掉当前选中的图形。
- **主题包换包重置**：切换主题包时圆角 / 模糊 / 面板透明度跟随新包的出厂形态（修掉「切到 Metro 圆角还是 14px」）；同一个包里换配色仍保留你调好的值。
- **启动声明浮层已移除**：不再弹「免费与非商业许可」提示卡片，许可信息统一看 `LICENSE` 与本文档。
- **验证体系扩到 33 支**：新增页面结构编辑、直线 / 箭头用例；四支自适应 / 视图 / 主题包 / 画笔用例全部按新功能区契约重写。
- 修复：标签打开工作副本时显示哈希文件名；连续插页会叠加上一次的副本。

### 1.0.9.0（2026-10-26）

- **工具条拆分**：顶部改 Office 式「备课」工具带（选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆 / 撤销重做），底部独立「授课」悬浮胶囊（漫游 / 画笔 / 橡皮 / 颜色 / 粗细），胶囊底色与描边随主题实时变化。
- **主题成对展示**：13 档配色 × 2 状态（主页 / 打开 PDF）共 26 张截图，见 §七附。
- **插件市场仓库**：新增 `plugin-store/`（清单、Schema、API、上架流程）与 `tools/check-market.mjs`。
- **安装包与文档**：公开树敏感词兜底、README 全量重写、四道闸门（privacy/readme/market/licenses）。
- 编辑类工具按「开始 / 插入 / 颜色 / 画笔 / 编辑」分组
- 顶部工具带按钮与图标颜色跟随主题
- 更新通道参数改为构建期注入，公开源码零端点、零凭据
- 修复连续滚动到页界会「突然跳一页」
- 批注浮条配色跟随主题
- PDF 文件缩略图（原生提供器）随安装注册

### 1.0.8.2

- 新增拼版（N-up）印刷
- 图片格式支持（png/jpg/bmp/gif/webp/svg/avif），带缓存
- 新建空白 PDF（页数/纸张/方向/纸色）
- 4 档新配色 + Office 2019 式布局

### 1.0.7.x

- 13 档配色与 3 个主题包（默认 / Metro / 液态玻璃）
- 液态玻璃去背景模糊改渐变，滚动更顺
- 每格式文件图标与图片图标重做

### 1.0.6.x

- 双通道更新（GitHub + 镜像）
- 启动声明浮层、隐私清理、打包流程拆分