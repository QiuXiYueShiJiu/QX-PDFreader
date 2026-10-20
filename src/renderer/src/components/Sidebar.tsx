// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 左侧栏：缩略图 / 目录（大纲）/ 搜索结果。
 *
 * 三合一放在同一块区域，用页签切换 —— 教学时最常用的是缩略图，
 * 长篇教材用目录跳转，找关键词用搜索，三者都需要但不该各占一栏。
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FileSearch, List, Search } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useViewer } from '../store'
import { useThumbnail } from './DocumentView'

/** 大纲条目（pdf.js 的 getOutline 返回嵌套结构） */
interface OutlineItem {
  title: string
  dest: unknown
  items: OutlineItem[]
}

/* 标签页类型定义在 store.ts 的 sidebarTab 字段上，这里不再重复声明 */

/*
 * 标签页状态来自 store 而不是本地 useState。
 *
 * 原先这里是 `const [tab, setTab] = useState<Tab>('thumbnails')`，
 * 于是工具栏的「搜索」按钮改不动它 —— 点上去只会把 showSearch 翻个面，
 * 用户看到的是「按了没反应」。提上去之后按钮和标签页才是同一个真相。
 */
export function Sidebar({ doc, width }: { doc: PDFDocumentProxy | null; width: number }): JSX.Element {
  const tab = useViewer((s) => s.sidebarTab)
  const setTab = useViewer((s) => s.setSidebarTab)

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar__tabs" role="tablist">
        <button
          className="sidebar__tab"
          role="tab"
          aria-selected={tab === 'thumbnails'}
          onClick={() => setTab('thumbnails')}
          title="页面缩略图"
        >
          <List size={15} />
          <span>缩略图</span>
        </button>
        <button
          className="sidebar__tab"
          role="tab"
          aria-selected={tab === 'outline'}
          onClick={() => setTab('outline')}
          title="文档目录"
        >
          <FileSearch size={15} />
          <span>目录</span>
        </button>
        <button
          className="sidebar__tab"
          role="tab"
          aria-selected={tab === 'search'}
          onClick={() => setTab('search')}
          title="搜索全文"
        >
          <Search size={15} />
          <span>搜索</span>
        </button>
      </div>

      <div className="sidebar__body">
        {tab === 'thumbnails' ? <Thumbnails doc={doc} /> : null}
        {tab === 'outline' ? <Outline doc={doc} /> : null}
        {tab === 'search' ? <SearchPanel doc={doc} /> : null}
      </div>
    </aside>
  )
}

/* ============================================================
 * 缩略图
 * ============================================================ */

function Thumbnails({ doc }: { doc: PDFDocumentProxy | null }): JSX.Element {
  const pageCount = useViewer((s) => s.pageCount)
  const page = useViewer((s) => s.page)
  const setPage = useViewer((s) => s.setPage)
  const listRef = useRef<HTMLDivElement>(null)

  // 当前页变化时把对应缩略图滚进视野
  useEffect(() => {
    const list = listRef.current
    if (!list || !page) return
    const el = list.querySelector<HTMLElement>(`[data-thumb="${page}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [page])

  if (!doc) {
    return <p className="sidebar__empty">未打开文档</p>
  }

  return (
    <div className="thumbs" ref={listRef}>
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((num) => (
        <Thumb key={num} doc={doc} pageNumber={num} active={num === page} onSelect={() => setPage(num)} />
      ))}
    </div>
  )
}

function Thumb({
  doc,
  pageNumber,
  active,
  onSelect
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onSelect: () => void
}): JSX.Element {
  // 缩略图宽度按栏宽取值，150 是 232px 栏宽下的合适尺寸
  const canvasRef = useThumbnail(doc, pageNumber, 150)

  return (
    <button
      className={`thumb ${active ? 'is-active' : ''}`}
      data-thumb={pageNumber}
      onClick={onSelect}
      title={`跳转到第 ${pageNumber} 页`}
    >
      <canvas ref={canvasRef} className="thumb__canvas" />
      <span className="thumb__label">{pageNumber}</span>
    </button>
  )
}

/* ============================================================
 * 目录（大纲）
 * ============================================================ */

function Outline({ doc }: { doc: PDFDocumentProxy | null }): JSX.Element {
  const [items, setItems] = useState<OutlineItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const setPage = useViewer((s) => s.setPage)

  useEffect(() => {
    if (!doc) return
    let cancelled = false
    setItems(null)
    setError(null)

    void doc
      .getOutline()
      .then((outline) => {
        if (cancelled) return
        setItems((outline as OutlineItem[] | null) ?? [])
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })

    return () => {
      cancelled = true
    }
  }, [doc])

  if (!doc) return <p className="sidebar__empty">未打开文档</p>
  if (error) return <p className="sidebar__empty">无法读取目录：{error}</p>
  if (items === null) return <p className="sidebar__empty">正在读取目录…</p>
  if (items.length === 0) {
    return (
      <p className="sidebar__empty">
        这份文档没有内置目录。
        <br />
        可以用「缩略图」或「搜索」定位内容。
      </p>
    )
  }

  /** 点击目录项：解析目标为页码后跳转 */
  const go = async (item: OutlineItem): Promise<void> => {
    try {
      const dest = item.dest
      // 字符串形式的命名目标要先解析成数组
      const resolved =
        typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[] | null)
      if (!resolved || !Array.isArray(resolved)) return
      const index = await doc.getPageIndex(resolved[0] as never)
      setPage(index + 1)
    } catch (e) {
      console.warn('[pdf] 目录跳转失败：', e)
    }
  }

  return (
    <ul className="outline">
      {items.map((item, i) => (
        <OutlineRow key={i} item={item} depth={0} onGo={go} />
      ))}
    </ul>
  )
}

function OutlineRow({
  item,
  depth,
  onGo
}: {
  item: OutlineItem
  depth: number
  onGo: (item: OutlineItem) => Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(depth === 0)
  const hasChildren = Array.isArray(item.items) && item.items.length > 0

  return (
    <li className="outline__node">
      <div className="outline__row" style={{ paddingLeft: 6 + depth * 14 }}>
        {hasChildren ? (
          <button
            className="outline__toggle"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? '收起' : '展开'}
          >
            <ChevronRight size={13} className={open ? 'is-open' : ''} />
          </button>
        ) : (
          <span className="outline__toggle outline__toggle--empty" />
        )}
        <button className="outline__label" onClick={() => void onGo(item)} title={item.title}>
          {item.title || '(无标题)'}
        </button>
      </div>
      {hasChildren && open ? (
        <ul className="outline__children">
          {item.items.map((child, i) => (
            <OutlineRow key={i} item={child} depth={depth + 1} onGo={onGo} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/* ============================================================
 * 搜索
 * ============================================================ */

interface SearchHit {
  page: number
  /** 命中片段（前后各截一段，便于预览） */
  snippet: string
}

function SearchPanel({ doc }: { doc: PDFDocumentProxy | null }): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [done, setDone] = useState(0)
  const setPage = useViewer((s) => s.setPage)
  const setSearchResult = useViewer((s) => s.setSearchResult)
  const focusTick = useViewer((s) => s.searchFocusTick)
  const inputRef = useRef<HTMLInputElement>(null)

  /*
   * 工具栏每点一次「搜索」，searchFocusTick 就自增一次，这里重新聚焦
   * 并全选已有关键词 —— 用户再点一次搜索多半是想换个词重搜，
   * 直接覆盖比让他先手动清空顺手。
   *
   * 不再用 autoFocus：它只在挂载那一次生效，而标签页是常挂载的，
   * 第二次点搜索框不会重新获得焦点。
   */
  useEffect(() => {
    if (!focusTick) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [focusTick])

  /** 取消标志：用户改了关键词就丢弃上一轮结果 */
  const cancelRef = useRef(0)

  useEffect(() => {
    const keyword = query.trim()
    if (!doc || keyword.length < 1) {
      setHits([])
      setSearchResult(0, 0)
      return
    }

    const token = ++cancelRef.current
    setSearching(true)
    setHits([])
    setDone(0)

    const lower = keyword.toLowerCase()

    void (async () => {
      const found: SearchHit[] = []
      const total = doc.numPages

      for (let i = 1; i <= total; i++) {
        if (cancelRef.current !== token) return
        try {
          const p = await doc.getPage(i)
          const content = await p.getTextContent()
          // getTextContent 返回的是文本片段数组，拼接后按页匹配
          const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
          const idx = text.toLowerCase().indexOf(lower)
          if (idx >= 0) {
            const from = Math.max(0, idx - 24)
            const to = Math.min(text.length, idx + keyword.length + 40)
            found.push({
              page: i,
              snippet:
                (from > 0 ? '…' : '') +
                text.slice(from, to) +
                (to < text.length ? '…' : '')
            })
          }
        } catch {
          /* 单页解析失败不影响整体搜索 */
        }
        if (cancelRef.current !== token) return
        setDone(i)
      }

      if (cancelRef.current !== token) return
      setHits(found)
      setSearching(false)
      setSearchResult(found.length, 0)
    })()

    return () => {
      // 关键词变化时让上一轮循环提前退出
      cancelRef.current++
    }
  }, [doc, query, setSearchResult])

  if (!doc) return <p className="sidebar__empty">未打开文档</p>

  return (
    <div className="search-panel">
      <input
        ref={inputRef}
        className="search-panel__input"
        type="search"
        placeholder="输入关键词搜索全文"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {searching ? (
        <p className="sidebar__empty">
          正在搜索… {done}/{doc.numPages}
        </p>
      ) : null}

      {!searching && query.trim() && hits.length === 0 ? (
        <p className="sidebar__empty">没有找到「{query.trim()}」</p>
      ) : null}

      {!searching && hits.length > 0 ? (
        <>
          <p className="search-panel__count">找到 {hits.length} 处</p>
          <ul className="search-hits">
            {hits.map((hit, i) => (
              <li key={`${hit.page}-${i}`}>
                <button className="search-hit" onClick={() => setPage(hit.page)}>
                  <span className="search-hit__page">第 {hit.page} 页</span>
                  <span className="search-hit__snippet">{hit.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}
