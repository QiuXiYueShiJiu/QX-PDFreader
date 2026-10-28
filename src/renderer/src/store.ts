// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 阅读器的全局状态。
 *
 * ★ 规则（违反会导致 React #185 无限循环）：
 *   zustand 选择器**绝不能返回新建的对象或数组**，否则每次比较都不相等。
 *   需要派生数据时选原始字段，或在组件内用 useMemo 计算。
 */

import { create } from 'zustand'
import { normalizeMarketList } from './market-validate'
import {
  CONTENT_ANNOTATION_TYPES,
  type Annotation,
  type AnnotationRect,
  type AnnotationType,
  type EditTool,
  type ReaderSettings,
  type RecentFile,
  type Tab,
  type ViewMode,
  type ZoomSpec
} from '@shared/types'
import { DEFAULT_SETTINGS, themePackOf } from '@shared/settings'

/** 更新检查结果（渲染层只用到这几个字段） */
/**
 * 一条主题包（清单 index.json / 服务器 plugins.php 的 items[] 子集）。
 *
 * 2.0.0 起清单能带的不只是七个颜色：主题包形态、背景图、预览图、版本门槛。
 * 全部可选 —— 只有七个颜色是硬要求，少一个整条丢弃；可选项坏了就当没写，
 * 这样老的清单（1.9.0.0 时代只有配色）照样能用。
 */
export interface MarketItem {
  id: string
  name: string
  version?: string
  author?: string
  desc?: string
  /** 分类（商店左侧筛选用），缺省归入「其它」 */
  category?: string
  tags?: string[]
  /** 商店卡片上的效果图 */
  preview?: string
  minAppVersion?: string
  theme: {
    accent: string
    bg: string
    surface: string
    text: string
    muted: string
    border: string
    readerBg: string
  }
  /** 主题包形态：装了以后连圆角/模糊/面板透明度一起换 */
  pack?: {
    radius: number
    blur: number
    panelAlpha: number
    shadow?: string
    toolbarHeight?: number
    gap?: number
  }
  /** 阅读区背景图（下载后存本地，靠 sha256 校验） */
  background?: { url: string; sha256?: string; size?: number }
}
/**
 * 已安装插件（渲染层只关心展示用的字段，目录与 manifest 细节留在主进程）。
 */
export interface InstalledPluginLike {
  id: string
  name: string
  version: string
  author: string
  description: string
  permissions: string[]
  enabled: boolean
  error?: string
}

/** 插件商店里的一条（独立插件库 index.json 的 items[]） */
export interface PluginShopItem {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  download: string
  sha256?: string
  size?: number
  minAppVersion?: string
  permissions?: string[]
  icon?: string
  /** 分类（商店筛选用） */
  category?: string
  tags?: string[]
  /** 详情页的效果图，可多张 */
  preview?: string[]
  /** 插件对宿主的要求，例如 node 版本、网络权限以外的依赖 */
  requires?: string[]
  /** 这个插件依赖的其它插件 id */
  deps?: string[]
  /** 版本历史（详情页显示），新→旧 */
  versions?: { version: string; date?: string; note?: string }[]
}

/** 插件注册的命令（上栏「工具 → 插件」组用） */
export interface PluginCommandLike {
  id: string
  label: string
  pluginId: string
}

export interface UpdateInfo {
  ok: boolean
  newer: boolean
  current: string
  latest: string
  /** 结果来自哪条通道：github / mirror / special */
  source?: 'github' | 'mirror' | 'special'
  page?: string
  notes?: string
  publishedAt?: string
  asset?: { name: string; size: number; url: string; sha256?: string; token?: string; source?: string }
  error?: string
  others?: Array<{ source: 'github' | 'mirror' | 'special'; latest: string }>
}

export interface UpdateProgress {
  received: number
  total: number
  /** 0~1；total 未知时为 -1 */
  fraction: number
}

import {
  encodeStroke,
  splitStrokeByEraser,
  strokesInEraser,
  toStrokeShape
} from './ink-engine'

/**
 * 缩放规格：三种自适应 + 自定义倍数。
 *
 * 定义已挪到 `@shared/types`（标签页记录也要用它，而标签页类型在
 * shared 里），这里保留一行 re-export，免得全仓库的 import 路径大改。
 */
export type { ZoomSpec } from '@shared/types'

/**
 * 撤销栈深度上限。
 *
 * 每个快照是一份批注数组的浅拷贝（笔迹的点数组不复制），
 * 单份课件几十笔的量级下开销很小。50 步足够覆盖一节课的误操作，
 * 又不至于让内存无限增长。
 */
const HISTORY_LIMIT = 50

/**
 * 压入一步历史。
 *
 * 抽成独立函数是因为它需要同时改 history 与清空 future ——
 * 任何新操作都必须让「重做」失效，否则会出现
 * 「撤销后做新操作，还能重做回旧分支」的错误状态。
 */
function pushHistory(state: { annotations: Annotation[] }): void {
  const prev = useViewer.getState().history
  useViewer.setState({
    history: [...prev, state.annotations].slice(-HISTORY_LIMIT),
    future: []
  })
}

/* ---------- 标签页 ---------- */

/**
 * 标签 id 的自增序号。
 *
 * 不用文件路径当 id：同一份文件允许被打开两次（对比两个位置时很有用），
 * 用路径当 key 会让第二次打开把第一次的记录顶掉。
 */
let tabSeq = 0

/** 需要暂存/恢复的字段（切标签时整体搬来搬去的那几项） */
interface TabSnapshot {
  tabs: Tab[]
  activeTabId: string
  page: number
  zoom: ZoomSpec
  annotations: Annotation[]
  exportDirty: boolean
}

/**
 * 把「当前激活文档」的状态写回它的标签记录。
 *
 * ★ 为什么必须有这一步：
 *   store 里只有一份当前文档状态（filePath/page/zoom/annotations）。
 *   切标签前不存回去，切走再切回来就只剩空壳 —— 页码回到第 1 页、
 *   缩放回到默认，**批注直接消失**（批注是会话内状态，不落盘）。
 */
function stashActiveTab(state: TabSnapshot): Tab[] {
  if (!state.activeTabId) return state.tabs
  return state.tabs.map((tab) =>
    tab.id === state.activeTabId
      ? {
          ...tab,
          page: state.page,
          zoom: state.zoom,
          annotations: state.annotations,
          exportDirty: state.exportDirty
        }
      : tab
  )
}

/**
 * 连续擦除的合并窗口（毫秒）。
 *
 * 橡皮拖动时每秒会产生几十次擦除。若每次都压历史栈：
 *   · 50 步的栈只够擦 1 秒就满
 *   · 用户按撤销只回退极小一步，要按几十次才看得出变化
 * 因此窗口内的连续擦除**只压第一次** ——
 * 一次「按住拖动擦」在撤销时算作一步。
 *
 * 250ms 是折中：短于人手两次独立点击的间隔（不会把两次
 * 有意的擦除误并成一步），又远长于拖动时的帧间隔。
 */
const ERASE_COALESCE_MS = 250

/** 上次为擦除压栈的时间戳 */
let lastErasePushAt = 0

/**
 * 碎片 id 的自增序号。
 *
 * ── 为什么不能只用「原 id + 起点下标」──────────────────────
 *   同一条笔迹被反复擦除时，第二次擦出的碎片起点下标
 *   可能与第一次相同，拼出的 id 就撞了 ——
 *   表现为 React 列表 key 重复（渲染错乱）、
 *   以及命中判定取到错误的那一段。
 *   加一个全局自增序号即可保证全局唯一。
 */
let fragmentSeq = 0

interface ViewerState {
  /* ---------- 已打开的文档 ---------- */
  filePath: string
  fileName: string
  fileSize: number
  pageCount: number
  /** 当前页（1 起） */
  page: number
  /** 缩放规格 */
  zoom: ZoomSpec
  /** 实际缩放倍数（由组件测量后回填，状态栏显示用） */
  actualScale: number
  viewMode: ViewMode
  /** 顺时针旋转角度：0 / 90 / 180 / 270 */
  rotation: number
  /** 加载中提示（null 表示空闲） */
  loading: string | null
  /** 错误提示 */
  error: string | null

  /* ---------- 界面 ---------- */
  settings: ReaderSettings
  recent: RecentFile[]
  showSidebar: boolean
  showRightPanel: boolean
  showSettings: boolean
  /**
   * PDF 工具箱面板是否打开。
   *
   * 与 showSettings 分开：两者都是右侧抽屉，但内容完全不同，
   * 同时打开会互相遮挡；App 里保证「开其中一个就关掉另一个」。
   */
  showTools: boolean
  /**
   * 主题商店是否打开。
   *
   * 2026-10-28 起「主题商店」和「插件商店」彻底分家（用户第 2、7 条）：
   *   · 主题商店 = 配色包/主题扩展，入口在「设置 → 外观」里；
   *   · 插件商店 = 能执行代码的插件，入口在右栏。
   * 两者内容、权限、风险完全不同，混在一个面板里既误导用户也没法分权。
   */
  showThemeStore: boolean
  /** 插件商店是否打开（右栏入口） */
  showPluginStore: boolean
  /** 图片工具浮层（2026-10-28 起入口在上栏「工具」选项卡，不再是右侧悬浮按钮） */
  showImageTools: boolean
  /** 主题商店清单（配色包），null 表示还没拉过 */
  marketItems: MarketItem[] | null
  marketError: string
  /** 已安装插件（来自主进程扫描，含启用状态与加载错误） */
  installedPlugins: InstalledPluginLike[]
  /** 插件注册的命令，上栏「工具 → 插件」组照它渲染 */
  pluginCommands: PluginCommandLike[]
  /** 安装/卸载进行中，按钮转圈防连点 */
  pluginBusy: boolean
  /** 插件操作结果提示（成功/失败文案） */
  pluginNote: string
  /** 还留着的旧安装包（回滚用） */
  rollbackVersions: { version: string; path: string; size: number; savedAt: string }[]
  /** 分屏对比：右侧参考窗是否打开 */
  compareOpen: boolean
  /** 参考窗里的文件路径（空串 = 还没选文件） */
  comparePath: string
  /** 插件商店清单（发现页），null 表示还没拉过 */
  pluginShopItems: PluginShopItem[] | null
  pluginShopError: string
  /** 插件商店清单来源：github 默认 / mirror 镜像 */
  pluginShopSource: 'github' | 'mirror'
  /** 插件商店加载中 + 正在装哪一条 */
  pluginShopLoading: boolean
  pluginInstalling: string
  /**
   * 启动声明是否已在**本次启动**里被关掉。
   *
   * 与 settings.disclaimerHidden 分开存：
   *   · disclaimerHidden = 勾了「知道了，不再提示」，写进 settings.json，永久生效
   *   · disclaimerDismissed = 只点了 ×，仅本次会话生效（重启后还会出现）
   */
  disclaimerDismissed: boolean

  /* ---------- 版本更新 ---------- */
  /**
   * 查到的更新信息（null = 还没查/没查到）。
   *
   * 类型用结构化最小集，不 import 主进程模块：渲染层只关心
   * 「有没有新版本 / 版本号 / 安装包信息 / release 页面」。
   */
  updateInfo: UpdateInfo | null
  /** 下载进度（received/total 字节，fraction<0 表示总大小未知） */
  updateProgress: UpdateProgress
  /** 下载阶段：idle 未开始 / downloading / ready 下好了 / error */
  updateStage: 'idle' | 'downloading' | 'ready' | 'error'
  /** 下好的安装包路径（ready 后可用） */
  updateFile: string
  /** 本次会话已把浮层关掉 */
  updateDismissed: boolean
  /** 查找栏是否展开 */
  showSearch: boolean
  /**
   * 左侧栏当前显示哪个标签页。
   *
   * 为什么放到 store 里：这个值原先由 Sidebar 内部的 useState 持有，
   * 结果工具栏的「搜索」按钮只能改 showSearch，切不动标签页 ——
   * 用户点了没反应。把它提上来之后，任何组件都能切标签页。
   */
  sidebarTab: 'thumbnails' | 'outline' | 'search'
  /**
   * 「请把焦点给搜索框」的信号。
   *
   * 用自增计数而不是布尔值：布尔值从 false 变 true 只触发一次，
   * 用户连点两次搜索按钮时第二次不会有任何变化，输入框不会重新聚焦。
   * 每次自增都会让依赖它的 effect 重跑。
   */
  searchFocusTick: number
  /** 搜索关键词与结果数（结果统计由 viewer 回填） */
  searchQuery: string
  searchHits: number
  searchIndex: number
  /** 全局提示（如「已复制」） */
  toast: string

  /* ---------- 批注 ---------- */
  /** 当前文档的全部批注（按页排序） */
  annotations: Annotation[]
  /**
   * 撤销栈 / 重做栈。
   *
   * 存的是「某一步操作之前的完整批注列表」。
   * 用快照而不是反向操作：实现简单、不会漏掉边界情况，
   * 代价是内存 —— 由 HISTORY_LIMIT 兜住。
   */
  history: Annotation[][]
  future: Annotation[][]
  /** 手绘模式：开启后指针在页面上画笔迹，而不是选中文字 */
  drawMode: boolean
  /** 画笔颜色与粗细 */
  drawColor: string
  drawWidth: number
  /**
   * 橡皮模式：手绘时点中已有笔迹即擦除该条。
   *
   * 与「撤销」的区别：撤销只能回退最后一笔，橡皮可以精确删掉任意一笔。
   * 课堂上讲错一处时，橡皮比反复撤销更直接。
   */
  eraserMode: boolean
  /**
   * 橡皮大小（像素容差）。
   *
   * 决定「点多准才算命中」：小号适合精细地挑掉一小段，
   * 大号适合快速扫掉整片。触屏上手指粗，有大小可选才实用。
   */
  /** 橡皮半径（屏幕像素，3~48） */
  eraserSize: number
  /**
   * 每支笔各自的设置记忆。
   *
   * ── 为什么需要 ──────────────────────────────────────────────
   *   画笔和橡皮共用「颜色/粗细」这两个字段，
   *   但它们关心的是不同东西：画笔关心颜色和线宽，
   *   橡皮只关心大小（半径）。
   *   来回切换时若不记住，用户每次切回画笔都要重设颜色与粗细 ——
   *   一堂课下来要重复几十次。
   *
   * ── 实现方式 ────────────────────────────────────────────────
   *   切换时把当前设置存进**离开那支笔**的槽位，
   *   再从**进入那支笔**的槽位恢复。
   *   两个槽位互相独立，因此画笔的红色细线不会被橡皮改掉。
   */
  penMemory: { color: string; width: number }
  /** 橡皮的设置记忆（只有大小） */
  eraserMemory: { size: number }
  /**
   * 课堂辅助遮罩：off 关闭 / black 黑屏 / spotlight 聚光灯 / magnifier 放大镜。
   *
   * 这三个功能借鉴自鸿合 π6 的「教辅工具」（实测确认可用）。
   * 放在 store 而不是组件局部状态，是因为它们要覆盖整个窗口，
   * 且退出时可能需要被其它地方（快捷键、设置）统一控制。
   */
  maskMode: 'off' | 'black' | 'spotlight' | 'magnifier'

  /* ---------- 动作 ---------- */
  init: () => Promise<void>
  /**
   * 打开文件。
   *
   * 浏览器语义：这个文件已经在某个标签里 → 切过去（不开第二个）；
   * 否则**新开一个标签**，并把当前标签的页码/缩放/批注暂存起来。
   */
  openFile: (filePath: string, page?: number, titleName?: string) => Promise<void>
  pickFile: () => Promise<void>

  /* ---------- 页面结构编辑（插入空白页 / 删除本页） ---------- */
  /**
   * 在当前页前面插入一张空白页。
   *
   * 页面结构只能改 PDF 本体，而阅读器又是「按文件渲染」的，所以流程是：
   * 主进程在 userData/pages 里改工作副本 → 关掉当前标签 → 重开副本，
   * 页码落到新插入的那一页。原文件不会被改动，用户要留存就用「导出 PDF」。
   */
  insertBlankPage: () => Promise<void>
  /** 删除当前页（最后一页不允许删，主进程会拒绝） */
  deleteCurrentPage: () => Promise<void>
  /** 页面结构编辑后重开文档用的内部方法（不做用户提示，只负责换标签） */
  reopenActiveTab: (
    filePath: string,
    page: number,
    titleName: string,
    expectedPages?: number
  ) => Promise<void>

  /* ---------- 标签页 ---------- */
  /** 已打开的标签（按打开顺序，第一个在最左） */
  tabs: Tab[]
  /** 当前激活的标签 id（空串 = 一个标签都没有） */
  activeTabId: string
  /** 切到指定标签（先把当前标签的状态暂存回记录，再恢复目标标签） */
  switchTab: (id: string) => void
  /**
   * 关闭指定标签。
   *
   * 这里**不做未保存确认** —— 确认与「保存/不保存/取消」的交互在 App 层，
   * store 只负责把状态收拾干净（见 App 的 onCloseTab）。
   */
  closeTab: (id: string) => void
  /** 关闭当前标签（供 Ctrl+W 用） */
  closeActiveTab: () => void
  closeFile: () => void
  setPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  setZoom: (zoom: ZoomSpec) => void
  zoomIn: () => void
  zoomOut: () => void
  rotate: (delta: number) => void
  setViewMode: (mode: ViewMode) => void
  /**
   * OCR 请求计数（v2.1.3）。
   *
   * 为什么用计数器而不是布尔开关：用户可能对同一页连着点两次识别
   * （第一次没认出想要的内容）。布尔开关第二次不会变化，
   * DocumentView 的 effect 就不会再触发；计数器每次都变，天然可重入。
   */
  ocrRequest: number
  requestOcr: () => void
  setActualScale: (scale: number) => void
  setLoading: (text: string | null) => void
  setError: (text: string | null) => void

  toggleSidebar: () => void
  toggleRightPanel: () => void
  setShowSettings: (v: boolean) => void
  /** 打开 / 关闭 PDF 工具箱（与设置面板互斥，见 App） */
  setShowTools: (v: boolean) => void
  /** 打开 / 关闭主题商店（入口在「设置 → 外观」，与插件商店分家） */
  setShowThemeStore: (v: boolean) => void
  /** 打开 / 关闭插件商店（右栏入口） */
  setShowPluginStore: (v: boolean) => void
  setShowImageTools: (v: boolean) => void
  /** 重新扫描已安装插件 + 取命令表 */
  loadPlugins: () => Promise<void>
  /** 执行一条插件命令（失败时主进程已弹过「禁用 / 重试」） */
  runPluginCommand: (commandId: string) => Promise<void>
  /** 弹文件选择框安装 .qxplugin */
  installPlugin: () => Promise<void>
  /** 卸载插件 */
  uninstallPlugin: (pluginId: string) => Promise<void>
  /** 启用 / 停用插件（重启后生效） */
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>
  /** 清掉插件提示 */
  clearPluginNote: () => void
  /** 刷新可回滚版本列表 */
  loadRollback: () => Promise<void>
  /** 回滚到指定版本 */
  applyRollback: (version: string) => Promise<void>
  /** 打开分屏对比（可带路径） */
  openComparePane: (filePath?: string) => void
  /** 打开分屏但先不选文件（拖到右半区时用） */
  closeComparePane: () => void
  /** 拉插件商店清单*/
  loadPluginShop: () => Promise<void>
  /** 换插件商店清单来源并立刻重拉 */
  setPluginShopSource: (s: 'github' | 'mirror') => Promise<void>
  /** 从商店装一条（下载 + 校验 + 安装） */
  installPluginFromShop: (item: PluginShopItem) => Promise<void>
  /** 卸载后刷新商店里的已装标记 */
  refreshPluginShop: () => Promise<void>
  /** 拉取市场清单（失败只记文案，不抛） */
  loadMarket: () => Promise<void>
  /** 切换插件市场清单来源（github 默认 / mirror 镜像），切完立刻重拉 */
  setMarketSource: (source: 'github' | 'mirror') => Promise<void>
  /** 安装主题包并立刻切过去 */
  installTheme: (item: MarketItem) => Promise<void>

  /** 关掉本次启动的声明浮层（不写持久化） */
  dismissDisclaimer: () => void

  /* ---------- 更新 ---------- */
  /** 写入「查到新版本」的信息，并清掉上一次的关闭状态 */
  setUpdateInfo: (info: UpdateInfo | null) => void
  setUpdateProgress: (p: UpdateProgress) => void
  setUpdateStage: (stage: 'idle' | 'downloading' | 'ready' | 'error', file?: string) => void
  /** 关掉本次会话的更新浮层 */
  dismissUpdate: () => void
  /** 手动查一次（设置页的「检查更新」用），返回结果供界面提示 */
  checkUpdateNow: () => Promise<UpdateInfo>
  setShowSearch: (v: boolean) => void
  setSidebarTab: (t: 'thumbnails' | 'outline' | 'search') => void
  setSearchQuery: (q: string) => void
  setSearchResult: (hits: number, index: number) => void
  showToast: (text: string, ms?: number) => void

  patchSettings: (patch: Partial<ReaderSettings>) => Promise<void>
  refreshRecent: () => Promise<void>

  /* ---------- 批注动作 ---------- */
  /** 打开文档后加载该文档的批注 */
  loadAnnotations: (filePath: string) => Promise<void>
  /** 新建一条批注（生成 id 与时间戳） */
  addAnnotation: (input: {
    page: number
    type: AnnotationType
    rects: AnnotationRect[]
    color: string
    quote: string
    note: string
    /* v2.0 覆盖式编辑字段：按类型可选，见 shared/types.ts 的 Annotation */
    text?: string
    fontSize?: number
    image?: string
    strokeWidth?: number
    /** 直线 / 箭头的归一化端点（0~1，相对 rects[0]） */
    line?: [number, number, number, number]
    /** 填充色（矩形/椭圆）：rgba 串，带 22% 透明度 */
    fill?: string
    /** 虚线描边 */
    dash?: boolean
    rotation?: number
    /* v2.1.3：改文字继承原文的字体长相 */
    fontWeight?: number
    fontStyle?: 'normal' | 'italic'
    fontFamily?: string
  }) => Promise<void>
  removeAnnotation: (id: string) => Promise<void>
  updateAnnotationNote: (id: string, note: string) => Promise<void>
  /**
   * 改一条批注的任意字段。
   *
   * 用途：拖动文本框/图片位置、改字号与内容、换颜色、缩放外接框。
   * 与 updateAnnotationNote 分开是因为那个方法还带着侧栏备注的语义，
   * 混在一起会让「备注」和「内容」两处写入互相覆盖。
   */
  updateAnnotation: (id: string, patch: Partial<Annotation>) => Promise<void>
  clearAnnotations: () => Promise<void>

  /* ---------- 导出为 PDF ---------- */
  /**
   * 「有内容编辑还没导出成 PDF」。
   *
   * 批注本身是会话内状态、不落盘（见 loadAnnotations 的说明），
   * 所以关窗时真正会丢的是「还没导出」的编辑 —— 这个标志就是给
   * 主进程的关窗拦截和状态栏提示用的。
   */
  exportDirty: boolean
  /** 导出成功后清掉提示（主进程写盘成功才调） */
  markExported: () => void

  /* ---------- 手绘 ---------- */
  setDrawMode: (on: boolean) => void
  setDrawColor: (color: string) => void
  setDrawWidth: (width: number) => void
  setEraserMode: (on: boolean) => void
  setEraserSize: (size: number) => void
  /**
   * 回到「漫游」（拖动页面平移、双指/滚轮缩放）。
   *
   * ★ 工具栏恒有且只有一个功能激活：画笔 / 橡皮 / 漫游 三选一。
   *   漫游不是一个额外的开关，而是「既没在画、也没在擦」这个状态的名字，
   *   所以这里必须**同时**清掉两个开关 ——
   *   只清一个会留下 (drawMode=false, eraserMode=true) 这种谁都不激活的非法态。
   */
  setRoam: () => void

  /* ---------- 内容编辑工具（v2.0） ---------- */
  /**
   * 当前的内容编辑工具（选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆）。
   *
   * 与画笔、橡皮、漫游互斥：任何一方激活都要把另一方关掉，
   * 保证「恒有且只有一个工具在接管指针」这条不变量继续成立。
   */
  editTool: EditTool
  setEditTool: (tool: EditTool) => void
  /** 切换课堂辅助遮罩；传 'off' 关闭 */
  setMaskMode: (mode: 'off' | 'black' | 'spotlight' | 'magnifier') => void
  /**
   * 用橡皮在指定位置擦一下（半径内的笔迹按几何切段）。
   *
   * ★ 擦除是「局部」而不是「整条删除」：
   *   把笔迹看成折线，圆内的点丢弃、圆外的点保留，
   *   于是一条长笔迹会被切成若干残段 —— 与真实橡皮一致。
   *
   * 性能考量：橡皮连续拖动时这个方法会被高频调用，
   * 因此历史栈只记**操作前的快照**，且用整表浅拷贝
   * （笔迹数组本身不复制），避免每帧深拷贝大量点。
   *
   * @param page   页码（只处理该页的笔迹）
   * @param x,y    橡皮圆心（页面坐标，scale = 1）
   * @param radius 橡皮半径（页面坐标）
   * @returns 是否真的擦到了东西（用于决定要不要压历史栈）
   */
  eraseAt: (page: number, x: number, y: number, radius: number) => Promise<boolean>

  /** 撤销上一步（支持多步） */
  undo: () => void
  /** 重做 */
  redo: () => void
  /** 是否可撤销 / 可重做（驱动按钮禁用态） */
  canUndo: () => boolean
  canRedo: () => boolean
}

/**
 * 缩放档位（**当前未使用**，保留供以后做「标准比例」快捷选项）。
 *
 * zoomIn/zoomOut 已改为按百分比连续步进，不再走这张表 ——
 * 保留是因为设置面板或右键菜单以后可能要让用户直接选标准比例。
 * 用 `void` 引用一次避免「声明未使用」的编译错误。
 */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
void ZOOM_STEPS

/** 缩放上下限（与 DocumentView / useTouchGestures 保持一致） */
const ZOOM_LIMIT_MIN = 0.25
const ZOOM_LIMIT_MAX = 6

/**
 * 放大/缩小按钮的步进倍率。
 *
 * 1.15 ≈ 每按一次变化 15%。选这个值的原因：
 *   再小（如 1.05）要按十几次才明显变化，太累；
 *   再大（如 1.25）就回到原来「只能一次跳固定百分比」的问题了。
 */
const ZOOM_BUTTON_FACTOR = 1.15

let toastTimer: ReturnType<typeof setTimeout> | null = null
/** 阅读位置防抖定时器（翻页很快时不希望每次都写盘） */
let positionTimer: ReturnType<typeof setTimeout> | null = null

/** 内容编辑是否还剩脏数据：删干净了就不该再挂「未导出」提示 */
const hasContentEdits = (list: Annotation[]): boolean =>
  list.some((a) => CONTENT_ANNOTATION_TYPES.includes(a.type))

export const useViewer = create<ViewerState>((set, get) => ({
  filePath: '',
  fileName: '',
  /** 已打开的标签与当前标签（单窗口多文件，见 openFile / switchTab） */
  tabs: [],
  activeTabId: '',
  fileSize: 0,
  pageCount: 0,
  page: 1,
  zoom: 'fit-width',
  actualScale: 1,
  viewMode: 'continuous',
  /* OCR 请求计数：DocumentView 监听它的变化去识别当前页（v2.1.3） */
  ocrRequest: 0,
  rotation: 0,
  loading: null,
  error: null,

  settings: DEFAULT_SETTINGS,
  recent: [],
  showSidebar: DEFAULT_SETTINGS.showSidebar,
  showRightPanel: DEFAULT_SETTINGS.showRightPanel,
  showSettings: false,
  showTools: false,
  showThemeStore: false,
  showPluginStore: false,
  showImageTools: false,
  marketItems: null,
  marketError: '',
  installedPlugins: [],
  pluginCommands: [],
  pluginBusy: false,
  pluginNote: '',
  rollbackVersions: [],
  compareOpen: false,
  comparePath: '',
  pluginShopItems: null,
  pluginShopError: '',
  pluginShopSource: 'github',
  pluginShopLoading: false,
  pluginInstalling: '',
  disclaimerDismissed: false,
  updateInfo: null,
  updateProgress: { received: 0, total: 0, fraction: 0 },
  updateStage: 'idle',
  updateFile: '',
  updateDismissed: false,
  showSearch: false,
  sidebarTab: 'thumbnails',
  searchFocusTick: 0,
  searchQuery: '',
  searchHits: 0,
  searchIndex: 0,
  toast: '',
  annotations: [],
  /** 有内容编辑还没导出成 PDF（关窗提示 + 状态栏小圆点都看它） */
  exportDirty: false,
  /** 当前内容编辑工具（'none' = 没在编辑） */
  editTool: 'none' as EditTool,
  /** 撤销栈：每项是「某一步操作之前」的完整批注列表 */
  history: [],
  /** 重做栈：撤销时把当时的状态挪进来，做新操作时清空 */
  future: [],
  drawMode: false,
  // 默认红色中号笔：教学批注最常用红笔圈重点
  drawColor: '#e5484d',
  drawWidth: 2,
  eraserMode: false,
  /*
   * 橡皮半径默认 14px（屏幕像素）。
   * 这个值是「手指/光标感觉」的尺度，不是页面坐标 ——
   * 实际擦除时会按当前缩放换算到页面坐标，见 DocumentView。
   */
  eraserSize: 14,
  /* 两支笔的独立记忆（见接口注释） */
  penMemory: { color: '#e5484d', width: 2 },
  eraserMemory: { size: 14 },
  maskMode: 'off',

  init: async () => {
    try {
      const settings = await window.pdfApp.settings.get()
      const recent = await window.pdfApp.recent.list()
      set({
        settings,
        recent,
        showSidebar: settings.showSidebar,
        showRightPanel: settings.showRightPanel,
        zoom: settings.defaultZoom
      })
      const packSwitchPatch = applyTheme(settings)
      /* 首启用的是用户上次存的包，理论上不会触发；留着是为了「设置文件里换了包」这类边角情况 */
      if (packSwitchPatch) void get().patchSettings(packSwitchPatch)
    } catch (error) {
      console.error('[viewer] 初始化失败：', error)
    }
  },

  openFile: async (filePath, page, titleName) => {
    const before = get()

    // 已经开过这个文件：切过去，不要再开一个标签
    // （教学场景常连点两次同一个文件，开两个标签只会让人迷惑）
    const opened = before.tabs.find((t) => t.path === filePath)
    if (opened) {
      /*
       * 页面结构编辑会「关标签 → 重开工作副本」，而主进程的开文件回执有可能
       * 抢在前面，先把副本按哈希文件名建成标签。此时这里要把调用方给的名字
       * 补回去，否则标题栏会显示 `447b2a2971e5213e.pdf` 这种哈希名。
       */
      if (titleName && opened.name !== titleName) {
        set({ tabs: before.tabs.map((t) => (t.id === opened.id ? { ...t, name: titleName } : t)) })
      }
      get().switchTab(opened.id)
      return
    }

    // 先把当前标签的状态存回去，再打开新的
    const tabs = stashActiveTab(before)

    set({ loading: '正在打开…', error: null })
    const result = await window.pdfApp.open.path(filePath)
    if (!result.ok || !result.path) {
      // 打开失败：标签表保持原样，错误交给界面提示
      set({ loading: null, error: result.error ?? '打开失败', tabs })
      return
    }

    // 文档真正的加载在 DocumentView 里做，这里先记下路径
    const activeTabId = `tab-${(tabSeq += 1)}`
    set({
      tabs: [
        ...tabs,
        {
          id: activeTabId,
          path: result.path,
          name: titleName ?? result.title ?? result.path.split(/[\\/]/).pop() ?? result.path,
          page: page ?? 1,
          /*
           * ★ 每次新开文件都回到「适应宽度」。
           *   不这么做的话，上一份文档的缩放倍数（尤其是误触产生的
           *   200%/363%）会带到下一份文档，用户会觉得「一打开就是放大的」。
           */
          zoom: 'fit-width',
          annotations: [],
          exportDirty: false
        }
      ],
      activeTabId,
      filePath: result.path,
      /* 页面结构编辑打开的是哈希工作副本，界面上一律显示原文件名 */
      fileName: titleName ?? result.title ?? result.path.split(/[\\/]/).pop() ?? result.path,
      page: page ?? 1,
      zoom: 'fit-width',
      // 换文档了，上一份的批注与未保存标记不能留下
      annotations: [],
      exportDirty: false,
      searchHits: 0,
      searchIndex: 0,
      searchQuery: ''
    })
  },

  /* ---------- 页面结构编辑（插入空白页 / 删除本页） ---------- */

  /*
   * 重新打开工作副本，并停到指定页。
   *
   * 为什么不能只把 page 传给 openFile：新文档的滚动容器从顶部开始，页面节点
   * 登记完之后 DocumentView 的 IntersectionObserver 会按「可见面积最大的页」
   * 把页码覆盖成 1。实测从第 3 页插入一张空白页，插入后停在 1/21 而不是 3/21。
   * 所以这里等新文档的页数落定（= 加载完、节点登记完）再补一次 setPage，
   * 让「页码变化 → 滚动到该页」的 useLayoutEffect 真正生效。
   */
  reopenActiveTab: async (filePath, page, titleName, expectedPages) => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (tab) get().closeTab(tab.id)
    await get().openFile(filePath, page, titleName)
    if (typeof expectedPages !== 'number' || page <= 1) return
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (get().pageCount === expectedPages) break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (get().pageCount === expectedPages && get().page !== page) get().setPage(page)
  },

  insertBlankPage: async () => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    set({ loading: '正在插入空白页…' })
    const result = await window.pdfApp.pages.insertBlank(tab.path, state.page - 1)
    if (!result.ok || !result.path) {
      set({ loading: null })
      get().showToast(result.ok ? '插入失败' : result.error, 3200)
      return
    }
    /* 新页落在 result.index（0 起始），页码是 1 起始 */
    await get().reopenActiveTab(result.path, result.index + 1, tab.name, result.pages)
    set({ loading: null })
    get().showToast(`已在第 ${result.index + 1} 页插入空白页，共 ${result.pages} 页`, 2600)
  },

  deleteCurrentPage: async () => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    if (!tab) return
    set({ loading: '正在删除本页…' })
    const result = await window.pdfApp.pages.remove(tab.path, state.page - 1)
    if (!result.ok || !result.path) {
      set({ loading: null })
      get().showToast(result.ok ? '删除失败' : result.error, 3200)
      return
    }
    /* 删完之后停在被删页原来的位置（末页被删就落到新的末页） */
    await get().reopenActiveTab(result.path, result.index + 1, tab.name, result.pages)
    set({ loading: null })
    get().showToast(`已删除该页，还剩 ${result.pages} 页`, 2600)
  },

  pickFile: async () => {    const result = await window.pdfApp.open.pick()
    if (!result) return // 用户取消
    if (!result.ok || !result.path) {
      set({ error: result.error ?? '打开失败' })
      return
    }
    await get().openFile(result.path)
  },

  closeFile: () => {
    set({
      filePath: '',
      fileName: '',
      fileSize: 0,
      pageCount: 0,
      page: 1,
      error: null,
      searchHits: 0,
      searchQuery: ''
    })
  },

  /* ---------- 标签页 ---------- */

  switchTab: (id) => {
    const state = get()
    if (id === state.activeTabId) return
    const target = state.tabs.find((t) => t.id === id)
    if (!target) return

    set({
      tabs: stashActiveTab(state),
      activeTabId: id,
      filePath: target.path,
      fileName: target.name,
      page: target.page,
      zoom: target.zoom,
      annotations: target.annotations,
      exportDirty: target.exportDirty,
      loading: null,
      error: null,
      /*
       * 搜索结果属于上一份文档。不清掉的话，切过去会看到
       * 「第 3/7 个命中」这种对不上号的残留计数。
       */
      searchHits: 0,
      searchIndex: 0,
      searchQuery: ''
    })
  },

  closeTab: (id) => {
    const state = get()
    const index = state.tabs.findIndex((t) => t.id === id)
    if (index < 0) return

    const tabs = stashActiveTab(state).filter((t) => t.id !== id)

    if (tabs.length === 0) {
      // 最后一个标签也关掉了：把当前文档清空（要不要退出应用由 App 决定）
      set({
        tabs: [],
        activeTabId: '',
        filePath: '',
        fileName: '',
        fileSize: 0,
        pageCount: 0,
        page: 1,
        annotations: [],
        exportDirty: false,
        error: null,
        searchHits: 0,
        searchIndex: 0,
        searchQuery: ''
      })
      return
    }

    // 优先接管右边那个；关的是最后一个就接管左边那个（浏览器习惯）
    const next = tabs[Math.min(index, tabs.length - 1)]

    /*
     * 先把 activeTabId 清空再切：
     *   否则 switchTab 里的 stashActiveTab 会把「刚被关掉那个标签」的状态
     *   又写回数组（此时数组里已经没有它，等于白做一次；更要紧的是
     *   若被关的标签正好是 current，会把它的 page/zoom 覆盖到别的标签上）。
     */
    set({ tabs, activeTabId: '' })
    get().switchTab(next.id)
  },

  closeActiveTab: () => {
    const id = get().activeTabId
    if (id) get().closeTab(id)
  },

  setPage: (page) => {
    const { pageCount, filePath, settings } = get()
    const target = Math.min(Math.max(1, Math.round(page)), Math.max(1, pageCount))
    set({ page: target })

    // 记住阅读位置：防抖 600ms，避免快速翻页时频繁写盘
    if (settings.restoreLastPosition && filePath) {
      if (positionTimer) clearTimeout(positionTimer)
      positionTimer = setTimeout(() => {
        void window.pdfApp.position.set(filePath, target)
      }, 600)
    }
  },

  nextPage: () => get().setPage(get().page + 1),
  prevPage: () => get().setPage(get().page - 1),

  setZoom: (zoom) => set({ zoom }),

  /*
   * 放大 / 缩小：**按百分比步进**，不再跳离散档位。
   *
   * ★ 这是用户明确反馈的问题：
   *   原来走 ZOOM_STEPS（0.5→0.67→0.8→1→1.25→1.5→…），
   *   相邻档跨度大（1→1.25 就是 25%），想停在 1.1 倍做不到 ——
   *   表现为「不能动态缩放，只能一次缩放固定百分比」。
   *
   *   现在改为每次 ×1.15 / ÷1.15（约 15% 步进）：
   *     · 步进足够小，可以逼近任意比例
   *     · 又是乘性的，在 50% 和 400% 下手感一致
   *       （加性步进在大比例下会显得太慢、小比例下太猛）
   *
   * 档位按钮仍然保留语义 —— 只是每一步变小了，
   * 需要精确值时用 Ctrl+滚轮或右栏的连续滑块。
   */
  zoomIn: () => {
    const { zoom, actualScale } = get()
    const current = typeof zoom === 'number' ? zoom : actualScale
    const next = Math.min(ZOOM_LIMIT_MAX, current * ZOOM_BUTTON_FACTOR)
    set({ zoom: Number(next.toFixed(4)) })
  },

  zoomOut: () => {
    const { zoom, actualScale } = get()
    const current = typeof zoom === 'number' ? zoom : actualScale
    const next = Math.max(ZOOM_LIMIT_MIN, current / ZOOM_BUTTON_FACTOR)
    set({ zoom: Number(next.toFixed(4)) })
  },

  rotate: (delta) => {
    const next = (((get().rotation + delta) % 360) + 360) % 360
    set({ rotation: next })
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  requestOcr: () => set((s) => ({ ocrRequest: s.ocrRequest + 1 })),
  setActualScale: (scale) => set({ actualScale: scale }),
  setLoading: (text) => set({ loading: text }),
  setError: (text) => set({ error: text }),

  toggleSidebar: () => {
    const next = !get().showSidebar
    set({ showSidebar: next })
    void get().patchSettings({ showSidebar: next })
  },

  toggleRightPanel: () => {
    const next = !get().showRightPanel
    set({ showRightPanel: next })
    void get().patchSettings({ showRightPanel: next })
  },

  setShowSettings: (v) => set(v ? { showSettings: true, showTools: false } : { showSettings: false }),

  /* 工具箱与设置面板互斥：两个都是右侧抽屉，同时开会互相遮挡 */
  setShowTools: (v) =>
    set(
      v
        ? { showTools: true, showSettings: false, showThemeStore: false, showPluginStore: false }
        : { showTools: false }
    ),

  setShowThemeStore: (v) =>
    set(
      v
        ? { showThemeStore: true, showTools: false, showImageTools: false, showPluginStore: false }
        : { showThemeStore: false }
    ),

  /*
   * 插件商店是独立浮层，与设置/工具箱互斥（都是要盖在阅读区上的面板）。
   * 但**不**关主题商店：主题商店挂在设置面板里，开插件商店时设置本来就该让位。
   */
  setShowPluginStore: (v) =>
    set(
      v
        ? { showPluginStore: true, showSettings: false, showTools: false, showImageTools: false, showThemeStore: false }
        : { showPluginStore: false }
    ),

  setShowImageTools: (v) =>
    set(
      v
        ? { showImageTools: true, showSettings: false, showTools: false, showThemeStore: false, showPluginStore: false }
        : { showImageTools: false }
    ),

  /* ---------- 插件 ---------- */

  loadPlugins: async () => {
    try {
      const [list, commands] = await Promise.all([
        window.pdfApp.plugins.list(),
        window.pdfApp.plugins.commands()
      ])
      set({
        installedPlugins: (list ?? []) as InstalledPluginLike[],
        pluginCommands: (commands ?? []) as PluginCommandLike[]
      })
    } catch (error) {
      set({ pluginNote: `读取插件列表失败：${(error as Error).message}` })
    }
  },

  runPluginCommand: async (commandId) => {
    try {
      const result = await window.pdfApp.plugins.run(commandId)
      if (!result.ok) set({ pluginNote: result.error ?? '插件命令执行失败' })
    } catch (error) {
      set({ pluginNote: `插件命令执行失败：${(error as Error).message}` })
    }
  },

  installPlugin: async () => {
    set({ pluginBusy: true, pluginNote: '' })
    try {
      const result = await window.pdfApp.plugins.install()
      if (result.canceled) {
        set({ pluginBusy: false })
        return
      }
      if (!result.ok) {
        set({ pluginBusy: false, pluginNote: result.error ?? '安装失败' })
        return
      }
      await get().loadPlugins()
      set({ pluginBusy: false, pluginNote: '插件已安装，重启应用后生效。' })
    } catch (error) {
      set({ pluginBusy: false, pluginNote: `安装失败：${(error as Error).message}` })
    }
  },

  uninstallPlugin: async (pluginId) => {
    set({ pluginBusy: true, pluginNote: '' })
    try {
      const result = await window.pdfApp.plugins.uninstall(pluginId)
      await get().loadPlugins()
      set({
        pluginBusy: false,
        pluginNote: result.ok ? '插件已卸载，重启应用后彻底生效。' : result.error ?? '卸载失败'
      })
    } catch (error) {
      set({ pluginBusy: false, pluginNote: `卸载失败：${(error as Error).message}` })
    }
  },

  setPluginEnabled: async (pluginId, enabled) => {
    try {
      await window.pdfApp.plugins.setEnabled(pluginId, enabled)
      await get().loadPlugins()
      set({ pluginNote: enabled ? '已启用，重启应用后生效。' : '已停用，重启应用后生效。' })
    } catch (error) {
      set({ pluginNote: `操作失败：${(error as Error).message}` })
    }
  },

  loadRollback: async () => {
    try {
      const list = await window.pdfApp.rollback.list()
      set({ rollbackVersions: list })
    } catch {
      set({ rollbackVersions: [] })
    }
  },

  applyRollback: async (version) => {
    const result = await window.pdfApp.rollback.apply(version)
    if (!result.ok) set({ error: result.error ?? '回滚失败' })
  },

  openComparePane: (filePath) =>
    set({
      compareOpen: true,
      ...(filePath ? { comparePath: filePath } : {})
    }),

  closeComparePane: () => set({ compareOpen: false }),

  clearPluginNote: () => set({ pluginNote: '' }),

  loadPluginShop: async () => {
    set({ pluginShopLoading: true, pluginShopError: '' })
    try {
      const res = await window.pdfApp.plugins.index(get().pluginShopSource)
      if (!res.ok) {
        set({ pluginShopLoading: false, pluginShopItems: [], pluginShopError: res.error ?? '插件清单不可用' })
        return
      }
      set({
        pluginShopLoading: false,
        pluginShopItems: (res.items ?? []) as PluginShopItem[],
        pluginShopError: res.source && res.source !== get().pluginShopSource ? '首选源连不上，已用备用源' : ''
      })
    } catch (error) {
      set({
        pluginShopLoading: false,
        pluginShopItems: [],
        pluginShopError: `拉取失败：${(error as Error).message}`
      })
    }
  },

  setPluginShopSource: async (source) => {
    if (get().pluginShopSource === source) return
    set({ pluginShopSource: source, pluginShopItems: null })
    await get().loadPluginShop()
  },

  refreshPluginShop: async () => {
    if (get().pluginShopItems !== null) await get().loadPluginShop()
  },

  installPluginFromShop: async (item) => {
    set({ pluginInstalling: item.id, pluginNote: '' })
    try {
      const result = await window.pdfApp.plugins.installUrl(item.download, item.sha256)
      await get().loadPlugins()
      set({
        pluginInstalling: '',
        pluginNote: result.ok
          ? `${result.verified ? '已校验' : '未校验来源'}安装完成：${item.name}，重启应用后生效。`
          : result.error ?? '安装失败'
      })
    } catch (error) {
      set({
        pluginInstalling: '',
        pluginNote: `安装失败：${(error as Error).message}`
      })
    }
  },

  loadMarket: async () => {
    try {
      /*
       * 按用户设置里的偏好先问一个源（默认 GitHub），主进程会用另一个兜底。
       * 偏好变了要清一次缓存，否则 10 分钟内还是上一个源的清单。
       */
      const res = await window.pdfApp.market.list(get().settings.marketSource)
      /*
       * 清单在这里过一遍校验：服务器/镜像/raw 上的 JSON 都可能被人手改坏，
       * 半坏的主题会让界面一处黑一处白，所以坏包整条丢弃（不截断、不补默认值）。
       */
      const items = normalizeMarketList(res.items)
      const rawCount = Array.isArray(res.items) ? res.items.length : 0
      const note =
        res.ok && rawCount > 0 && items.length === 0 ? '清单里没有合法的主题包（七色变量缺失或颜色越界）' : ''
      set({ marketItems: items, marketError: res.ok ? note : res.error ?? '市场不可用' })
    } catch (error) {
      set({ marketItems: [], marketError: '连不上市场服务器' })
    }
  },

  setMarketSource: async (source) => {
    if (get().settings.marketSource === source) return
    await get().patchSettings({ marketSource: source })
    /* 缓存按源分桶，但界面上的旧清单也要清掉，否则切过去还看到上一个源的内容 */
    await window.pdfApp.market.clearCache()
    set({ marketItems: null })
    await get().loadMarket()
  },

  installTheme: async (item) => {
    const pack = {
      id: item.id,
      name: item.name,
      accent: item.theme.accent,
      bg: item.theme.bg,
      surface: item.theme.surface,
      text: item.theme.text,
      muted: item.theme.muted,
      border: item.theme.border,
      readerBg: item.theme.readerBg
    }
    const state = get()
    const rest = state.settings.customThemes.filter((x) => x.id !== pack.id)
    /* 清单里带了主题包形态就连圆角/模糊/面板透明度一起套上（B9）；
       没带就只换配色，别把用户当前调好的形态冲掉 */
    const shape = item.pack
      ? {
          glassRadius: item.pack.radius,
          glassBlur: item.pack.blur,
          panelAlpha: item.pack.panelAlpha
        }
      : {}
    await state.patchSettings({ customThemes: [...rest, pack], customThemeId: pack.id, theme: 'custom', ...shape })
  },

  dismissDisclaimer: () => set({ disclaimerDismissed: true }),

  setUpdateInfo: (info) =>
    set({
      updateInfo: info,
      // 有新信息就重新显示浮层（用户可能刚点过「稍后」）
      updateDismissed: false,
      updateStage: info?.newer ? 'downloading' : 'idle',
      updateProgress: { received: 0, total: info?.asset?.size ?? 0, fraction: 0 },
      updateFile: ''
    }),
  setUpdateProgress: (p) => set({ updateProgress: p }),
  setUpdateStage: (stage, file) =>
    set((s) => ({ updateStage: stage, updateFile: file ?? s.updateFile })),
  dismissUpdate: () => set({ updateDismissed: true }),
  checkUpdateNow: async () => {
    const info = await window.pdfApp.update.check()
    set({
      updateInfo: info,
      updateDismissed: false,
      updateStage: info.newer ? 'downloading' : 'idle',
      updateProgress: { received: 0, total: info.asset?.size ?? 0, fraction: 0 },
      updateFile: ''
    })
    return info
  },

  /**
   * 展开/收起全文搜索。
   *
   * 展开时顺带把左侧栏打开并切到「搜索」标签页 —— 否则用户点了搜索
   * 什么都没有发生（标签页是 Sidebar 内部状态，切不过去）。
   * 焦点用自增 tick 触发，见 searchFocusTick 的注释。
   */
  setShowSearch: (v) => {
    if (v) {
      set((s) => ({
        showSearch: true,
        showSidebar: true,
        sidebarTab: 'search',
        searchFocusTick: s.searchFocusTick + 1
      }))
      void get().patchSettings({ showSidebar: true })
    } else {
      set({ showSearch: false })
    }
  },

  setSidebarTab: (t) => set({ sidebarTab: t, showSearch: t === 'search' }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResult: (hits, index) => set({ searchHits: hits, searchIndex: index }),

  showToast: (text, ms = 1600) => {
    set({ toast: text })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: '' }), ms)
  },

  patchSettings: async (patch) => {
    const next = await window.pdfApp.settings.patch(patch)
    set({ settings: next })
    const packSwitchPatch = applyTheme(next)
    /*
     * 换包：把新包的圆角/模糊/透明度写回设置。
     *
     * applyTheme 已经按新包默认值画到 CSS 变量上了，这里补一次落库，
     * 否则设置页的滑块还停在旧包的数字上（界面与滑块对不上）。
     * 第二次 patch 时 appliedPackId 已是新包，不会再触发，不存在递归。
     */
    if (packSwitchPatch) {
      const synced = await window.pdfApp.settings.patch(packSwitchPatch)
      set({ settings: synced })
      applyTheme(synced)
    }
  },

  refreshRecent: async () => {
    set({ recent: await window.pdfApp.recent.list() })
  },

  /* ---------- 批注 ---------- */

  /**
   * 加载批注。
   *
   * 不做持久化，因此这里只负责**清空**上一次的状态 ——
   * 换一份文档时上一份的笔迹不能留在画面上。
   */
  loadAnnotations: async (filePath) => {
    if (!filePath) {
      set({ annotations: [] })
      return
    }
    set({ annotations: [] })
  },

  /*
   * ---------- 批注：纯会话内状态，不落盘 ----------
   *
   * 按需求刻意不做持久化：批注只活在这次运行期间，关掉程序即清空，
   * 也不会在 PDF 旁边生成任何额外文件。
   *
   * 因此下面全部改为**直接改本地状态**，不再依赖主进程回传全量列表
   * （主进程已不再存储，回传的只是一条回显数据）。
   */
  addAnnotation: async (input) => {
    const filePath = get().filePath
    if (!filePath) return

    /**
     * id 用「时间戳 + 随机后缀」而不是自增序号：
     *   同一份文档可能在两台设备上各自标注后再合并，
     *   自增序号会撞车，时间戳加随机串不会。
     */
    const item: Annotation = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      page: input.page,
      type: input.type,
      rects: input.rects,
      color: input.color,
      quote: input.quote,
      note: input.note,
      at: Date.now()
    }

    /*
     * v2.0 覆盖式编辑字段：只在传了值的时候写上去。
     *
     * 不无脑赋值 undefined 的原因：这些字段会整体 JSON 序列化后
     * 传给导出流程，多余的 undefined 键会让「有没有这个属性」
     * 这种判断（如 type === 'text' && anno.text）变得不可靠。
     */
    if (input.text !== undefined) item.text = input.text
    if (input.fontSize !== undefined) item.fontSize = input.fontSize
    if (input.image !== undefined) item.image = input.image
    if (input.strokeWidth !== undefined) item.strokeWidth = input.strokeWidth
    if (input.line !== undefined) item.line = input.line
    if (input.fill !== undefined) item.fill = input.fill
    if (input.dash !== undefined) item.dash = input.dash
    if (input.rotation !== undefined) item.rotation = input.rotation
    if (input.fontWeight !== undefined) item.fontWeight = input.fontWeight
    if (input.fontStyle !== undefined) item.fontStyle = input.fontStyle
    if (input.fontFamily !== undefined) item.fontFamily = input.fontFamily

    /*
     * ★ 压历史栈必须在这里做，而不是在调用方（DocumentView）。
     *   踩坑记录：原先只在 eraseAt / clearAnnotations 里压栈，
     *   结果「画了一堆线，撤销按钮还是灰的」——
     *   因为画笔走的 addAnnotation 从不记历史。
     *   放在这里，画笔、高亮、便签三种新建操作一次全覆盖。
     */
    pushHistory(get())

    // 直接追加到本地列表。批注量大时这里是一次数组拷贝，
    // 但单份课件通常只有几十笔，代价可以忽略。
    set({ annotations: [...get().annotations, item] })

    // 涂白/文字/图片/形状改的是页面内容，得让人知道「还没导出」
    if (CONTENT_ANNOTATION_TYPES.includes(item.type)) set({ exportDirty: true })
  },
  removeAnnotation: async (id) => {
    const rest = get().annotations.filter((a) => a.id !== id)
    /*
     * ★ 删掉最后一条内容编辑后要把 exportDirty 复位。
     *   不然「清空」之后编辑条常驻、角标一直提示「有未导出的编辑」，
     *   用户没有任何入口能把它消掉 —— 实测会被当成 bug 报上来。
     */
    set({ annotations: rest, exportDirty: hasContentEdits(rest) && get().exportDirty })
  },

  updateAnnotationNote: async (id, note) => {
    set({
      annotations: get().annotations.map((a) => (a.id === id ? { ...a, note } : a))
    })
  },

  updateAnnotation: async (id, patch) => {
    const target = get().annotations.find((a) => a.id === id)
    if (!target) return

    /*
     * 压历史栈：拖动文本框、改字号都要能撤销。
     * 与 addAnnotation 同理，压在动作内部而不是调用方 ——
     * 拖动过程中每个 pointerup 都会调一次，撤销才是「一次拖动一步」。
     */
    pushHistory(get())

    set({
      annotations: get().annotations.map((a) => (a.id === id ? { ...a, ...patch } : a))
    })

    const types = [target.type, patch.type].filter(Boolean) as AnnotationType[]
    if (types.some((t) => CONTENT_ANNOTATION_TYPES.includes(t))) set({ exportDirty: true })
  },

  markExported: () => set({ exportDirty: false }),

  /**
   * 开启/关闭画笔。
   *
   * ★ 这里承担「按笔记忆」的换入换出：
   *   离开橡皮时把橡皮大小存进 eraserMemory，
   *   进入画笔时从 penMemory 恢复颜色与粗细。
   *   两个槽位互相独立，所以来回切换不会互相覆盖。
   *
   * ★ 关闭时连 eraserMode 一起清掉：
   *   否则「橡皮中 → 关画笔」会留下 (drawMode=false, eraserMode=true)，
   *   既不在画也不在擦却还开着橡皮，指针分支会走错。
   */
  setDrawMode: (on) => {
    const s = get()
    if (on) {
      set({
        drawMode: true,
        eraserMode: false,
        // 从画笔自己的记忆恢复（首次为默认的红色细笔）
        drawColor: s.penMemory.color,
        drawWidth: s.penMemory.width,
        // 拿起画笔就离开编辑工具，指针只归一方所有
        editTool: 'none'
      })
    } else {
      set({ drawMode: false, eraserMode: false })
    }
  },

  setDrawColor: (color) => set({ drawColor: color, penMemory: { ...get().penMemory, color } }),
  // 上限 14：再粗就盖住正文了；下限 1 保证细笔也能看见
  setDrawWidth: (width) => {
    const w = Math.min(14, Math.max(1, width))
    set({ drawWidth: w, penMemory: { ...get().penMemory, width: w } })
  },

  /**
   * 开启/关闭橡皮。
   *
   * 与 setDrawMode 对称：离开画笔时把颜色与粗细存进 penMemory，
   * 进入橡皮时从 eraserMemory 恢复大小。
   */
  setEraserMode: (on) => {
    const s = get()
    if (on) {
      set({
        eraserMode: true,
        drawMode: true, // 橡皮也属于手绘态（需要在页面上接管指针）
        eraserSize: s.eraserMemory.size,
        // 同理：橡皮也要独占指针，编辑工具让位
        editTool: 'none',
        // 顺手把当前画笔设置存好，切回画笔时能还原
        penMemory: { color: s.drawColor, width: s.drawWidth }
      })
    } else {
      set({ eraserMode: false })
    }
  },

  /*
   * 橡皮半径范围 3~48（CSS 像素）。
   * 下限取 3：比这更小在触屏上根本点不中；
   * 上限取 48：再大一圈下去半页就没了，实际用不上。
   */
  setEraserSize: (size) => {
    const v = Math.min(48, Math.max(3, size))
    set({ eraserSize: v, eraserMemory: { size: v } })
  },

  /* 漫游 = 既没在画也没在擦；两个开关一起清，保证「三选一」不变式 */
  setRoam: () => set({ drawMode: false, eraserMode: false, editTool: 'none' }),

  /**
   * 切到某个内容编辑工具。
   *
   * ★ 关掉画笔与橡皮是必须的：编辑工具要自己吃 pointerdown
   *   （拖框、拖文本框），画笔那条链路也吃 pointerdown，
   *   两个都开着就会出现「拖出一个白块的同时还画了条线」。
   *   'none' 等价于回到漫游/浏览状态。
   */
  setEditTool: (tool) =>
    set(tool === 'none'
      ? { editTool: 'none' }
      : { editTool: tool, drawMode: false, eraserMode: false }),

  setMaskMode: (mode) => set({ maskMode: mode }),

  /**
   * 撤销最后一笔。
   *
   * 按 at（创建时间）取最新的一条而不是数组末尾：
   * 列表是按页码排序的，末位不一定是最后画的那一笔。
   */
  /*
   * ---------- 橡皮：几何切段（真实橡皮） ----------
   */
  eraseAt: async (page, x, y, radius) => {
    const { annotations } = get()
    if (annotations.length === 0) return false

    /* 只取该页的笔迹，避免在别的页面上白算 */
    const shapes = annotations
      .filter((a) => a.page === page)
      .map(toStrokeShape)
      .filter((s): s is NonNullable<typeof s> => s !== null)
    if (shapes.length === 0) return false

    const hits = strokesInEraser(shapes, x, y, radius)
    if (hits.length === 0) return false

    /*
     * 压历史栈，但**合并连续擦除**：
     * 拖动时每秒几十次擦除，每次都压栈会让 50 步的栈只够用 1 秒，
     * 且撤销只能回退极小一步。窗口内的连续擦除只记第一次。
     */
    const now = Date.now()
    if (now - lastErasePushAt > ERASE_COALESCE_MS) {
      pushHistory(get())
      lastErasePushAt = now
    }

    const hitIds = new Set(hits.map((s) => s.id))
    const next: Annotation[] = []

    for (const item of annotations) {
      if (!hitIds.has(item.id) || item.page !== page) {
        next.push(item)
        continue
      }

      const shape = toStrokeShape(item)
      if (!shape) {
        next.push(item)
        continue
      }

      /* 按几何切段：圆外的部分保留下来，形成若干残段 */
      const fragments = splitStrokeByEraser(shape.points, x, y, radius)

      fragments.forEach((frag, i) => {
        next.push({
          ...item,
          /*
           * 残段 id = 原 id + 起点下标 + 全局自增序号。
           *
           * 序号不能省：同一条笔迹被反复擦除时，
           * 前后两次擦出的碎片起点下标可能相同，光靠它拼出的 id 会撞车，
           * 导致 React 列表 key 重复（渲染错乱）以及命中判定取错段。
           */
          id: `${item.id}~${frag.startIndex}-${i}-${++fragmentSeq}`,
          quote: encodeStroke(frag.points, shape.width),
          at: item.at
        })
      })
      // 全部被擦光时 fragments 为空，这条自然消失
    }

    set({ annotations: next })
    return true
  },

  /*
   * ---------- 撤销 / 重做（多步）----------
   *
   * 用两个快照栈实现。相比记录「反向操作」的做法，
   * 快照的好处是实现简单、不会漏掉边界情况；
   * 代价是内存占用，因此限制栈深（见 HISTORY_LIMIT）。
   */
  undo: () => {
    const { history, future, annotations } = get()
    if (history.length === 0) {
      get().showToast('没有可撤销的操作')
      return
    }
    const prev = history[history.length - 1]
    set({
      annotations: prev,
      history: history.slice(0, -1),
      future: [annotations, ...future].slice(0, HISTORY_LIMIT)
    })
  },

  redo: () => {
    const { future, history, annotations } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      annotations: next,
      future: future.slice(1),
      history: [...history, annotations].slice(-HISTORY_LIMIT)
    })
  },

  canUndo: () => get().history.length > 0,
  canRedo: () => get().future.length > 0,

  clearAnnotations: async () => {
    if (!get().filePath) return
    if (get().annotations.length === 0) return
    // 清空是可撤销的：先压栈再清，否则误触清屏就救不回来了
    pushHistory(get())
    // 清空同样要复位「未导出」：一条内容编辑都不剩了，再挂角标就是错误提示
    set({ annotations: [], exportDirty: false })
    get().showToast('已清空批注（可撤销）')
  }
}))

/**
 * 把主题与界面缩放写到 html 上。
 *
 * 用 CSS 变量而不是把样式散落到组件里，这样滑块拖动时整个界面
 * 立刻按比例缩放，不需要重新渲染任何组件。
 */
function hexToRgbTriple(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/**
 * 强调色上的前景色（`--accent-fg`）。
 *
 * 之前这个值在 CSS 里按主题写死成白色：Metro 的标题栏是「整条强调色 + 白字」，
 * 用户一旦把强调色换成浅色（黄、浅绿、浅灰），立刻变成白字贴浅底，标题栏整条
 * 看不见（2026-10-28 用户报的「部分主题标题栏不显示」）。
 *
 * 改成像 WPS / Office 那样按亮度算：底色够亮就用深字，够暗就用白字。
 * 0.42 是白字与深字对比度相等的分界点（白字 1.05/(L+0.05) 与深字 (L+0.05)/0.05 相等）。
 */
function accentForeground(triple: string): string | null {
  const parts = triple.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  const [r, g, b] = parts.map((n) => {
    const c = Math.min(255, Math.max(0, n)) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.42 ? '18 22 30' : '255 255 255'
}

/*
 * 上一次真正套用过的主题包（classic / metro / glass）。
 *
 * 只在**换包**时把圆角/模糊/透明度重置成新包的默认值；同一个包内换配色不动用户的值。
 * 首次调用（应用启动）只记录、不重置 —— 否则用户调好的玻璃参数每次重启都会被冲掉。
 */
let appliedPackId: string | null = null

function applyTheme(settings: ReaderSettings): Partial<ReaderSettings> | null {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  /* 2026-10-24：布局（office = Office 2019 风格的功能区）与配色解耦，各自独立切换 */
  root.dataset.layout = settings.themeLayout
  // 基准字号 13px，uiScale 1.15 → 约 15px
  root.style.fontSize = `${(13 * settings.uiScale).toFixed(2)}px`
  root.style.setProperty('--reader-bg', settings.pageBackground)

  /*
   * 主题包的三组可调参数（圆角 / 模糊 / 面板透明度）。
   *
   * 用行内变量而不是 data 属性：滑块拖动时要立刻生效，走 CSS 变量
   * 不触发任何 React 重渲染。写的是「实时字段」而不是包的默认值 ——
   * 用户在界面上改过的值，切包之后不会因为包默认值而回滚。
   *
   * `--radius` 系列也在这里统一下发：一次改圆角，按钮、卡片、输入框、
   * 外壳全部跟着变，这是「一整套视觉」而不是只换一个滑块。
   */
  /*
   * 三组参数由「包默认值 + 用户实时改动」共同决定，优先级如下：
   *   · 用户没动过滑块（仍等于 classic 的出厂值 10/0/1）⇒ 用**当前包**的默认值
   *     （Metro 必须直角 0、玻璃必须 22/18/0.55，不能继承上一包的数字）
   *   · 用户动过滑块 ⇒ 尊重用户的手动值，切包不给他回滚
   * 这正是之前「切到 Metro 圆角还是 14px」「玻璃看不出材质」的病根：
   * 直接 patchSettings({theme}) 时没有经过设置页那层「套用包默认值」。
   */
  const packForStyle = settings.packDefaults?.[themePackOf(settings.theme)] ?? DEFAULT_SETTINGS.packDefaults[themePackOf(settings.theme)]

  /*
   * 「换包」时把三件套改成新包的默认值。
   *
   * 为什么要单独记一个当前包：`untouched` 那套判定只解决「用户从没动过滑块」的情况，
   * 但用户只要在玻璃包里调过圆角（比如 14px），再切到 Metro 时会命中「动过滑块 ⇒ 尊重用户值」，
   * 于是 Metro 依旧 14px 圆角 —— 这正是用户报过两次的「切到 Metro 圆角还是 14px」。
   *
   * 正确的粒度是**包**而不是滑块：
   *   · 同一个包内换配色（classic 的 11 档）⇒ 保留用户调好的圆角/模糊/透明度；
   *   · 换包（classic → metro → glass）⇒ 这是换整套视觉，必须套用新包形态。
   * 首次调用只记录当前包、不做重置，否则每次启动都会把用户调好的玻璃参数冲掉。
   */
  const packId = themePackOf(settings.theme)
  let packSwitchPatch: Partial<ReaderSettings> | null = null
  if (appliedPackId === null) {
    appliedPackId = packId
  } else if (appliedPackId !== packId) {
    appliedPackId = packId
    const target = {
      glassRadius: packForStyle.radius,
      glassBlur: packForStyle.blur,
      panelAlpha: packForStyle.panelAlpha
    }
    if (
      target.glassRadius !== settings.glassRadius ||
      target.glassBlur !== settings.glassBlur ||
      target.panelAlpha !== settings.panelAlpha
    ) {
      packSwitchPatch = target
    }
  }

  const untouched =
    settings.glassRadius === DEFAULT_SETTINGS.glassRadius &&
    settings.glassBlur === DEFAULT_SETTINGS.glassBlur &&
    settings.panelAlpha === DEFAULT_SETTINGS.panelAlpha
  const radius = packSwitchPatch ? packForStyle.radius : untouched ? packForStyle.radius : settings.glassRadius
  const blur = packSwitchPatch ? packForStyle.blur : untouched ? packForStyle.blur : settings.glassBlur
  const alpha = packSwitchPatch ? packForStyle.panelAlpha : untouched ? packForStyle.panelAlpha : settings.panelAlpha

  root.style.setProperty('--glass-radius', `${radius}px`)
  root.style.setProperty('--glass-blur', `${blur}px`)
  root.style.setProperty('--radius', `${radius}px`)
  root.style.setProperty('--radius-sm', `${Math.round(radius * 0.55)}px`)
  root.style.setProperty('--radius-lg', `${Math.round(radius * 1.5)}px`)
  root.style.setProperty('--panel-alpha', String(alpha))

  /*
   * 主题包：形态（圆角以外的投影 / 玻璃缝隙 / 工具栏高度）来自包默认值。
   *
   * `data-pack` 是包级 CSS 的钩子（html[data-pack='glass'] ...），配色仍然
   * 只由 data-theme 决定 —— 于是「液态玻璃 + 任意一档配色」都成立，
   * 而不是把半透明写死在 html[data-theme='glass'] 上。
   */
  const pack = settings.packDefaults?.[packId] ?? DEFAULT_SETTINGS.packDefaults[packId]
  root.dataset.pack = packId
  root.style.setProperty('--panel-shadow', pack.shadow || 'none')
  root.style.setProperty('--glass-gap', `${pack.gap}px`)
  root.style.setProperty('--toolbar-h', `${pack.toolbarHeight}px`)

  /*
   * 插件市场装的主题包（theme='custom'）。
   *
   * 内置主题靠 base.css 的 `html[data-theme=...]` 规则，主题包不能改 CSS 文件，
   * 所以这里把变量写成**行内变量**覆盖：行内优先级高于样式表，切走时再清掉。
   */
  const tokens = [
    '--bg',
    '--surface',
    '--surface-strong',
    '--text',
    '--muted',
    '--border',
    '--accent',
    '--reader-bg'
  ]
  for (const name of tokens) root.style.removeProperty(name)
  if (settings.theme === 'custom') {
    const pack =
      settings.customThemes.find((x) => x.id === settings.customThemeId) ?? settings.customThemes[0]
    if (pack) {
      root.style.setProperty('--bg', pack.bg)
      root.style.setProperty('--surface', pack.surface)
      root.style.setProperty('--text', pack.text)
      root.style.setProperty('--muted', pack.muted)
      root.style.setProperty('--border', pack.border)
      root.style.setProperty('--accent', pack.accent)
      root.style.setProperty('--reader-bg', pack.readerBg)
    }
  }

  /*
   * 强调色覆盖：三个内置包与市场主题包都能换主色。
   *
   * 上面第 1312 行已经把 --accent 清掉（自定义包会再写回自己的主色），
   * 所以这里只要用户设了 accentColor 就直接覆盖；没设就什么都不做，
   * 内置包用 CSS 里的默认值、市场包用 JSON 里的 accent。
   */
  const accent = hexToRgbTriple(settings.accentColor)
  if (accent) root.style.setProperty('--accent', accent)

  /*
   * 强调色上的字色（`--accent-fg`）。
   *
   * 强调色可能来自三处：用户设的 accentColor（上面刚写进行内）、市场主题包的
   * accent（再往上的行内变量）、以及 CSS 里各主题自带的默认值。前两种在行内，
   * 第三种只能问计算样式 —— 所以这里先读行内、读不到再读计算值。
   * 行内写法还保证「换回默认强调色」时前景色跟着重算，不会留着上一次的深字。
   */
  const accentNow = root.style.getPropertyValue('--accent') || getComputedStyle(root).getPropertyValue('--accent')
  const accentFg = accentForeground(accentNow)
  if (accentFg) root.style.setProperty('--accent-fg', accentFg)

  // 自定义背景图：走 pdf-file 协议（与 PDF 同一条链路），冒号不编码
  const image = settings.readerImage
  if (image) {
    const encoded = image
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
      .join('/')
    root.style.setProperty('--reader-image', `url("pdf-file:///${encoded}")`)
  } else {
    root.style.setProperty('--reader-image', 'none')
  }
  root.style.setProperty('--reader-image-dim', image ? String(settings.readerImageDim) : '0')
  root.style.setProperty('--reader-image-blur', `${settings.readerImageBlur}px`)

  /* 换包时要写回的三件套（调用方负责落库，见 patchSettings / init） */
  return packSwitchPatch
}
