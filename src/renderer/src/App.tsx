// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 应用主体。
 *
 * 布局（参考鸿合 π6 的双栏阅读器）：
 *   ┌──────────────── 标题栏 ────────────────┐
 *   │ 工具栏                                  │
 *   ├──────┬──────────────────────┬──────────┤
 *   │ 左栏 │      正文（可滚动）   │  右栏    │
 *   │缩略图│                      │ 文档信息 │
 *   │目录  │                      │ 批注     │
 *   │搜索  │                      │          │
 *   ├──────┴──────────────────────┴──────────┤
 *   │ 状态栏（文件名 / 页码 / 缩放 / 模式）    │
 *   └────────────────────────────────────────┘
 *
 * 键盘快捷键集中在这里注册（而不是散落各组件），
 * 便于统一判断「是否正在输入框里打字」而决定要不要拦截按键。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useViewer } from './store'
import { useDocument, DocumentView } from './components/DocumentView'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { TabBar } from './components/TabBar'
import { StatusBar, Toolbar } from './components/Toolbar'
import { SettingsPanel } from './components/SettingsPanel'
import { RecentFiles } from './components/RecentFiles'
import { LeftRail } from './components/LeftRail'
import { RightRail } from './components/RightRail'
import { DrawToolbar } from './components/DrawToolbar'
import { ToolsPanel } from './components/ToolsPanel'
import { ScreenMask } from './components/ScreenMask'
import { DisclaimerToast } from './components/DisclaimerToast'
import { UpdateToast } from './components/UpdateToast'
import { MarketPanel } from './components/MarketPanel'
import { useDropZone } from './hooks/useDropZone'
import { guardUnsaved, installCloseGuard, registerExporter } from './close-guard'

export default function App(): JSX.Element {
  const init = useViewer((s) => s.init)
  const settings = useViewer((s) => s.settings)
  const filePath = useViewer((s) => s.filePath)
  const fileName = useViewer((s) => s.fileName)
  const showSidebar = useViewer((s) => s.showSidebar)
  const showSettings = useViewer((s) => s.showSettings)
  const showTools = useViewer((s) => s.showTools)
  const toast = useViewer((s) => s.toast)
  const error = useViewer((s) => s.error)
  const recent = useViewer((s) => s.recent)

  const setShowSettings = useViewer((s) => s.setShowSettings)
  const setShowTools = useViewer((s) => s.setShowTools)
  const setError = useViewer((s) => s.setError)
  const openFile = useViewer((s) => s.openFile)
  const patchSettings = useViewer((s) => s.patchSettings)

  /* ---------- 批注 ---------- */
  const annotations = useViewer((s) => s.annotations)
  const loadAnnotations = useViewer((s) => s.loadAnnotations)
  const addAnnotation = useViewer((s) => s.addAnnotation)
  /** 橡皮擦除（局部切段，不是整条删除） */
  const eraseAt = useViewer((s) => s.eraseAt)

  /* ---------- 打开文档时加载其批注 ---------- */
  useEffect(() => {
    void loadAnnotations(filePath)
  }, [filePath, loadAnnotations])

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    void init()
  }, [init])

  /**
   * 主进程送来的打开请求（文件关联 / 命令行 / 第二次启动）。
   *
   * ★ 依赖必须是空数组。
   *   踩坑记录：这里原先依赖 [openFile]，而 zustand 的 store 在每次
   *   setState 后引用不变、但组件重渲染时会重新取到新的函数引用的情况
   *   会让 effect 反复重建监听器；配合主进程的 send，形成
   *   「打开 → setState → 重渲染 → 重订阅 → 再次打开」的无限循环，
   *   实测把同一份文件打开了上百次，最终把窗口拖垮退出。
   *   改用 store.getState() 取值，effect 只订阅一次，彻底断开这条链。
   */
  useEffect(() => {
    const off = window.pdfApp.onOpen((payload) => {
      void useViewer.getState().openFile(payload.path, undefined, payload.name)
    })
    /*
     * ★ 挂好监听后立刻向主进程报到（「不丢文件」握手）。
     *
     *   为什么要这一步：主进程 `webContents.send('pdf:open', …)` 在
     *   没有监听者时**不报错、消息直接丢**。冷启动带文件、或者刚启动
     *   就双击另一个 PDF 时，主进程可能比这里先执行 —— 丢没丢取决于
     *   首屏加载快慢，所以表现为「有概率打不开」。
     *   报到之后主进程才把排队的文件送过来，顺序也就确定了。
     *
     *   放在同一个 effect 里、紧跟订阅之后调用：这两件事必须原子地
     *   成对，分开写会出现「报了到但还没订阅」的窗口。
     */
    void window.pdfApp.app.rendererReady()
    return off
  }, [])

  /* ---------- 拖放打开 ---------- */
  const { dragging } = useDropZone((path) => void openFile(path))

  /* ---------- 任务栏/Alt+Tab 的窗口标题跟着当前标签走 ----------
   *  多标签下一个窗口承载多份文档，主进程不知道自己现在显示的是哪一份，
   *  所以由渲染层在激活文档变化时报一声（切标签、关标签都算）。 */
  useEffect(() => {
    if (filePath) window.pdfApp?.doc?.setActive?.(filePath)
  }, [filePath])

  /**
   * 关窗 / 退出：有没导出的编辑就先问用户。
   *
   * 三条路径都要拦：标题栏的关闭按钮（主进程转发 win:close-request）、
   * 右键任务栏关闭（同一条）、以及侧栏的「退出应用」（app:quit →
   * 主进程发现有脏数据也会转发过来）。
   * 依赖空数组：监听器只订一次，回调里一律用 store.getState() 取最新值。
   */
  useEffect(() => {
    const offDirty = installCloseGuard()

    const offClose = window.pdfApp.win.onCloseRequest(() => {
      void (async () => {
        if (await guardUnsaved('关闭窗口')) await window.pdfApp.win.forceClose()
      })()
    })

    const offQuit = window.pdfApp.app.onQuitRequest(() => {
      void (async () => {
        if (await guardUnsaved('退出应用')) await window.pdfApp.app.quitNow()
      })()
    })

    return () => {
      offDirty()
      offClose()
      offQuit()
    }
  }, [])

  /* ---------- 文档加载 ---------- */
  const { doc, error: docError } = useDocument(filePath)

  /**
   * 把导出实现注册给 close-guard。
   *
   * 关闭标签 / 关闭窗口 / 退出应用时如果还有没导出的编辑，
   * close-guard 会问用户「保存为 PDF / 不保存 / 取消」，选保存就走这里。
   * 为什么用动态 import：导出这条链会带上 pdf-lib 和整页位图，
   * 只在真的要保存时才需要，不必压在首屏包里。
   * 依赖 [doc]：换文档（切标签）时重新注册，保证导出的是当前这份。
   */
  useEffect(() => {
    if (!doc) {
      registerExporter(null)
      return
    }
    let alive = true
    void import('./anno-export').then((mod) => {
      if (!alive) return
      registerExporter(async () => {
        const state = useViewer.getState()
        const result = await mod.exportAnnotatedPdf({
          doc,
          filePath: state.filePath,
          annotations: state.annotations,
          fileName: state.fileName
        })
        if (result.ok) {
          // 导出成功才算「干净」；取消或失败都保留脏标记，避免误以为已保存
          useViewer.getState().markExported()
          useViewer.getState().showToast(`已导出：${result.path ?? ''}`, 3000)
        } else if (!result.canceled) {
          useViewer.getState().showToast(`导出失败：${result.error ?? '未知错误'}`, 3000)
        }
        return { ok: result.ok, canceled: result.canceled, error: result.error }
        // 第二个参数是这份导出实现对应的文档路径：守卫在切标签后会等它重新注册，
        // 避免把上一份文档的内容导出到新文件里（见 close-guard.ts）
      }, useViewer.getState().filePath)
    })
    return () => {
      alive = false
      registerExporter(null)
    }
  }, [doc])

  /* ---------- 恢复上次阅读位置 ---------- */
  useEffect(() => {
    if (!filePath || !doc || !settings.restoreLastPosition) return
    let cancelled = false
    void window.pdfApp.position.get(filePath).then((page) => {
      if (cancelled || !page || page <= 1) return
      useViewer.getState().setPage(page)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, doc, settings.restoreLastPosition])

  /**
   * 加入最近打开。
   *
   * ★ 用 ref 做幂等守卫，并且依赖只放 [filePath, doc]。
   *   踩坑记录：原先依赖里带 refreshRecent，而刷新最近列表会 setState
   *   触发重渲染，进而可能再次进入本 effect，形成无限写入循环。
   *   这里用「已记录的路径」判断，同一份文件只写一次。
   */
  const recentRecordedRef = useRef<string>('')
  useEffect(() => {
    if (!filePath || !doc) return
    if (recentRecordedRef.current === filePath) return
    recentRecordedRef.current = filePath

    void window.pdfApp.recent
      .push({ path: filePath, name: fileName, page: useViewer.getState().page })
      .then(() => useViewer.getState().refreshRecent())
  }, [filePath, doc, fileName])

  /* ---------- 阅读区尺寸（用于计算自适应缩放） ---------- */
  const viewerRef = useRef<HTMLDivElement>(null)
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      setViewSize({ width: rect.width, height: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [showSidebar])

  /* ---------- 键盘快捷键 ---------- */
  useEffect(() => {
    if (!settings.enableShortcuts) return

    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      // 正在输入框/文本域里打字时不拦截，否则打不出字
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      const s = useViewer.getState()

      // Esc 优先：关掉任何浮层或回到漫游（画笔 / 橡皮 / 漫游 三选一）
      if (e.key === 'Escape') {
        /*
         * 遮罩排在最前：黑屏/聚光灯是「全屏覆盖」状态，
         * 用户最想先退出的就是它（屏幕全黑时按 Esc 是本能反应）。
         */
        if (s.maskMode !== 'off') {
          s.setMaskMode('off')
          e.preventDefault()
          return
        }
        /*
         * ★ 用 setRoam 而不是 setDrawMode(false)：
         *   Esc 是「停止批注、回到可以拖页面」的出口，
         *   画笔与橡皮两种状态都要清掉，否则留在橡皮态
         *   而工具栏三个按钮全灭（用户看不出当前是哪个工具）。
         */
        if (s.drawMode || s.eraserMode) {
          s.setRoam()
          e.preventDefault()
          return
        }
        if (s.showTools) {
          s.setShowTools(false)
          e.preventDefault()
          return
        }
        if (s.showSettings) {
          s.setShowSettings(false)
          e.preventDefault()
          return
        }
        if (s.showSearch) {
          s.setShowSearch(false)
          e.preventDefault()
          return
        }
      }

      if (typing) return

      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl) {
        switch (e.key.toLowerCase()) {
          case 'o':
            e.preventDefault()
            void s.pickFile()
            return
          /*
           * 撤销 / 重做。
           *   Ctrl+Z 撤销、Ctrl+Y 重做是 Windows 通行的组合；
           *   Ctrl+Shift+Z 也接受（很多设计类软件的习惯），
           *   两种都支持可以少一次「按错了」的摩擦。
           */
          case 'z':
            e.preventDefault()
            if (e.shiftKey) s.redo()
            else s.undo()
            return
          case 'y':
            e.preventDefault()
            s.redo()
            return
          case 'f':
            e.preventDefault()
            s.setShowSearch(true)
            return
          case 's':
            e.preventDefault()
            s.setShowSettings(true)
            return
          case '=':
          case '+':
            e.preventDefault()
            s.zoomIn()
            return
          case '-':
            e.preventDefault()
            s.zoomOut()
            return
          case '0':
            e.preventDefault()
            s.setZoom('fit-width')
            return
          /*
           * 视图与旋转，对齐 SumatraPDF 的官方快捷键表。
           *
           * ★ 旋转从 Ctrl+R 改走 Ctrl+Shift+减号 / 加号。
           *   原因：Ctrl+R 在 Electron 里是**重新加载当前页**，
           *   虽然 preventDefault 能拦下，但只要哪天漏了拦截，
           *   用户就会把正在看的文档整篇刷掉 —— 代价太大，不值得省一个键。
           *   SumatraPDF 自己用 `[` / `]` 旋转，
           *   这里选 Ctrl+Shift+加减号：与「缩放」的 Ctrl+加减号成对，
           *   记忆成本最低（同一个键加个 Shift 就是「转」）。
           */
          case '6':
            e.preventDefault()
            s.setViewMode('single')
            return
          case '7':
            e.preventDefault()
            s.setViewMode('facing')
            return
          case '8':
            e.preventDefault()
            s.setViewMode('facing-continuous')
            return
          case '_':
            e.preventDefault()
            s.rotate(-90)
            return
          case '*':
            e.preventDefault()
            s.rotate(90)
            return
          case 'r':
            /*
             * 保留 Ctrl+R 旋转，但只在**用户明确按住 Shift**时才动手，
             * 这样 Ctrl+R 单独按下仍能走 Electron 的重新加载
             * （调试时有用），而不会在正常使用中误伤。
             */
            if (!e.shiftKey) return
            e.preventDefault()
            s.rotate(90)
            return
          case 'home':
            e.preventDefault()
            s.setPage(1)
            return
          case 'end':
            e.preventDefault()
            s.setPage(s.pageCount)
            return
          case 'c':
            // Ctrl+C 交给浏览器默认行为（复制选中的文字）
            return
          default:
            return
        }
      }

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault()
          s.nextPage()
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          s.prevPage()
          break
        case 'Home':
          e.preventDefault()
          s.setPage(1)
          break
        case 'End':
          e.preventDefault()
          s.setPage(s.pageCount)
          break
        case ' ':
          // 空格翻页是阅读器的通用习惯，但按住 Shift 反向
          e.preventDefault()
          if (e.shiftKey) s.prevPage()
          else s.nextPage()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings.enableShortcuts])

  /* ---------- 设置变更回调 ---------- */
  const onSettingsChange = useCallback(
    (patch: Parameters<typeof patchSettings>[0]) => {
      void patchSettings(patch)
    },
    [patchSettings]
  )

  const hasDoc = filePath !== ''
  const viewMode = useViewer((s) => s.viewMode)

  /*
   * 视图模式 → 版面参数（这是「工具条按钮按了没反应」的正解）。
   *
   * 历史：这一行以前写死成
   *     const singlePage = false
   *     const facing = false
   * 于是「单页 / 双页并排 / 双页连续」三个按钮点了只换图标，
   * 版面纹丝不动 —— 用户报的「左四个按钮功能没完整实现」就是它。
   * 现在按 viewMode 真实切换：
   *     single             单页：只留当前页，不滚动
   *     continuous         连续滚动：所有页纵向铺开（默认）
   *     facing             双页并排：左右成对，只留当前一对
   *     facing-continuous  双栏滚动：左右成对 + 纵向铺开
   */
  const singlePage = viewMode === 'single'
  const facing = viewMode === 'facing' || viewMode === 'facing-continuous'

  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}>
      <TitleBar subtitle={fileName || undefined} />
      <TabBar />
      <Toolbar />

      <div className="app__body">
        {/* 左侧竖排工具条：批注工具 */}
        <LeftRail />

        {/* 页面导航栏（缩略图/目录/搜索），可由左侧条开关 */}
        {showSidebar ? <Sidebar doc={doc} width={210} /> : null}

        <div className="app__viewer" ref={viewerRef}>
          {/* 手绘模式下的 PPT 式墨迹工具条，悬浮在阅读区底部 */}
          <DrawToolbar />
          {doc && viewSize.width > 0 ? (
            <DocumentView
              doc={doc}
              viewWidth={viewSize.width}
              viewHeight={viewSize.height}
              singlePage={singlePage}
              facing={facing}
              annotations={annotations}
              onCreateAnnotation={(input) => void addAnnotation(input)}
              onEraseAt={(page, x, y, radius) => void eraseAt(page, x, y, radius)}
            />
          ) : (
            <EmptyState
              hasDoc={hasDoc}
              error={docError ?? error}
              recent={recent}
              onOpenRecent={(path) => void openFile(path)}
              onPick={() => void useViewer.getState().pickFile()}
            />
          )}
        </div>

        {/* 右侧竖排工具条：视图与页面控制 */}
        <RightRail />
      </div>

      <StatusBar />

      {/*
        课堂辅助遮罩（黑屏 / 聚光灯 / 放大镜）。
        放在最外层、层级最高，因为它要盖住包括工具栏在内的一切 ——
        遮罩生效时用户只该看到「一块亮的区域」。
      */}
      <ScreenMask />

      {/* 启动声明：右下角浮层，可见主题自适应，可勾选不再提示 */}
      <DisclaimerToast />

      {/* 版本更新：右下角浮层，自动下载、下完再问装不装 */}
      <UpdateToast />
      <MarketPanel />


      {/*
        PDF 工具箱（合并 / 拆分 / 水印 / 压缩 / 加解密 / 图片互转 / Office→PDF）。
        与设置面板互斥由 store 的 setShowTools / setShowSettings 保证。
      */}
      {showTools ? <ToolsPanel onClose={() => setShowTools(false)} /> : null}
      {showSettings ? (
        <SettingsPanel
          settings={settings}
          onChange={onSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      ) : null}

      {dragging ? <div className="drop-hint">松开以打开 PDF</div> : null}

      {toast ? <div className="toast">{toast}</div> : null}

      {error ? (
        <div className="errorbar" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ============================================================
 * 空状态：引导打开文件或从最近记录继续
 * ============================================================ */

function EmptyState({
  hasDoc,
  error,
  recent,
  onOpenRecent,
  onPick
}: {
  hasDoc: boolean
  error: string | null
  recent: Array<{ path: string; name: string; page: number; at: number }>
  onOpenRecent: (path: string) => void
  onPick: () => void
}): JSX.Element {
  if (hasDoc && error) {
    return (
      <div className="empty">
        <h2 className="empty__title">无法打开这份文档</h2>
        <p className="empty__text">{error}</p>
      </div>
    )
  }

  return (
    <div className="empty">
      <h2 className="empty__title">秋夕-PDF阅读器</h2>
      <p className="empty__text">
        把 PDF 拖到这里，或
        <button className="text-btn" onClick={onPick}>
          选择文件
        </button>
      </p>

      <div className="empty__recent">
        <RecentFiles items={recent} onOpen={(path: string) => onOpenRecent(path)} />
      </div>

      <p className="empty__hint">
        提示：也可以在文件管理器里双击 PDF 直接用它打开（安装时已关联 .pdf）
      </p>
    </div>
  )
}
