// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主进程与渲染进程共享的类型。
 */

/** 阅读模式 */
export type ViewMode = 'single' | 'continuous' | 'facing' | 'facing-continuous'

/** 左侧栏页签 */
export type SidebarTab = 'thumbnails' | 'outline' | 'search'

/** 右侧栏页签 */
export type RightTab = 'info' | 'annotations'

/**
 * 主题模式。
 *
 * metro = Metro UI（Windows 10 开始菜单 / 磁贴那一套）：
 *   平直色块、直角、Segoe UI、单一强调色，不用阴影和圆角。
 */
export type ThemeMode =
  | 'light'
  | 'dark'
  | 'sepia'
  | 'metro'
  | 'glass'
  | 'night'
  | 'forest'
  | 'warm'
  | 'contrast'
  /** 2026-10-24 新增四档：纸墨 / 午夜蓝 / 青梅 / 柔光 */
  | 'paper'
  | 'midnight'
  | 'plum'
  | 'glow'
  /** 插件市场装的主题包：具体校验值存在 settings.customThemes 里 */
  | 'custom'

/**
 * 界面布局。
 *
 * normal 是原来的紧凑工具条；office 是 Office 2019 式的功能区（Ribbon）：
 * 更高的条带、图标在上文字在下、直角、强调色下划线。布局只管结构，
 * 配色仍然由 theme 决定 —— 两者互不影响，可以任意组合。
 */
export type ThemeLayout = 'normal' | 'office'

/** 主题包：来自插件市场的可安装主题（校验值与内置主题同构） */
export interface CustomTheme {
  id: string
  name: string
  /** 主色，用于卡片与按钮 */
  accent: string
  /** 各区域 RGB 三元组字符串，例如 242 244 248 */
  bg: string
  surface: string
  text: string
  muted: string
  border: string
  readerBg: string
}

/** 阅读器设置（持久化） */
export interface ReaderSettings {
  version: number
  theme: ThemeMode
  /** 布局：紧凑工具条 / Office 2019 功能区；与配色解耦 */
  themeLayout: ThemeLayout
  /** 阅读区底色，与主题独立，便于护眼 */
  pageBackground: string
  /** 阅读区背景图片的绝对路径（空串表示不用图片） */
  readerImage: string
  /** 背景图的压暗程度 0~0.85 */
  readerImageDim: number
  /** 背景图的模糊半径 0~24px */
  readerImageBlur: number
  /** 液态玻璃主题包：圆角半径（px，0~24） */
  glassRadius: number
  /** 液态玻璃主题包：背景模糊（px，0~30） */
  glassBlur: number
  /** 强调色覆盖（空串表示跟随主题）。十六进制 #rrggbb */
  accentColor: string
  /** 插件市场装的主题包 */
  customThemes: CustomTheme[]
  /** 当前正在使用的主题包 id（theme='custom' 时生效） */
  customThemeId: string
  /** 默认缩放：'fit-width' | 'fit-page' | 'actual' | 数字 */
  defaultZoom: 'fit-width' | 'fit-page' | 'actual' | number
  /** 每次打开是否恢复上次阅读位置 */
  restoreLastPosition: boolean
  /** 最近打开的文件列表上限 */
  recentLimit: number
  /** 缩略图栏默认是否展开 */
  showSidebar: boolean
  /** 右侧批注栏默认是否展开 */
  showRightPanel: boolean
  /** 界面缩放（教学一体机上常用放大） */
  uiScale: number
  /** 是否启用键盘快捷键 */
  enableShortcuts: boolean
  /**
   * 是否已勾选「知道了，不再提示」而不再显示启动声明。
   *
   * 声明（免费提供 / 早期版本 / 反馈渠道）对第一次用的人是必要信息，
   * 但每开一次弹一次会烦人，所以给一个持久化开关：
   * 勾上它，以后启动就不再出现；没勾就关掉，只对本次启动生效。
   */
  disclaimerHidden: boolean
  /**
   * 启动时是否自动查一次新版本。
   *
   * 自动检查是静默的：只有查到更新才在右下角提一句，查不到/断网什么都不显示。
   * 设置页里的「检查更新」按钮不受这个开关影响。
   */
  updateAutoCheck: boolean
  /** 公开版更新通道偏好（静默部署版忽略） */
  updateChannel: 'auto' | 'github' | 'mirror'
}

/** 一条最近打开的记录 */
export interface RecentFile {
  path: string
  name: string
  /** 上次看到的页码（从 1 开始） */
  page: number
  /** 打开时间戳 */
  at: number
}

/** 文档信息 */
export interface DocInfo {
  path: string
  name: string
  size: number
  pageCount: number
  title: string
  author: string
  subject: string
  keywords: string
  creationDate: string
  modificationDate: string
  pdfVersion: string
  encrypted: boolean
}

/* ============================================================
 * 批注
 * ============================================================ */

/**
 * 批注类型。
 *
 * 前四种是「标记原文」，后五种是 v2.0 新增的「改内容」——
 * 它们让用户能在不破坏原文件的前提下做覆盖式编辑（涂白擦掉、盖文字、
 * 贴图片、画框），导出时统一烘焙进新 PDF。
 */
export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  /** 涂白：不透明矩形盖住原内容 */
  | 'whiteout'
  /** 矩形框（rects[0] 是外接框） */
  | 'rect'
  /** 椭圆框（rects[0] 是外接框） */
  | 'ellipse'
  /** 自由文本（text 是内容，rects[0] 是文本框） */
  | 'text'
  /** 插入图片（image 是 dataURL，rects[0] 是位置与尺寸） */
  | 'image'

/** 会改变页面内容、导出时必须烘焙进 PDF 的类型（决定「未保存」提示） */
export const CONTENT_ANNOTATION_TYPES: AnnotationType[] = [
  'whiteout',
  'rect',
  'ellipse',
  'text',
  'image'
]

/**
 * 内容编辑工具。
 *
 * 'none' = 没在编辑（指针交给画笔/橡皮/漫游那条链路）。
 * 与画笔/橡皮/漫游互斥：一个指针不可能同时在画线又在拖文本框。
 */
export type EditTool = 'none' | 'select' | 'text' | 'image' | 'whiteout' | 'rect' | 'ellipse'

/** 工具的中文名（工具条、状态栏、提示语共用，避免各写一份） */
export const EDIT_TOOL_LABEL: Record<EditTool, string> = {
  none: '浏览',
  select: '选择',
  text: '文字',
  image: '图片',
  whiteout: '涂白',
  rect: '矩形',
  ellipse: '椭圆'
}

/**
 * 一段矩形（PDF 用户空间坐标）。
 *
 * 说明：这里存的是**页面坐标系的 CSS 像素值**（scale = 1，未旋转），
 * 而不是 PDF 内部的 1/72 英寸单位。理由是渲染层直接用 canvas 尺寸算比例即可，
 * 不需要在每次渲染时做单位换算，也不会因为缩放/旋转导致标注漂移。
 */
export interface AnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

/** 一条批注 */
export interface Annotation {
  id: string
  /** 页码，从 1 开始 */
  page: number
  type: AnnotationType
  /**
   * 覆盖区域。
   * 高亮/下划线/删除线可以有多段（跨行选中的每一行算一段）；
   * 便签只有一段。
   */
  rects: AnnotationRect[]
  /** 颜色（十六进制） */
  color: string
  /** 被标注的原文（便于在侧栏预览，也是检索依据） */
  quote: string
  /** 用户写的备注 */
  note: string
  /** 创建时间戳 */
  at: number

  /* ---------- v2.0 覆盖式编辑字段（都按类型可选） ---------- */

  /** 文本内容（type === 'text'）：支持 \n 换行 */
  text?: string
  /** 字号（页面坐标像素，scale = 1 的坐标系；type === 'text'） */
  fontSize?: number
  /** 图片 dataURL（type === 'image'） */
  image?: string
  /** 线条粗细（type === 'rect' | 'ellipse'，不填默认 2） */
  strokeWidth?: number
  /** 旋转角度（度，暂只用于图片；不填 0） */
  rotation?: number

  /*
   * v2.1.3：改文字时继承原文的字体长相。
   * 不填就按 400 / normal / 内置字体栈渲染，老批注不受影响。
   */
  /** 字重（type === 'text'） */
  fontWeight?: number
  /** 字形（type === 'text'） */
  fontStyle?: 'normal' | 'italic'
  /** 字体族（type === 'text'）；不填用内置栈 */
  fontFamily?: string
}

/** 按文档分组存储的批注表：key 是文件绝对路径 */
export type AnnotationMap = Record<string, Annotation[]>

/* ============================================================
 * 标签页（单窗口多文件）
 * ============================================================ */

/**
 * 一个标签页。
 *
 * 为什么要在这里存 page / zoom / annotations：
 *   渲染层的 store 只有**一份**「当前文档」字段。切标签时如果不把
 *   这一份按标签存回去，切走再切回来就会丢掉页码、缩放，甚至刚画的
 *   批注 —— 批注是纯会话内状态（不落盘），丢了就真没了。
 */
export interface Tab {
  /** 标签 id。用自增序号而不是路径：同一个文件允许被打开两次 */
  id: string
  /** 文件绝对路径（作为切回时的重新加载依据） */
  path: string
  /** 标签上显示的名字（文件名） */
  name: string
  /** 上次离开时的页码 */
  page: number
  /** 上次离开时的缩放档位 */
  zoom: ZoomSpec
  /** 该文档的批注（会话内） */
  annotations: Annotation[]
  /** 该文档是否有还没导出成 PDF 的编辑 */
  exportDirty: boolean
}

/** 缩放档位：预设名或具体倍数 */
export type ZoomSpec = 'fit-width' | 'fit-page' | 'actual' | number

/** 打开文件的结果 */
export interface OpenResult {
  ok: boolean
  /** 给用户看的错误说明 */
  error?: string
  /** 文件绝对路径 */
  path?: string
  /** 标签上显示的名字（图片转 PDF 时保留原文件名） */
  title?: string
}
