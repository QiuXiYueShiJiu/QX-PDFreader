// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 功能区「开始」页的分组定义。
 *
 * ── 这个文件现在只负责什么 ────────────────────────────────────
 *   它不再自己画工具条，也不管画笔颜色/粗细 —— 那些在底部悬浮条里
 *   （`BottomDock.tsx`，用户 2026-10-27 要求「画笔与橡皮还有调色盘还有粗细选择
 *   还有清屏是放在下栏悬浮栏」）。这里只把「开始」页的**文档级**操作
 *   （漫游 / 插入类编辑工具 / 页面结构编辑 / 撤销重做）交给 RibbonTabs 渲染。
 *
 * ── store 里的互斥关系（关键，改按钮时必须一起改）──────────────
 *   setEditTool / setDrawMode / setEraserMode 互相把对方清空，
 *   所以 漫游 / 画笔 / 橡皮 / 八个编辑工具 是**十一选一**：
 *   屏幕上永远只有一个按钮是亮的，用户看屏幕就知道
 *   「现在点在页面上会发生什么」。
 *
 * ── 为什么再点一次当前编辑工具 = 回到漫游 ──────────────────────
 *   触屏上找不到退路很烦（Esc 在有些一体机键盘上没有），
 *   所以把「同一个按钮再点一次」也做成出口。
 */

import { useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Circle,
  Columns2,
  FileMinus2,
  FilePlus2,
  Hand,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  PaintBucket,
  Redo2,
  Square,
  Type,
  Undo2
} from 'lucide-react'
import type { EditTool } from '@shared/types'
import { useViewer } from '../store'
import { RibbonTabs } from './RibbonTabs'
import type { RibbonGroup } from './RibbonTabs'
import { getEditBarRenderer, subscribeEditBar } from './edit/ContentEditBridge'

/*
 * 调色盘已经搬到 `pen-colors.ts`（下栏与编辑条共用一份）。
 * 这里保留再导出，别处 `import { PEN_COLORS } from '../DrawToolbar'` 不用改。
 */
export { PEN_COLORS } from './pen-colors'

/**
 * 内容编辑工具（2026-10-16 用户要求：「工具栏增加选择功能」）。
 *
 * ── 为什么和漫游并列 ────────────────────────────────────────
 *   它们与漫游一样都是「在页面上按一下会发生什么」的模式选择，
 *   分成两组会让用户判断不出此刻哪个模式生效。
 *
 * ── hint 为什么写这么细 ──────────────────────────────────────
 *   触屏一体机上老师不会去读文档，按钮上的 title 就是全部操作说明。
 */
const EDIT_TOOLS: ReadonlyArray<{
  id: Exclude<EditTool, 'none'>
  label: string
  hint: string
  icon: typeof MousePointer2
}> = [
  {
    id: 'select',
    label: '选择',
    hint: '选择：拖选页面文字，可复制 / 高亮 / 下划线',
    icon: MousePointer2
  },
  {
    id: 'text',
    label: '文字',
    hint: '文字：在页面上点一下输入文字，回车确认',
    icon: Type
  },
  {
    id: 'image',
    label: '图片',
    hint: '图片：先选图或 Ctrl+V 粘贴，再在页面上点一下放置',
    icon: ImageIcon
  },
  {
    id: 'whiteout',
    label: '涂白',
    hint: '涂白：拖一个白块盖住原内容',
    icon: PaintBucket
  },
  {
    id: 'rect',
    label: '矩形',
    hint: '矩形：拖动绘制矩形框',
    icon: Square
  },
  {
    id: 'ellipse',
    label: '椭圆',
    hint: '椭圆：拖动绘制椭圆框',
    icon: Circle
  },
  {
    id: 'line',
    label: '直线',
    hint: '直线：按下拖动，松手得到一条直线',
    icon: Minus
  },
  {
    id: 'arrow',
    label: '箭头',
    hint: '箭头：从起点拖到要指向的位置',
    icon: ArrowUpRight
  }
]

export function DrawToolbar({ zone = 'edit' }: { zone?: 'edit' | 'pen' } = {}): JSX.Element | null {
  const drawMode = useViewer((s) => s.drawMode)
  const eraserMode = useViewer((s) => s.eraserMode)
  const annotations = useViewer((s) => s.annotations)
  /** 内容编辑工具当前选中项 */
  const editTool = useViewer((s) => s.editTool)
  const setEditTool = useViewer((s) => s.setEditTool)
  /** 回到漫游（出口）—— 画笔 / 橡皮 / 编辑工具 与它十一选一 */
  const setRoam = useViewer((s) => s.setRoam)
  const undo = useViewer((s) => s.undo)
  const redo = useViewer((s) => s.redo)
  /* 订阅栈深而非派生布尔值：顺带能在 title 里显示剩余步数 */
  const historyDepth = useViewer((s) => s.history.length)
  const futureDepth = useViewer((s) => s.future.length)
  /* 页面结构编辑（插入空白页 / 删除本页） */
  const insertBlankPage = useViewer((s) => s.insertBlankPage)
  const deleteCurrentPage = useViewer((s) => s.deleteCurrentPage)
  const compareOpen = useViewer((s) => s.compareOpen)
  const openComparePane = useViewer((s) => s.openComparePane)
  const closeComparePane = useViewer((s) => s.closeComparePane)

  /**
   * 订阅「编辑条渲染入口」。
   *
   * 为什么用版本号而不是把 React 节点塞进 state：
   *   节点是每次都新建的，塞进 state 会让「同一次渲染里 setState」变成死循环；
   *   版本号只在**注册变化**时自增，稳定且能触发重渲染。
   */
  const [editBarVersion, setEditBarVersion] = useState(0)
  useEffect(() => subscribeEditBar(setEditBarVersion), [])
  /*
   * ★ 必须**调用**渲染入口拿到节点；直接把它当元素渲染会得到
   *   「函数不是 ReactNode」的类型错误（tsc 会拦住，运行时则是空白）。
   */
  const editBar = getEditBarRenderer()?.() ?? null
  void editBarVersion // 依赖它触发重渲染：注册变化时版本号变，这里就会重新取一次

  /** 漫游态：没有画笔、没有橡皮、也没选编辑工具 */
  const roaming = editTool === 'none' && !drawMode && !eraserMode

  /* ---------- 分组（顺序 = 从常用到不常用，窄屏时先收掉靠右的） ---------- */

  const insertGroup: RibbonGroup = {
    name: '插入',
    items: [
      /*
       * 分屏对比（2.0.0 B12）：左边主文档、右边参考文档。
       * 放在「插入」组最前面 —— 它是「打开另一份文档」这一类动作，
       * 不跟画笔/涂白混在一起。
       */
      {
        id: 'compare-toggle',
        label: '对比',
        icon: <Columns2 size={16} aria-hidden="true" />,
        onClick: () => (compareOpen ? closeComparePane() : openComparePane()),
        active: compareOpen,
        title: compareOpen ? '退出对比：关掉右侧参考窗' : '分屏对比：右边开一份独立文档，只读'
      },
      {
        id: 'roam',
        label: '漫游',
        icon: <Hand size={16} aria-hidden="true" />,
        onClick: () => setRoam(),
        active: roaming,
        title: roaming
          ? '漫游中：拖动页面平移，双指捏合 / 滚轮缩放'
          : '漫游：拖动页面平移，双指捏合 / 滚轮缩放（Esc 直接回到漫游）'
      },
      ...EDIT_TOOLS.map((t) => {
        const Icon = t.icon
        const active = editTool === t.id
        return {
          /*
           * data-tb-id 是自动化用例的锚点：按工具的英文 id 命名，
           * 不用中文标签，避免以后改文案把用例改崩。
           */
          id: `edit-${t.id}`,
          label: t.label,
          icon: <Icon size={16} aria-hidden="true" />,
          onClick: () => setEditTool(active ? 'none' : t.id),
          active,
          title: active ? `${t.hint}（再点一次回到漫游）` : t.hint
        }
      })
    ]
  }

  /*
   * 页面结构编辑（2026-10-27 用户需求：「编辑功能里面可以新建空白页或删除空白页」）。
   *
   * 放在「插入」组里而不是另开一组：
   *   · 老师的心智是「往文档里加一页 / 去掉一页」，和插文字插图片是同一类操作；
   *   · 单条功能区的宽度已经吃紧，另开一组会把别的按钮挤进「更多」。
   * 改的是工作副本，原文件一个字节都不动（见主进程 insertBlankPage / deletePage）。
   */
  insertGroup.items.push(
    {
      id: 'page-insert-blank',
      label: '加页',
      icon: <FilePlus2 size={16} aria-hidden="true" />,
      onClick: () => void insertBlankPage(),
      title: '在当前页前面插入一张空白页（尺寸跟随上一页）'
    },
    {
      id: 'page-delete',
      label: '删页',
      icon: <FileMinus2 size={16} aria-hidden="true" />,
      onClick: () => void deleteCurrentPage(),
      title: '删除当前页（只剩一页时不能删）'
    }
  )

  const actionGroup: RibbonGroup = {
    name: '编辑',
    items: [
      {
        id: 'undo',
        label: '撤销',
        icon: <Undo2 size={16} aria-hidden="true" />,
        onClick: () => undo(),
        disabled: historyDepth === 0,
        title: historyDepth > 0 ? `撤销上一步（Ctrl+Z），可撤 ${historyDepth} 步` : '撤销上一步（Ctrl+Z）'
      },
      {
        id: 'redo',
        label: '重做',
        icon: <Redo2 size={16} aria-hidden="true" />,
        onClick: () => redo(),
        disabled: futureDepth === 0,
        title: futureDepth > 0 ? `重做（Ctrl+Y），可重做 ${futureDepth} 步` : '重做（Ctrl+Y）'
      }
    ]
  }

  /*
   * ★ 只有两组：颜色 / 粗细 / 清屏 / 画笔 / 橡皮全在下栏悬浮条（BottomDock）。
   *   `annotations` 仍在这里订阅：删除批注后「撤销」可用性会变，靠它触发重渲染。
   */
  void annotations

  const homeGroups: RibbonGroup[] = [insertGroup, actionGroup]

  /*
   * zone='pen' 是历史遗留（授课类工具曾单独挂在底部胶囊里）。
   * 现在上栏只有一条功能区、画笔在下栏悬浮条，App 也只渲染默认的 edit 实例；
   * 保留这个 prop 是为了不破坏其它分支的调用方。
   */
  return <RibbonTabs homeGroups={homeGroups} editDock={zone === 'edit' ? editBar : null} />
}
