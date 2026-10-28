// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 顶部单条功能区（Office 式 Ribbon，带目录页签）。
 *
 * ── 为什么要重做（用户列出的四个 UI 病）────────────────────────
 *   ① 上下栏重复：顶部一条工具条 + 底部一条悬浮胶囊，同一批功能出现两处，
 *      用户要来回找；现在**整个应用只有这一条**工具条，底部不再挂任何东西。
 *   ② 收起后找不回：旧实现收起后只剩一个 fixed 的小圆钮，被页面/状态栏
 *      盖住就再也点不到；现在收起后仍保留一条 28px 常驻窄条，
 *      左侧固定写着「展开工具条」，点它或按 Ctrl+F1 就回来。
 *   ③ 狭窄时出横向滚动条：旧实现靠 `overflow-x: auto` 硬滚，
 *      按钮被推到视口外（既有「看不见」也有「点不到」）。
 *      现在 `overflow: hidden` + 三档尺寸（40/34/28）+ 溢出收进「更多 ▾」。
 *   ④ 图标大小不一：现在所有 svg 由 CSS 统一 16px / stroke 1.6 / 圆头。
 *
 * ── 结构 ──────────────────────────────────────────────────────
 *   ┌ 目录条：文件 / 开始 / 工具 / 视图 ……… 页码 · OCR · 收起 ┐
 *   ├ 功能区：按「分组」横向排列，组标题 10px 灰字在按钮下方 ┤
 *   └ （可选）内容编辑选项行：由 ContentEditBridge 注册的 EditBar ┘
 *
 * 「开始」页的按钮由 DrawToolbar 负责（它持有画笔/橡皮/编辑工具的 store 逻辑），
 * 本组件只接收 `homeGroups`；其余三页的按钮在这里定义。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Archive,
  Bookmark,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Columns2,
  Copy,
  Download,
  Droplets,
  EyeOff,
  FileArchive,
  FileDown,
  FilePlus2,
  FileType,
  Flashlight,
  FolderOpen,
  GitCompare,
  History,
  Image as ImageIcon,
  Images,
  Info,
  Layers,
  LayoutGrid,
  LayoutPanelLeft,
  Plug,
  ListChecks,
  ListOrdered,
  Lock,
  Merge,
  MonitorOff,
  MoreHorizontal,
  PanelTop,
  Paperclip,
  Printer,
  RotateCw,
  Save,
  Scaling,
  ScanSearch,
  ScanText,
  Scissors,
  Search,
  Settings,
  Signature,
  Square,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { NewPdfDialog } from './NewPdfDialog'
import { useViewer } from '../store'
import { openPdfForTools } from '../pdf-tools'

/* ============================================================
 * 类型
 * ============================================================ */

export type RibbonTabId = 'file' | 'home' | 'tools' | 'view'

/** 功能区里的一个按钮 */
export interface RibbonItem {
  /** 自动化锚点：渲染成 data-tb-id */
  id: string
  label: string
  icon: ReactNode
  onClick: () => void
  title?: string
  disabled?: boolean
  active?: boolean
}

/** 一个分组（框内是按钮，框下方是 10px 组标题） */
export interface RibbonGroup {
  name: string
  items: RibbonItem[]
  /** 组内非按钮控件（画笔粗细滑块、滑动清屏） */
  extra?: ReactNode
}

/* ============================================================
 * 常量
 * ============================================================ */

const TABS: ReadonlyArray<{ id: RibbonTabId; label: string }> = [
  { id: 'file', label: '文件' },
  { id: 'home', label: '开始' },
  { id: 'tools', label: '工具' },
  { id: 'view', label: '视图' }
]

/** 收起状态存这里：用户重启应用后仍保持上次的选择 */
const COLLAPSE_KEY = 'pdf-reader:ribbon-collapsed'

/**
 * 三档尺寸的断点。
 *
 * 与样式里的 `--ribbon-btn`（40 / 34 / 28px）一一对应：
 * 窄到 900px 以下时 34px 也放不下了，再降到 28px（只剩图标），
 * 仍放不下的按钮收进「更多 ▾」。
 */
const WIDTH_LG = 1200
const WIDTH_MD = 900

type RibbonSize = 'lg' | 'md' | 'sm'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    /* 隐私模式 / 存储被禁：当成没收起 */
    return false
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ============================================================
 * 工具箱 23 卡（按分类分成两组，放进「工具」页的同一条带里）
 *
 * 说明：这些卡片复用现有入口 —— 也就是工具栏原来那个「工具箱」按钮，
 * `setShowTools(true)` 打开工具箱。ToolsPanel 的分区状态是它内部的
 * useState，store 里没有可写的「当前分区」，因此卡片只能打开工具箱首页
 * （见报告的「遗留问题」）。
 * ============================================================ */

interface ToolCard {
  id: string
  label: string
  icon: LucideIcon
}

/** 文件级（不进入文档内容，直接处理整份文件） */
const TOOLBOX_FILE_LEVEL: ReadonlyArray<ToolCard> = [
  { id: 'merge', label: '合并', icon: Merge },
  { id: 'split', label: '拆分', icon: Scissors },
  { id: 'watermark', label: '水印', icon: Droplets },
  { id: 'compress', label: '压缩', icon: FileArchive },
  { id: 'protect', label: '加密', icon: Lock },
  { id: 'convert', label: '图片', icon: ImageIcon },
  { id: 'office', label: 'Office', icon: FileType },
  { id: 'impose', label: '拼版', icon: LayoutGrid }
]

/** 文档级编辑（改页面/结构，需要逐页处理） */
const TOOLBOX_DOC_LEVEL: ReadonlyArray<ToolCard> = [
  { id: 'pages', label: '页面', icon: Layers },
  { id: 'header', label: '页眉', icon: PanelTop },
  { id: 'bates', label: '编号', icon: ListOrdered },
  { id: 'meta', label: '属性', icon: Info },
  { id: 'bookmarks', label: '书签', icon: Bookmark },
  { id: 'attach', label: '附件', icon: Paperclip },
  { id: 'forms', label: '表单', icon: ListChecks },
  { id: 'formdesign', label: '建表单', icon: ClipboardList },
  { id: 'sign', label: '签名', icon: Signature },
  { id: 'pdfa', label: '归档', icon: Archive },
  { id: 'print', label: '打印', icon: Printer },
  { id: 'extractimg', label: '提取', icon: Images },
  { id: 'compare', label: '比较', icon: GitCompare },
  { id: 'batch', label: '批量', icon: Copy },
  { id: 'export', label: '导出', icon: Download },
  { id: 'redact', label: '遮盖', icon: EyeOff }
]

/* ============================================================
 * 主组件
 * ============================================================ */

export function RibbonTabs({
  homeGroups,
  editDock
}: {
  /** 「开始」页的分组，由 DrawToolbar 构造（它持有画笔/编辑工具的 store 逻辑） */
  homeGroups: RibbonGroup[]
  /** 内容编辑选项行（来自 ContentEditBridge），没有进入编辑态时为空 */
  editDock?: ReactNode
}): JSX.Element {
  /* ---------- 本地状态 ---------- */
  const [tab, setTab] = useState<RibbonTabId>('home')
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [size, setSize] = useState<RibbonSize>('lg')
  /** 被「更多 ▾」收走的按钮 id（顺序 = 定义顺序，便于稳定比较） */
  const [hidden, setHidden] = useState<string[]>([])
  const [moreOpen, setMoreOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [newPdfOpen, setNewPdfOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  /* ---------- store ---------- */
  const filePath = useViewer((s) => s.filePath)
  const fileName = useViewer((s) => s.fileName)
  const annotations = useViewer((s) => s.annotations)
  const recent = useViewer((s) => s.recent)
  const page = useViewer((s) => s.page)
  const pageCount = useViewer((s) => s.pageCount)
  const zoom = useViewer((s) => s.zoom)
  const viewMode = useViewer((s) => s.viewMode)
  const maskMode = useViewer((s) => s.maskMode)
  const showSidebar = useViewer((s) => s.showSidebar)
  const showSearch = useViewer((s) => s.showSearch)

  const hasDoc = filePath !== ''

  const pickFile = useViewer((s) => s.pickFile)
  const openFile = useViewer((s) => s.openFile)
  const setPage = useViewer((s) => s.setPage)
  const prevPage = useViewer((s) => s.prevPage)
  const nextPage = useViewer((s) => s.nextPage)
  const zoomIn = useViewer((s) => s.zoomIn)
  const zoomOut = useViewer((s) => s.zoomOut)
  const setZoom = useViewer((s) => s.setZoom)
  const rotate = useViewer((s) => s.rotate)
  const setViewMode = useViewer((s) => s.setViewMode)
  const setMaskMode = useViewer((s) => s.setMaskMode)
  const toggleSidebar = useViewer((s) => s.toggleSidebar)
  const setShowSearch = useViewer((s) => s.setShowSearch)
  const setShowTools = useViewer((s) => s.setShowTools)
  const setShowImageTools = useViewer((s) => s.setShowImageTools)
  const showImageTools = useViewer((s) => s.showImageTools)
  const compareOpen = useViewer((s) => s.compareOpen)
  const openComparePane = useViewer((s) => s.openComparePane)
  const closeComparePane = useViewer((s) => s.closeComparePane)
  const pluginCommands = useViewer((s) => s.pluginCommands)
  const runPluginCommand = useViewer((s) => s.runPluginCommand)
  const setShowSettings = useViewer((s) => s.setShowSettings)
  const requestOcr = useViewer((s) => s.requestOcr)
  const showToast = useViewer((s) => s.showToast)

  /* ---------- 页码输入框（常驻在目录条右侧） ---------- */
  const [pageInput, setPageInput] = useState(String(page))
  useEffect(() => {
    setPageInput(String(page))
  }, [page])

  const commitPage = (): void => {
    const n = Number(pageInput)
    if (Number.isFinite(n) && n > 0) setPage(n)
    else setPageInput(String(page))
  }

  /* ---------- 收起 / 展开 ---------- */
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* 存不了就只影响「下次启动是否记得」，不必打扰用户 */
    }
  }, [collapsed])

  /*
   * Ctrl+F1 是 Office 的「收起/展开功能区」习惯键。
   * 用 keydown 而不是快捷键注册表：它只作用于这条工具条，
   * 且必须在输入框里也能用（Office 也是这样）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------- 三档尺寸（ResizeObserver 盯自己的宽度） ---------- */
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const apply = (): void => {
      const w = el.clientWidth
      setSize(w >= WIDTH_LG ? 'lg' : w >= WIDTH_MD ? 'md' : 'sm')
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  /* ---------- 文件页动作 ---------- */

  /** 保存副本：走主进程 pdf:export，pages 传空数组即为「原样复制」 */
  const saveCopy = async (): Promise<void> => {
    if (!filePath) return
    setBusy(true)
    try {
      const base = (fileName || '文档').replace(/\.pdf$/i, '')
      const r = await window.pdfApp.doc.exportPdf({
        sourcePath: filePath,
        defaultName: `${base}-副本.pdf`,
        pages: []
      })
      if (r.ok) showToast(`已保存副本：${r.path}`, 3000)
      else if (!r.canceled) showToast(`保存副本失败：${r.error ?? '未知错误'}`, 3000)
    } catch (e) {
      showToast(`保存副本失败：${errText(e)}`, 3000)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 导出 PDF：把批注/内容编辑烘焙进页面后另存。
   *
   * 为什么不借道 close-guard：那个模块的导出实现由 App 注册，
   * 对外只提供「有脏数据时弹三选一」的守卫，直接调用会弹原生对话框。
   * 这里按 useContentEdit 的 runExport 同样做法，自己开一份独立的
   * pdf.js 文档（openPdfForTools），导出完销毁，不影响阅读器实例。
   */
  const exportPdf = async (): Promise<void> => {
    if (!filePath) return
    setBusy(true)
    try {
      /* openPdfForTools 静态引入：它在别处已静态被引，改成静态不会多出体积，
         还能免掉「同一模块既静态又动态引入」的打包告警。
         anno-export 保持动态：它体积不小，且在导出时才需要。 */
      const exportDoc = await openPdfForTools(filePath)
      try {
        const annoMod = await import('../anno-export')
        const r = await annoMod.exportAnnotatedPdf({
          doc: exportDoc,
          filePath,
          fileName,
          annotations
        })
        if (r.ok) showToast(`已导出：${r.path ?? ''}`, 3000)
        else if (!r.canceled) showToast(`导出失败：${r.error ?? '未知错误'}`, 3000)
      } finally {
        void exportDoc.destroy()
      }
    } catch (e) {
      showToast(`导出失败：${errText(e)}`, 3000)
    } finally {
      setBusy(false)
    }
  }

  const doPrint = async (): Promise<void> => {
    if (!filePath) return
    try {
      const r = await window.pdfApp.advanced.print({ sourcePath: filePath })
      if (r.ok) showToast('已打开打印面板', 2200)
      else showToast(`打印失败：${r.error ?? '未知错误'}`, 2600)
    } catch (e) {
      showToast(`打印失败：${errText(e)}`, 2600)
    }
  }

  /* ---------- 各目录页的按钮 ---------- */

  const fileGroups: RibbonGroup[] = [
    {
      name: '文件',
      items: [
        {
          id: 'open-file',
          label: '打开',
          icon: <FolderOpen size={16} aria-hidden="true" />,
          onClick: () => void pickFile(),
          title: '打开 PDF（Ctrl+O）'
        },
        {
          id: 'new-pdf',
          label: '新建',
          icon: <FilePlus2 size={16} aria-hidden="true" />,
          onClick: () => setNewPdfOpen(true),
          title: '新建空白 PDF'
        },
        {
          id: 'save-copy',
          label: '保存副本',
          icon: <Save size={16} aria-hidden="true" />,
          onClick: () => void saveCopy(),
          disabled: !hasDoc || busy,
          title: '把当前文件另存为一个副本（不会覆盖原文件）'
        },
        {
          id: 'export-pdf',
          label: '导出 PDF',
          icon: <FileDown size={16} aria-hidden="true" />,
          onClick: () => void exportPdf(),
          disabled: !hasDoc || busy,
          title: '把批注与内容编辑烘焙进 PDF 后另存'
        },
        {
          id: 'print',
          label: '打印',
          icon: <Printer size={16} aria-hidden="true" />,
          onClick: () => void doPrint(),
          disabled: !hasDoc,
          title: '打印当前文档'
        },
        {
          id: 'recent',
          label: '最近文件',
          icon: <History size={16} aria-hidden="true" />,
          onClick: () => setRecentOpen((v) => !v),
          active: recentOpen,
          title: '最近打开过的文档'
        }
      ]
    }
  ]

  const toolGroupList: RibbonGroup[] = [
    /*
     * 插件命令（2026-10-28，需求清单 B8）。
     *
     * 插件在主进程注册的命令全都汇集到这一组，和内置工具并排 ——
     * 用户装上插件之后不必再找「插件在哪执行」，它就在工具栏里。
     * 没有装任何插件时这一组不渲染，避免空组占位。
     */
    ...(pluginCommands.length > 0
      ? [
          {
            name: '插件',
            items: pluginCommands.map((command) => ({
              id: command.id,
              label: command.label,
              icon: <Plug size={16} aria-hidden="true" />,
              onClick: () => void runPluginCommand(command.id),
              title: `插件命令：${command.label}`
            }))
          } as RibbonGroup
        ]
      : []),
    {
      /*
       * 图片工具入口（2026-10-28，需求清单 B5）。
       *
       * 它以前是阅读区右下角的常驻悬浮圆按钮，用户明确要求「不要单独悬浮按钮，
       * 合并到上栏」。放在「工具」选项卡最前面而不是塞进文件级/文档级：
       * 前两组是「对整个 PDF 做事」，这一组是「对一张图片做事」，语义不同。
       */
      name: '图片',
      items: [
        {
          id: 'tool-image',
          label: '图片处理',
          icon: <ImageIcon size={16} aria-hidden="true" />,
          onClick: () => setShowImageTools(true),
          active: showImageTools,
          title: '图片工具：裁剪 / 调色 / 滤镜 / 格式转换 / 批量压缩'
        }
      ]
    },
    {
      name: '文件级',
      items: TOOLBOX_FILE_LEVEL.map((t) => {
        const Icon = t.icon
        return {
          id: `tool-${t.id}`,
          label: t.label,
          icon: <Icon size={16} aria-hidden="true" />,
          onClick: () => setShowTools(true),
          title: `${t.label}：打开 PDF 工具箱`
        }
      })
    },
    {
      name: '文档级编辑',
      items: TOOLBOX_DOC_LEVEL.map((t) => {
        const Icon = t.icon
        return {
          id: `tool-${t.id}`,
          label: t.label,
          icon: <Icon size={16} aria-hidden="true" />,
          onClick: () => setShowTools(true),
          title: `${t.label}：打开 PDF 工具箱`
        }
      })
    }
  ]

  const viewGroups: RibbonGroup[] = [
    {
      name: '显示比例',
      items: [
        {
          id: 'zoom-in',
          label: '放大',
          icon: <ZoomIn size={16} aria-hidden="true" />,
          onClick: () => zoomIn(),
          disabled: !hasDoc,
          title: '放大（Ctrl++）'
        },
        {
          id: 'zoom-out',
          label: '缩小',
          icon: <ZoomOut size={16} aria-hidden="true" />,
          onClick: () => zoomOut(),
          disabled: !hasDoc,
          title: '缩小（Ctrl+-）'
        },
        {
          id: 'fit-width',
          label: '适应宽度',
          icon: <Scaling size={16} aria-hidden="true" />,
          onClick: () => setZoom('fit-width'),
          disabled: !hasDoc,
          active: zoom === 'fit-width',
          title: '缩放到适应窗口宽度'
        }
      ]
    },
    {
      name: '页面',
      items: [
        {
          id: 'view-split',
          label: '分屏对比',
          icon: <Columns2 size={16} aria-hidden="true" />,
          onClick: () => (compareOpen ? closeComparePane() : openComparePane()),
          active: compareOpen,
          title: '在右侧开一个参考窗，和左边文件的对照着看',
        },
        {
          id: 'viewmode-single',
          label: '单页',
          icon: <Square size={16} aria-hidden="true" />,
          onClick: () => setViewMode('single'),
          disabled: !hasDoc,
          active: viewMode === 'single',
          title: '单页：一次只显示一页'
        },
        {
          id: 'viewmode-facing',
          label: '双页',
          icon: <Columns2 size={16} aria-hidden="true" />,
          onClick: () => setViewMode('facing'),
          disabled: !hasDoc,
          active: viewMode === 'facing' || viewMode === 'facing-continuous',
          title: '双页并排'
        },
        {
          id: 'rotate',
          label: '旋转',
          icon: <RotateCw size={16} aria-hidden="true" />,
          onClick: () => rotate(90),
          disabled: !hasDoc,
          title: '顺时针旋转（Ctrl+R）'
        }
      ]
    },
    {
      name: '授课',
      items: [
        {
          id: 'mask-spotlight',
          label: '聚光',
          icon: <Flashlight size={16} aria-hidden="true" />,
          onClick: () => setMaskMode(maskMode === 'spotlight' ? 'off' : 'spotlight'),
          active: maskMode === 'spotlight',
          title: '聚光：只照亮鼠标周围'
        },
        {
          id: 'mask-black',
          label: '黑屏',
          icon: <MonitorOff size={16} aria-hidden="true" />,
          onClick: () => setMaskMode(maskMode === 'black' ? 'off' : 'black'),
          active: maskMode === 'black',
          title: '黑屏：临时遮住整页'
        },
        {
          id: 'mask-magnifier',
          label: '放大镜',
          icon: <ScanSearch size={16} aria-hidden="true" />,
          onClick: () => setMaskMode(maskMode === 'magnifier' ? 'off' : 'magnifier'),
          active: maskMode === 'magnifier',
          title: '放大镜：跟随鼠标放大局部'
        }
      ]
    },
    {
      name: '面板',
      items: [
        {
          id: 'left-panel',
          label: '左侧栏',
          icon: <LayoutPanelLeft size={16} aria-hidden="true" />,
          onClick: () => toggleSidebar(),
          active: showSidebar,
          title: '左侧栏（缩略图 / 目录 / 搜索）'
        },
        {
          id: 'search',
          label: '搜索',
          icon: <Search size={16} aria-hidden="true" />,
          onClick: () => setShowSearch(!showSearch),
          active: showSearch,
          disabled: !hasDoc,
          title: '搜索全文（Ctrl+F）'
        },
        {
          id: 'tools',
          label: '工具箱',
          icon: <Briefcase size={16} aria-hidden="true" />,
          onClick: () => setShowTools(true),
          title: 'PDF 工具箱（全部工具）'
        },
        {
          id: 'settings',
          label: '设置',
          icon: <Settings size={16} aria-hidden="true" />,
          onClick: () => setShowSettings(true),
          title: '设置'
        }
      ]
    }
  ]

  const groups: RibbonGroup[] =
    tab === 'home' ? homeGroups : tab === 'file' ? fileGroups : tab === 'tools' ? toolGroupList : viewGroups

  /** 当前页所有按钮（「更多 ▾」里要按它查回被收起的项） */
  const allItems: RibbonItem[] = groups.reduce<RibbonItem[]>((acc, g) => acc.concat(g.items), [])
  const hiddenItems: RibbonItem[] = hidden
    .map((id) => allItems.find((it) => it.id === id))
    .filter((it): it is RibbonItem => Boolean(it))

  /**
   * 溢出测量：从右往左收，收到放得下为止。
   *
   * 为什么直接操作 DOM 再一次性 setState：
   *   逐个 setState 会让每个按钮都触发一轮 React 渲染，
   *   而这里最多要试十几次；量完截图式的还原是同步的，不会闪。
   */
  const measure = useCallback((): void => {
    const strip = stripRef.current
    if (!strip) return
    const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-ribbon-id]'))
    els.forEach((el) => {
      el.style.display = ''
    })
    const avail = strip.clientWidth
    if (avail <= 0) return
    const next: string[] = []
    const fits = (): boolean => strip.scrollWidth <= avail + 1
    if (!fits()) {
      for (let i = els.length - 1; i >= 0; i -= 1) {
        const el = els[i]
        const id = el.dataset.ribbonId ?? ''
        if (!id) continue
        el.style.display = 'none'
        next.unshift(id)
        if (fits()) break
      }
    }
    /* 还原成「最终该有的样子」，避免测量把已收起的按钮又露出来 */
    els.forEach((el) => {
      el.style.display = next.includes(el.dataset.ribbonId ?? '') ? 'none' : ''
    })
    setHidden((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
  }, [])

  const groupsKey = `${tab}|${groups.map((g) => g.items.map((i) => i.id).join(',')).join(';')}|${
    editDock ? 'dock' : 'nodock'
  }`

  useLayoutEffect(() => {
    measure()
  }, [measure, groupsKey, size, collapsed])

  /* 窗口/侧栏变化导致的宽度变化由它兜住（工具栏宽度不只由窗口决定） */
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(strip)
    return () => ro.disconnect()
  }, [measure, collapsed, tab])

  /* 切页 / 收起时把浮层都关掉，避免「开着菜单却换了页」 */
  useEffect(() => {
    setMoreOpen(false)
    setRecentOpen(false)
  }, [tab, collapsed])

  /* ---------- 收起态：28px 常驻窄条 ---------- */
  if (collapsed) {
    return (
      <div className="ribbon ribbon--collapsed" data-size={size} ref={rootRef}>
        <button
          type="button"
          className="ribbon__peek"
          data-tb-id="ribbon-expand"
          onClick={() => setCollapsed(false)}
          title="展开工具条（Ctrl+F1）"
          aria-label="展开工具条"
        >
          <ChevronRight size={14} aria-hidden="true" />
          <span className="ribbon__peek-label">展开工具条</span>
        </button>
      </div>
    )
  }

  return (
    <div className="ribbon" data-size={size} ref={rootRef} role="toolbar" aria-label="功能区">
      {/* ---------- 目录条 ---------- */}
      <div className="ribbon__tabs" role="tablist" aria-label="功能区目录">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className={`ribbon__tab ${tab === t.id ? 'is-active' : ''}`}
            data-tb-id={`ribbon-tab-${t.id}`}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}

        <span className="ribbon__tabs-spacer" />

        {/* 页码导航：与目录无关，常驻右侧（翻页是每节课都要用的） */}
        <div className="ribbon__pager">
          <button
            type="button"
            className="ribbon__icon-btn"
            data-tb-id="page-prev"
            onClick={prevPage}
            disabled={!hasDoc || page <= 1}
            title="上一页（← / PageUp）"
            aria-label="上一页"
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <div className="ribbon__pagebox">
            <input
              className="ribbon__page-input"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitPage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitPage()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              disabled={!hasDoc}
              aria-label="页码"
            />
            <span className="ribbon__page-total">/ {pageCount || '—'}</span>
          </div>
          <button
            type="button"
            className="ribbon__icon-btn"
            data-tb-id="page-next"
            onClick={nextPage}
            disabled={!hasDoc || page >= pageCount}
            title="下一页（→ / PageDown）"
            aria-label="下一页"
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>

        {/* OCR：扫描件没有文字层时唯一的入口，一直露在外面 */}
        <button
          type="button"
          className="ribbon__icon-btn"
          data-tb-id="ocr-page"
          onClick={() => requestOcr()}
          disabled={!hasDoc}
          title="识别扫描页文字（OCR）"
          aria-label="识别扫描页文字"
        >
          <ScanText size={15} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="ribbon__collapse"
          data-tb-id="ribbon-collapse"
          onClick={() => setCollapsed(true)}
          title="收起工具条（Ctrl+F1），腾出正文空间"
          aria-label="收起工具条"
        >
          <ChevronUp size={14} aria-hidden="true" />
          <span>收起</span>
        </button>
      </div>

      {/* ---------- 功能条 ---------- */}
      {/*
        功能带外壳：strip（可裁剪）+ 「更多 ▾」（不可裁剪）。
        两者必须是**兄弟**关系 —— 「更多」的浮层是绝对定位的，
        若把它放进 .ribbon__strip 里，会被 strip 的 overflow:hidden 裁掉，
        表现为「点了更多却什么都不出现」。
      */}
      <div className="ribbon__body">
        <div className="ribbon__strip" ref={stripRef}>
        {groups.map((g) => (
          <div className="ribbon__group" key={`${tab}-${g.name}`}>
            <div className="ribbon__group-body">
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  data-tb-id={it.id}
                  data-ribbon-id={it.id}
                  className={`ribbon__btn ${it.active ? 'is-active' : ''}`}
                  style={hidden.includes(it.id) ? { display: 'none' } : undefined}
                  onClick={it.onClick}
                  disabled={it.disabled}
                  title={it.title ?? it.label}
                  aria-label={it.label}
                  aria-pressed={it.active}
                >
                  <span className="ribbon__ico" aria-hidden="true">
                    {it.icon}
                  </span>
                  <span className="ribbon__lbl">{it.label}</span>
                </button>
              ))}
              {g.extra}
            </div>
            <span className="ribbon__group-label">{g.name}</span>
          </div>
        ))}
        </div>

        {/* ---------- 更多 ▾ ---------- */}
        <div className="ribbon__more">
          <button
            type="button"
            className="ribbon__btn ribbon__more-btn"
            data-tb-id="ribbon-more"
            aria-pressed={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            title={hiddenItems.length > 0 ? `还有 ${hiddenItems.length} 个功能（窗口太窄）` : '更多'}
            aria-label="更多功能"
          >
            <span className="ribbon__ico" aria-hidden="true">
              <MoreHorizontal size={16} />
            </span>
            <span className="ribbon__lbl">更多</span>
          </button>

          {moreOpen ? (
            <>
              <div className="ribbon__scrim" onClick={() => setMoreOpen(false)} aria-hidden="true" />
              <div className="ribbon__menu" role="menu">
                {hiddenItems.length === 0 ? (
                  <span className="ribbon__menu-empty">当前宽度下所有按钮都已显示</span>
                ) : (
                  hiddenItems.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      role="menuitem"
                      className="ribbon__menu-item"
                      disabled={it.disabled}
                      onClick={() => {
                        setMoreOpen(false)
                        it.onClick()
                      }}
                    >
                      <span className="ribbon__menu-ico" aria-hidden="true">
                        {it.icon}
                      </span>
                      <span>{it.label}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------- 内容编辑选项行（有则多一行，没有就完全不占高度） ---------- */}
      {editDock ? <div className="drawbar__editdock">{editDock}</div> : null}

      {/* ---------- 最近文件浮层 ---------- */}
      {recentOpen ? (
        <>
          <div className="ribbon__scrim" onClick={() => setRecentOpen(false)} aria-hidden="true" />
          <div className="ribbon__panel" role="dialog" aria-label="最近文件">
            <div className="ribbon__panel-head">
              <span>最近文件</span>
              <button
                type="button"
                className="ribbon__icon-btn"
                onClick={() => setRecentOpen(false)}
                aria-label="关闭"
                title="关闭"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {recent.length === 0 ? (
              <span className="ribbon__menu-empty">还没有打开过文档</span>
            ) : (
              recent.slice(0, 10).map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className="ribbon__panel-item"
                  onClick={() => {
                    setRecentOpen(false)
                    void openFile(r.path)
                  }}
                  title={r.path}
                >
                  <span className="ribbon__panel-name">{r.name}</span>
                  <span className="ribbon__panel-sub">第 {r.page} 页</span>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}

      {newPdfOpen ? <NewPdfDialog onClose={() => setNewPdfOpen(false)} /> : null}
    </div>
  )
}
