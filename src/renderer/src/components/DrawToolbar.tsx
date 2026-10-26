// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 绘图工具面板 —— 悬浮在阅读区上的批注工具条。
 *
 * 设计参考：
 *   · 鸿合 π6 的「批注」面板（现场调研，见 docs/鸿合π6-界面调研.md）
 *   · PowerPoint 放映时的墨迹工具条（用户明确点名要「类似 PPT」）
 *
 * 解决的两个实际问题（用户反馈）：
 *   ① 颜色盘原先出现两次（顶部工具栏 5 个 + 左侧栏 6 个），
 *      位置分散、数量还不一致。现在收敛成唯一一个面板，
 *      位置固定在阅读区底部居中 —— 与 PPT 的习惯一致，触屏也好够到。
 *   ② 粗细原先用连续滑块（78×16px），手指根本拖不准。
 *      π6 用的是三个离散圆点，实践证明更适合触屏，
 *      这里采用同样的做法，并把档位做成可视化的粗细预览。
 *
 * 为什么做成悬浮条而不是常驻面板：
 *   阅读区越大越好。工具条只在手绘模式下出现，退出即隐藏，
 *   不挤压正文空间。
 */

import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Circle,
  Eraser,
  Hand,
  Image as ImageIcon,
  MousePointer2,
  PaintBucket,
  Palette,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2
} from 'lucide-react'
import type { EditTool } from '@shared/types'
import { useViewer } from '../store'
import { SlideToClear } from './SlideToClear'
import { getEditBarRenderer, subscribeEditBar } from './edit/ContentEditBridge'

/**
 * 画笔颜色。
 *
 * 比 π6 的六色更克制：教学批注常用红蓝黑，
 * 因此把这三个排在前面，其余作为补充。
 *
 * ★ 导出为具名常量：顶部浮动编辑条（components/edit/EditBar.tsx）的
 *   调色板复用同一份色表，否则两处颜色会各自漂移、用户看着像两套工具。
 */
export const PEN_COLORS = [
  { value: '#e5484d', label: '红' },
  { value: '#2f7fe8', label: '蓝' },
  { value: '#1a9e5c', label: '绿' },
  { value: '#f5a623', label: '橙' },
  { value: '#a855f7', label: '紫' },
  { value: '#111418', label: '黑' }
] as const

/**
 * 橡皮大小档位。
 *
 * 用离散档位而不是滑块，理由与画笔粗细相反：
 *   画笔粗细需要「再粗一点点」的连续微调，所以用滑块；
 *   橡皮大小是「大概擦多大范围」，三档足够，
 *   而且橡皮常在移动中使用（手已经离开工具条去点页面了），
 *   离散档位一次点准比拖滑块更省事。
 * 这与 π6 的做法一致（它的橡皮大小就是三个圆点）。
 */
/**
 * 橡皮大小范围（与 store 的 setEraserSize 保持一致）。
 *
 * 曾经用三个离散档位（小/中/大），实测「想再小一点」这类
 * 微调需求做不到，改成连续滑块。
 */
const ERASER_MIN = 3
const ERASER_MAX = 48

/**
 * 画笔粗细范围。
 *
 * 用连续滑块而不是离散档位 ——
 * 中间试过做成 π6 那样的四个圆点档位，但实测教学场景里
 * 「稍微粗一点」这种微调需求很常见，档位跨度太大反而不好用。
 * 滑块保留，两端做好触摸热区即可（见样式里的高度设置）。
 */
const WIDTH_MIN = 1
const WIDTH_MAX = 16
const WIDTH_STEP = 0.5

/**
 * 内容编辑工具（2026-10-16 用户要求：「工具栏增加选择功能——可以编辑 PDF 上的文字等等内容」）。
 *
 * ── 为什么和画笔/橡皮并列放在同一条工具条里 ──────────────────
 *   它们与画笔/橡皮一样都是「在页面上按一下会发生什么」的模式选择，
 *   分开成第二条工具条会让用户判断不出此刻哪个模式生效。
 *   store 里 setEditTool / setDrawMode / setEraserMode 互相把对方清空，
 *   因此六个编辑工具 + 画笔 + 橡皮 + 漫游 天然是**九选一**。
 *
 * ── hint 为什么要写这么细 ────────────────────────────────────
 *   触屏一体机上老师不会去读文档，工具条上的一句话提示
 *   就是全部的操作说明（尤其是「先选图片再点页面」这种两步动作）。
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
  }
]

/**
 * 工具条拆两条（用户要求：备课类在顶栏，授课类在底部悬浮）：
 *   zone='edit' —— 顶栏 Office 式工具带：文字 / 图片 / 涂白 / 矩形 / 椭圆 + 撤销重做 + 清屏
 *   zone='pen'  —— 底部悬浮：漫游 / 画笔 / 橡皮 / 选择 + 颜色 + 粗细 + 撤销重做
 * 两个实例共享 store 状态，互不干扰；editBar 只在顶栏渲染一次，避免两处重复。
 */
export function DrawToolbar({ zone = 'edit' }: { zone?: 'edit' | 'pen' } = {}): JSX.Element | null {
  const drawMode = useViewer((s) => s.drawMode)
  const drawColor = useViewer((s) => s.drawColor)
  const drawWidth = useViewer((s) => s.drawWidth)
  const eraserMode = useViewer((s) => s.eraserMode)
  const eraserSize = useViewer((s) => s.eraserSize)
  const annotations = useViewer((s) => s.annotations)
  /* 内容编辑工具（选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆）当前选中项 */
  const editTool = useViewer((s) => s.editTool)
  const setEditTool = useViewer((s) => s.setEditTool)

  const setDrawColor = useViewer((s) => s.setDrawColor)
  const setDrawWidth = useViewer((s) => s.setDrawWidth)
  const setDrawMode = useViewer((s) => s.setDrawMode)
  const setEraserMode = useViewer((s) => s.setEraserMode)
  const setEraserSize = useViewer((s) => s.setEraserSize)
  /** 回到漫游（第三个工具）—— 画笔 / 橡皮 / 漫游 三选一 */
  const setRoam = useViewer((s) => s.setRoam)
  /** 撤销 / 重做（多步，由 store 的历史栈驱动） */
  const undo = useViewer((s) => s.undo)
  const redo = useViewer((s) => s.redo)
  /* 订阅栈深而非派生布尔值：顺带能在 title 里显示剩余步数 */
  const historyDepth = useViewer((s) => s.history.length)
  const futureDepth = useViewer((s) => s.future.length)
  const clearAnnotations = useViewer((s) => s.clearAnnotations)

  /*
   * 工具条**常驻显示**（不再随 drawMode 隐藏）。
   *
   * 用户明确要求「画笔设置栏常驻，可以选择画笔、橡皮」——
   * 原先只在手绘模式出现，想调颜色得先进入模式，
   * 课堂上多一步操作很别扭。现在常驻，随时可切换工具与颜色。
   *
   * ★★ 三选一（2026-10-16 用户要求）：
   *   画笔 / 橡皮 / 漫游 —— 工具栏**恒有且只有一个**处于激活状态。
   *   原先最左边是「退出绘画」，退出后三个按钮全灭（谁都不激活），
   *   用户看屏幕无法判断「现在点在页面上会发生什么」。
   *   现在把那个出口动作换成**漫游**这个正式工具（手形图标）：
   *   漫游 = 拖动页面平移 + 双指/滚轮缩放，也就是「没在批注时」的默认态。
   */

  /*
   * ---------- 收起态 ----------
   *
   * ── 为什么需要（这是「橡皮擦不了」的真正原因）────────────
   *   工具条是 fixed 悬浮在底部中央的，实测占 99px 高。
   *   它会**盖住页面最下面那条内容** —— 点击落在工具条上而不是页面，
   *   所以那片区域的笔迹既擦不到、也画不上。
   *   老师板书多集中在页面下半部，正好撞上。
   *
   * 光靠给内容加底部内边距不够：那只是让用户能滚上来，
   * 但正在看的那一页仍然被挡着。因此再给一个**收起**开关，
   * 需要操作底部内容时把工具条缩成一个小圆钮，完全不挡。
   */
  const [collapsed, setCollapsed] = useState(false)

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
   * ★ 这里必须**调用**渲染入口拿到节点；直接把它当元素渲染会得到
   *   「函数不是 ReactNode」的类型错误（tsc 会拦住，运行时则是空白）。
   */
  const editBar = getEditBarRenderer()?.() ?? null
  void editBarVersion // 依赖它触发重渲染：注册变化时版本号变，这里就会重新取一次

  if (collapsed) {
    return (
      <button
        className="drawbar__peek"
        onClick={() => setCollapsed(false)}
        title="展开批注工具条"
        aria-label="展开批注工具条"
      >
        <Palette size={18} aria-hidden="true" />
        <span className="drawbar__peek-label">工具条</span>
      </button>
    )
  }

  /**
   * 当前激活的工具（九选一，永远有值）。
   *
   * ★ 必须把 editTool 也算进来：编辑工具激活时 drawMode/eraserMode
   *   本来就是 false，只判断这两个会让「漫游」在编辑文字时也亮着，
   *   屏幕上就有两个亮点，用户判断不出点在页面上会发生什么。
   */
  const roaming = editTool === 'none' && !drawMode && !eraserMode

  return (
    <div
      className={`drawbar drawbar--ribbon drawbar--zone-${zone}${zone === 'pen' ? ' drawbar--dock' : ''}`}
      role="toolbar"
      aria-label={zone === 'pen' ? '授课工具（画笔）' : '编辑工具（备课）'}
    >
      {/*
        ---------- 内容编辑的功能区（合并到本工具条）----------
        用户要求：选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆 唤出的那条
        「选项 + 导出」工具栏，要**合并到全局底部工具条**里，
        不要再单独浮在阅读区顶部（同一屏两处有工具，一体机上要来回找）。

        为什么放在最上面一行：底部一行是**工具选择**（所有模式都在），
        这一行是**当前工具的选项**。视觉上「上=选项、下=工具」稳定，
        切换工具时下面那行不动，只有上面这行换内容。

        内容由 edit/ContentEditBridge 注册进来（真实状态在 useContentEdit 里）。
        没有进入编辑态时渲染 null，这一行完全不存在、不多占高度。
      */}
      {zone === 'edit' && editBar ? (
        <div className="drawbar__editdock" data-edit-dock="1">
          {editBar}
        </div>
      ) : null}

      {/*
        ---------- 工具行（下面那一行）----------
        把「工具选择 + 颜色 + 粗细 + 撤销 + 清屏 + 收起」全部包进一个
        `.drawbar__tools` 容器，是因为两行的**溢出策略必须不同**：

          · 工具行：单行 + 超宽横向滚动（原来的行为，按钮窄、几乎不会滚）
          · 编辑功能区：允许折行，**绝不**横向滚动

        不拆开时，编辑选项（字号 6 档 + 6 色 + 导出按钮 ≈ 454px）
        会和工具行叠在一起，触发横向滚动，编辑区按钮被推到视口之外
        —— 实测 x=1669 而视口只有 1440，症状是「工具按钮全部点不动」。
      */}
      <div className="drawbar__tools">
      {/* ---------- 漫游（最左） ---------- */}
      {/*
        按用户要求占据原先「退出绘画」的位置（工具条最左端），图标是一只手。

        为什么放在画笔之前：
          它是这条工具条的**出口**，与「进入绘画」的画笔相邻，
          一进一出挨在一起，符合从左到右的操作顺序。

        与旧的「退出绘画」的区别（关键）：
          旧按钮 disabled={!drawMode} —— 未进入绘画时它是灰的，
          等于「没有工具激活」；现在它是一个**正式工具**，
          没在画的时候它自己就是激活态，工具栏永远有且只有一个亮点。
      */}
      <button
        className={`drawbar__roam-fab ${roaming ? 'is-active' : ''}`}
        onClick={() => setRoam()}
        title={
          roaming
            ? '漫游中：拖动页面平移，双指捏合 / 滚轮缩放'
            : '漫游：拖动页面平移，双指捏合 / 滚轮缩放（Esc 直接回到漫游）'
        }
        aria-label="漫游"
        aria-pressed={roaming}
      >
        <Hand size={18} aria-hidden="true" />
        <span>漫游</span>
      </button>

      {/* ---------- 画笔 / 橡皮 切换 ---------- */}
      <div data-group-name="开始" className="drawbar__group">
        <button
          /*
           * 画笔按钮的两种状态：
           *   drawMode && !eraserMode → 正在绘画（高亮）
           *   其余                     → 点击进入绘画（从漫游或橡皮切过来）
           *
           * ★ 已经激活时再点**不再退出**（旧行为是退出到「谁都不激活」）。
           *   要退出请点「漫游」或按 Esc —— 出口只有一个，不会误触。
           */
          className={`drawbar__tool ${drawMode && !eraserMode ? 'is-active' : ''}`}
          onClick={() => {
            setEraserMode(false)
            setDrawMode(true)
          }}
          title={
            drawMode && !eraserMode
              ? '正在绘画（已是当前工具）；要回到漫游请点「漫游」或按 Esc'
              : '画笔：在页面上圈画（会切到绘画工具）'
          }
          aria-pressed={drawMode && !eraserMode}
          aria-label="画笔"
        >
          <Pencil size={18} aria-hidden="true" />
          <span>{drawMode && !eraserMode ? '绘画中' : '画笔'}</span>
        </button>
        <button
          className={`drawbar__tool ${eraserMode ? 'is-active' : ''}`}
          onClick={() => {
            setDrawMode(true)
            setEraserMode(true)
          }}
          disabled={annotations.length === 0}
          title={
            eraserMode
              ? '橡皮中（已是当前工具）；要回到漫游请点「漫游」或按 Esc'
              : '橡皮：点住笔迹擦除'
          }
          aria-pressed={eraserMode}
          aria-label="橡皮"
        >
          <Eraser size={18} aria-hidden="true" />
          <span>橡皮</span>
        </button>
      </div>

      {/* ---------- 内容编辑工具（选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆） ---------- */}
      {/*
        与画笔/橡皮并列成一组：它们同样是「点在页面上会发生什么」的模式开关。
        ★ 再点一次当前工具 = 回到漫游（与「漫游」按钮同一个出口），
          避免用户在编辑态里找不到退路 —— 触屏上多一步「先找漫游」很烦。
      */}
      <div data-group-name="插入" className="drawbar__group drawbar__group--edit" role="group" aria-label="内容编辑工具">
        {EDIT_TOOLS.map((t) => {
          const Icon = t.icon
          const active = editTool === t.id
          return (
            <button
              key={t.id}
              /*
               * data-tb-id 是自动化用例的锚点：按工具的英文 id 命名，
               * 不用中文标签，避免以后改文案把用例改崩。
               */
              data-tb-id={`edit-${t.id}`}
              className={`drawbar__tool drawbar__tool--edit ${active ? 'is-active' : ''}`}
              onClick={() => setEditTool(active ? 'none' : t.id)}
              title={active ? `${t.hint}（再点一次回到漫游）` : t.hint}
              aria-label={t.label}
              aria-pressed={active}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      {/* ---------- 颜色 ---------- */}
      {/*
        ★ 退出绘画后要**置灰不可选**（用户反馈的轻微 bug）。
          颜色只对画笔有意义：没在绘画时点颜色不会立刻看到效果，
          留着高亮可点会让人以为「点了没反应」。
          用 disabled 而不是隐藏 —— 用户明确要求不隐藏任何工具条图标。
      */}
      <div
        data-group-name="颜色" className={`drawbar__group drawbar__group--colors ${!drawMode ? 'is-muted' : ''}`}
        role="group"
        aria-label="画笔颜色"
      >
        {PEN_COLORS.map((c) => (
          <button
            key={c.value}
            className={`drawbar__color ${drawColor === c.value ? 'is-active' : ''}`}
            style={{ ['--pen-color' as string]: c.value }}
            onClick={() => setDrawColor(c.value)}
            /*
             * 两种禁用原因合并：橡皮中（橡皮不画线）或未进入绘画。
             * 置灰由父级的 is-muted 负责，这里只管可点性。
             */
            disabled={eraserMode || !drawMode}
            title={
              !drawMode
                ? '先点「画笔」进入绘画模式，再选颜色'
                : eraserMode
                  ? '橡皮模式下不改颜色，切回画笔即可'
                  : `画笔颜色：${c.label}`
            }
            aria-label={`画笔颜色 ${c.label}`}
            aria-pressed={drawColor === c.value}
          />
        ))}
      </div>

      {/* ---------- 粗细（连续滑块 + 实时预览） / 橡皮大小 ---------- */}
      {eraserMode ? (
        /*
         * 橡皮模式：把粗细滑块换成橡皮大小滑块。
         * 两者不会同时有用（橡皮不画线），因此共用同一块位置，
         * 工具条不会因为多一排控件而变宽。
         *
         * ★ 从三档按钮改成连续滑块的原因：
         *   三档（小/中/大）跨度太大，实测「想再小一点」这种微调做不到。
         *   滑块 + 实时圆圈预览能精确调到想要的大小。
         *   拖滑块时页面上的橡皮光标圆圈会同步变化（eraserSize 驱动），
         *   所以不用看数字也能判断大小是否合适。
         */
        <div data-group-name="橡皮" className="drawbar__group drawbar__group--width" role="group" aria-label="橡皮大小">
          <span className="drawbar__group-label">橡皮</span>
          <span
            className="drawbar__preview drawbar__preview--eraser"
            aria-hidden="true"
            style={{
              // 预览圈按实际半径等比显示（上限 26px 免得撑破工具条）
              width: `${Math.min(26, eraserSize * 0.8 + 6)}px`,
              height: `${Math.min(26, eraserSize * 0.8 + 6)}px`
            }}
          />
          <input
            type="range"
            className="drawbar__slider"
            min={ERASER_MIN}
            max={ERASER_MAX}
            step={1}
            value={eraserSize}
            onChange={(e) => setEraserSize(Number(e.target.value))}
            aria-label="橡皮大小"
            title={`橡皮大小：${eraserSize}px（拖动可连续调节）`}
          />
          <output className="drawbar__readout">{eraserSize}</output>
        </div>
      ) : (
        /*
         * 画笔粗细。
         * 与颜色同理：未进入绘画时置灰不可拖（is-muted 负责视觉，
         * disabled 负责可操作性），但不隐藏。
         */
        <div
          data-group-name="画笔" className={`drawbar__group drawbar__group--width ${!drawMode ? 'is-muted' : ''}`}
          role="group"
          aria-label="画笔粗细"
        >
          {/*
            粗细预览点：直径直接等于当前笔宽（放大 2 倍便于观察细笔），
            拖动滑块时实时变化，不用凭数字猜。
          */}
          <span
            className="drawbar__preview"
            aria-hidden="true"
            style={{ width: `${Math.min(26, drawWidth * 1.6 + 4)}px`, height: `${Math.min(26, drawWidth * 1.6 + 4)}px` }}
          />
          <input
            type="range"
            className="drawbar__slider"
            min={WIDTH_MIN}
            max={WIDTH_MAX}
            step={WIDTH_STEP}
            value={drawWidth}
            onChange={(e) => setDrawWidth(Number(e.target.value))}
            disabled={!drawMode}
            aria-label="画笔粗细"
            title={drawMode ? `画笔粗细：${drawWidth}px` : '先点「画笔」进入绘画模式，再调粗细'}
          />
          <output className="drawbar__readout">{drawWidth}</output>
        </div>
      )}

      {/* ---------- 操作 ---------- */}
      <div data-group-name="编辑" className="drawbar__group">
        <button
          className="drawbar__tool"
          onClick={() => undo()}
          disabled={historyDepth === 0}
          title={historyDepth > 0 ? `撤销上一步（Ctrl+Z），可撤 ${historyDepth} 步` : '撤销上一步（Ctrl+Z）'}
        >
          <Undo2 size={18} aria-hidden="true" />
          <span>撤销</span>
        </button>
        <button
          className="drawbar__tool"
          onClick={() => redo()}
          disabled={futureDepth === 0}
          title={futureDepth > 0 ? `重做（Ctrl+Y），可重做 ${futureDepth} 步` : '重做（Ctrl+Y）'}
        >
          <Redo2 size={18} aria-hidden="true" />
          <span>重做</span>
        </button>
      </div>

      {/*
        ---------- 弹簧式滑动清屏 ----------
        借鉴 π6 的「滑动清页」：按住圆钮拖到底触发，松手回弹。
        比「连点两次确认」更明确（拖到底是刻意动作），
        又不像弹对话框那样打断课堂节奏。
      */}
      <SlideToClear
        label="滑动清屏"
        disabled={annotations.length === 0}
        onConfirm={() => void clearAnnotations()}
      />

      {/* ---------- 收起（最右） ---------- */}
      {/*
        收起按钮放最右：工具条变宽后，用户想腾出底部空间时
        不用满屏找 —— 位置固定在最右侧，肌肉记忆容易建立。
        收起后变成右下角一个小圆钮，几乎不挡内容。
      */}
      <button
        className="drawbar__tool drawbar__tool--collapse"
        onClick={() => setCollapsed(true)}
        title="收起工具条（腾出底部页面空间）"
        aria-label="收起工具条"
      >
        <ChevronDown size={18} aria-hidden="true" />
        <span>收起</span>
      </button>
      </div>
    </div>
  )
}
