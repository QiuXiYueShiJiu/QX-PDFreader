// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「Acrobat 级」文档处理功能的共享类型。
 *
 * 与 pdf-tools.ts 的分工：
 *   · pdf-tools.ts   —— 文件级操作（合并/拆分/水印/压缩/加解密/互转/Office）
 *   · pdf-advanced.ts —— 文档内部编辑（页面、页眉页脚、表单、签名、书签、
 *     元数据、附件、PDF/A、遮盖、导出）
 * 两者结果类型统一为 ToolResult。
 */

import type { ToolResult } from './pdf-tools'

/* ============================================================
 * 页面管理（整理页面）
 * ============================================================ */

/**
 * 输出文档中的一页。
 *
 * `index` 指向源文档的页序（0 起）；-1 表示插入空白页。
 * 最终列表的**顺序就是输出顺序**，不在列表里的页等于被删除。
 */
export interface PageEntry {
  /**
   * 这一页来自哪份 PDF（默认 payload.sourcePath）。
   * 「从另一份 PDF 插入页面」时逐页指定来源。
   */
  sourcePath?: string
  index: number
  /** 绝对旋转角（0/90/180/270）；不填保持原样 */
  rotation?: number
  /** 裁剪框（PDF 点，以页面左下角为原点）；不填不裁剪 */
  crop?: { x: number; y: number; width: number; height: number }
  /** 空白页尺寸（index = -1 时使用，PDF 点） */
  blankSize?: { width: number; height: number }
}

export interface PagesApplyPayload {
  sourcePath?: string
  targetPath?: string
  pages: PageEntry[]
}

/* ============================================================
 * 页眉 / 页脚 / 页码
 * ============================================================ */

/** 页眉或页脚的一侧文本；支持变量 {page} {total} {date} {time} {title} */
export interface HeaderFooterSide {
  left?: string
  center?: string
  right?: string
}

export interface HeaderFooterPayload {
  sourcePath?: string
  targetPath?: string
  header?: HeaderFooterSide
  footer?: HeaderFooterSide
  /** 字号（PDF 点），默认 9 */
  fontSize?: number
  /** 颜色 #rrggbb，默认 #666666 */
  color?: string
  /** 上下边距（点），默认 24 */
  margin?: number
  /** 跳过第一页（封面通常不加页码） */
  skipFirst?: boolean
  /** 第一页显示的页码编号（默认 1） */
  startNumber?: number
  /** {title} 变量取这个值 */
  title?: string
}

/* ============================================================
 * 贝茨编号（Bates numbering）
 * ============================================================ */

export type BatesPosition =
  | 'bottom-right'
  | 'bottom-center'
  | 'bottom-left'
  | 'top-right'
  | 'top-center'
  | 'top-left'

export interface BatesPayload {
  sourcePath?: string
  targetPath?: string
  prefix?: string
  suffix?: string
  /** 起始编号，默认 1 */
  start?: number
  /** 编号补零位数，默认 6 */
  digits?: number
  fontSize?: number
  position?: BatesPosition
  margin?: number
}

/* ============================================================
 * 元数据
 * ============================================================ */

export interface MetadataPayload {
  sourcePath?: string
  targetPath?: string
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
}

/* ============================================================
 * 书签（文档目录）
 * ============================================================ */

export interface BookmarkItem {
  title: string
  /** 目标页码（1 起） */
  page: number
  children?: BookmarkItem[]
}

export interface BookmarksPayload {
  sourcePath?: string
  targetPath?: string
  items: BookmarkItem[]
}

/* ============================================================
 * 附件
 * ============================================================ */

export interface AttachmentInfo {
  name: string
  size: number
  mimeType?: string
}

export interface AttachmentsPayload {
  sourcePath?: string
  targetPath?: string
  action: 'list' | 'add' | 'extract'
  /** add：要附加的文件 */
  files?: string[]
  /** extract：输出目录（不填则弹文件夹选择） */
  outputDir?: string
  /** extract：只导出这些附件名（不填 = 全部） */
  names?: string[]
}

export interface AttachmentListResult extends ToolResult {
  attachments?: AttachmentInfo[]
}

/* ============================================================
 * 表单（AcroForm）
 * ============================================================ */

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'button'
  | 'signature'
  | 'unknown'

export interface FormFieldInfo {
  name: string
  type: FormFieldType
  /** 当前值：文本 / 是否勾选 / 选中项 */
  value: string | boolean | string[]
  /** 下拉框与列表框的候选值 */
  options?: string[]
  readonly?: boolean
}

export interface FormsQueryPayload {
  sourcePath?: string
}

export interface FormsQueryResult extends ToolResult {
  hasForm: boolean
  fields: FormFieldInfo[]
}

export interface FormsFillPayload {
  sourcePath?: string
  targetPath?: string
  /** 字段名 → 新值（文本 / 勾选 / 选中项） */
  values: Record<string, string | boolean | string[]>
  /** 是否扁平化（保存为不可再编辑的普通内容） */
  flatten?: boolean
}

/* ============================================================
 * 创建表单字段（表单设计）
 * ============================================================ */

export interface FormFieldSpec {
  /** 新字段名（同一份文档内唯一） */
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown'
  /** 页码（1 起） */
  page: number
  /** 放置矩形：PDF 用户坐标（点，左下角原点） */
  rect: { x: number; y: number; width: number; height: number }
  /** 下拉框 / 单选框的选项 */
  options?: string[]
  /** 默认值：文本内容 / 是否勾选 / 选中的选项 */
  defaultValue?: string | boolean
  /** 文本字段字号（点），默认 12 */
  fontSize?: number
}

export interface FormsCreatePayload {
  sourcePath?: string
  targetPath?: string
  fields: FormFieldSpec[]
}

/* ============================================================
 * 电子签名（手写 / 图片）
 * ============================================================ */

export interface SignPayload {
  sourcePath?: string
  targetPath?: string
  /** 签名 PNG（透明底） */
  image: { data: ArrayBuffer; width: number; height: number }
  /** 页码（1 起） */
  page: number
  /**
   * 放置位置：**PDF 用户坐标**（点，左下角原点）。
   * 渲染层负责把 DOM 坐标换算成该坐标系后再传。
   */
  rect: { x: number; y: number; width: number; height: number }
  /** 签名下方追加的日期/说明文字 */
  dateText?: string
}

/* ============================================================
 * PDF/A
 * ============================================================ */

export interface PdfAPayload {
  sourcePath?: string
  targetPath?: string
  conformance?: '1B' | '2B' | '3B'
}

/* ============================================================
 * 导出
 * ============================================================ */

export interface ExportWordPayload {
  sourcePath?: string
  targetPath?: string
  /** 每页的纯文本与页面尺寸（Word 里按页分页） */
  pages: Array<{ page: number; text: string; width: number; height: number }>
}

export interface SaveBinaryPayload {
  targetPath?: string
  /** 默认文件名，如「正文.txt」 */
  defaultName: string
  /** 扩展名，决定保存框过滤器 */
  ext: string
  data: ArrayBuffer
}

/* ============================================================
 * 并排对照 PDF（比较结果的图形版）
 * ============================================================ */

export interface ComparePdfPayload {
  /** 文档 A 的路径（只用于默认文件名/目录，不影响内容） */
  sourcePath?: string
  targetPath?: string
  defaultName?: string
  /**
   * 每个元素是一张「A/B 并排」的图片页（渲染层生成）。
   * width/height 是目标 PDF 页尺寸（点）。
   */
  pages: Array<{ data: ArrayBuffer; width: number; height: number }>
}

/* ============================================================
 * 安全遮盖（红色遮盖 / 永久删除）
 * ============================================================ */

export interface RedactPayload {
  sourcePath?: string
  targetPath?: string
  /**
   * 被遮盖的页：渲染层把该页连同黑框一起画成图片，
   * 主进程用图片页替换原页（原页文字层随之消失，不可再被复制）。
   * 未列出的页保持原样（仍是可搜索的矢量页）。
   */
  pages: Array<{
    page: number
    data: ArrayBuffer
    mime: 'image/jpeg' | 'image/png'
    width: number
    height: number
  }>
}

/* ============================================================
 * 打印
 * ============================================================ */

export interface PrintPayload {
  sourcePath?: string
  /** 打印份数，默认 1 */
  copies?: number
  /** 页码范围，如 "1-3,5"；不填 = 全部页 */
  pageRange?: string
  /**
   * 只渲染、不弹打印对话框（自动化验证用）。
   * 返回页数与页面尺寸，便于断言「pdf.js 把每一页都画出来了」。
   */
  dryRun?: boolean
}

/** 打印页渲染完的摘要（dryRun 时回传） */
export interface PrintInfo {
  pages: number
  /** 第一页尺寸（点） */
  widthPt: number
  heightPt: number
}

/* ============================================================
 * 导出 Excel
 * ============================================================ */

export interface ExportExcelPayload {
  sourcePath?: string
  targetPath?: string
  /**
   * 每页内容：优先用渲染层对齐好的 `rows`（按 x 坐标聚列）；
   * 只有 text 时由主进程按 Tab / 连续空格启发式拆列。
   */
  pages: Array<{ page: number; text?: string; rows?: string[][] }>
}

/* ============================================================
 * 批量处理
 * ============================================================ */

export type BatchOperation = 'headerfooter' | 'bates' | 'encrypt' | 'watermark'

/** 批量操作共用的页眉页脚参数（去掉路径字段） */
export type BatchHeaderFooter = Omit<HeaderFooterPayload, 'sourcePath' | 'targetPath'>
/** 批量贝茨编号参数 */
export type BatchBates = Omit<BatesPayload, 'sourcePath' | 'targetPath'>

/** 批量水印：主进程直接用嵌入中文字体画矢量文字（中文不会乱码） */
export interface BatchWatermark {
  text: string
  /** 字号（点），默认 48 */
  fontSize?: number
  /** 颜色 #rrggbb，默认 #c62828 */
  color?: string
  /** 不透明度 0~1，默认 0.16 */
  opacity?: number
  /** 旋转角度，默认 30 */
  rotation?: number
  position?: 'center' | 'tile'
  /** 平铺时每块间距（点），默认 180 */
  gap?: number
}

export interface BatchEncrypt {
  userPassword: string
  ownerPassword?: string
  permissions?: {
    printing?: boolean
    copying?: boolean
    modifying?: boolean
  }
}

export interface BatchPayload {
  operation: BatchOperation
  /** 要处理的 PDF 列表（顺序即处理顺序） */
  files: string[]
  /** 输出目录；不填则与源文件同目录 */
  outputDir?: string
  /** 输出文件名后缀，默认按操作（-页眉页脚 / -贝茨 / -已加密 / -水印） */
  suffix?: string
  headerFooter?: BatchHeaderFooter
  bates?: BatchBates
  encrypt?: BatchEncrypt
  watermark?: BatchWatermark
}
