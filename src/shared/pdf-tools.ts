// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 工具箱的共享类型（主进程 / preload / 渲染层三处共用）。
 *
 * 为什么要集中定义：
 *   每个操作都跨 IPC 传一组结构化参数，三处各写一份 interface 迟早会写岔
 *   （少一个字段运行时才发现，而 IPC 没有类型检查兜底）。
 */

/** 所有工具调用的统一结果 */
export interface ToolResult {
  ok: boolean
  /** 用户在弹出的对话框里点了取消 */
  canceled?: boolean
  /** 失败原因（给用户看的中文说明） */
  error?: string
  /** 产出的文件路径（单文件操作） */
  path?: string
  /** 产出的多个文件路径（拆分 / 批量转换） */
  paths?: string[]
  /** 附加信息（页数、压缩前后字节数等），直接展示在结果区 */
  info?: Record<string, string | number>
}

/* ============================================================
 * 合并 / 拆分
 * ============================================================ */

export interface MergePayload {
  /** 要合并的 PDF 绝对路径（顺序即合并顺序）。不给则由主进程弹选择框 */
  inputs?: string[]
  /** 输出路径；不给则由主进程弹「另存为」 */
  targetPath?: string
}

export interface SplitPayload {
  /** 源 PDF；不给则由主进程弹选择框 */
  sourcePath?: string
  /**
   * each   = 每一页拆成一个单独 PDF 文件
   * ranges = 按「页码范围」提取成若干组 PDF（1-3,5,8-10）
   */
  mode: 'each' | 'ranges'
  /** mode = ranges 时必填，如 "1-3,5,8-10" */
  ranges?: string
  /** 输出目录；不给则由主进程弹文件夹选择框 */
  outputDir?: string
}

/* ============================================================
 * 水印
 * ============================================================ */

export interface WatermarkPayload {
  /** 源 PDF；不给则由主进程弹选择框 */
  sourcePath?: string
  /** 输出路径；不给则由主进程弹「另存为」 */
  targetPath?: string
  /**
   * 渲染层画好的水印图片（PNG，透明背景，已按高分辨率绘制）。
   *
   * 为什么传图片而不是传文字：中文水印需要嵌入 CJK 字体，
   * 而 pdf-lib 内置字体不含中文；在渲染层用 canvas 画好再贴图，
   * 任何文字（含符号、混合语言）都能原样出现，也不需要额外字体包。
   */
  image: { data: ArrayBuffer; width: number; height: number }
  /** 不透明度 0~1 */
  opacity: number
  /** 顺时针旋转角度 */
  rotation: number
  /** center = 居中一个大的；tile = 平铺满页 */
  position: 'center' | 'tile'
  /** 平铺时水平/垂直间距（页面点数） */
  gap?: number
}

/* ============================================================
 * 加密 / 解密
 * ============================================================ */

export interface EncryptPayload {
  sourcePath?: string
  targetPath?: string
  /** 打开密码（必填） */
  userPassword: string
  /** 权限密码（可选，不填则与打开密码相同） */
  ownerPassword?: string
  /** 允许打印 / 复制 / 修改；默认全部禁止 */
  permissions?: {
    printing?: boolean
    copying?: boolean
    modifying?: boolean
  }
}

export interface DecryptPayload {
  sourcePath?: string
  targetPath?: string
  /** 当前文档的打开密码 */
  password: string
}

/* ============================================================
 * 压缩（光栅化重排）
 * ============================================================ */

export interface CompressedPage {
  /** 页码，1 起 */
  page: number
  /** 页面尺寸（PDF 点，未旋转） */
  width: number
  height: number
  /** JPEG 或 PNG 字节 */
  data: ArrayBuffer
  mime: 'image/jpeg' | 'image/png'
}

export interface CompressPayload {
  sourcePath?: string
  targetPath?: string
  /** 渲染层按目标清晰度画好的每页位图 */
  pages: CompressedPage[]
}

/* ============================================================
 * PDF ↔ 图片
 * ============================================================ */

/** PDF → 图片：渲染层负责渲染，主进程负责落盘 */
export interface SaveImagesPayload {
  /** 多文件时写入的目录（不填则弹文件夹选择框） */
  outputDir?: string
  /** 单文件（拼长图）时的目标路径（不填则弹「另存为」） */
  targetPath?: string
  /** 写成一个文件还是每页一个文件 */
  singleFile: boolean
  /** 文件名前缀（多文件时用） */
  baseName?: string
  images: Array<{ name: string; mime: 'image/png' | 'image/jpeg'; data: ArrayBuffer }>
}

export interface ImagesToPdfPayload {
  /** 图片绝对路径（按顺序成页）。不给则由主进程弹选择框 */
  files?: string[]
  targetPath?: string
  /** 页面尺寸：fit = 与图片同比例；a4 / a4-landscape = 放进 A4 页面居中 */
  pageSize: 'fit' | 'a4' | 'a4-landscape'
}

/* ============================================================
 * Office → PDF
 * ============================================================ */

export interface OfficeToPdfPayload {
  /** 要转换的文件（doc/docx/xls/xlsx/ppt/pptx/odt…）。不给则由主进程弹选择框 */
  inputs?: string[]
  /** 单个输入时的目标路径（不填则与源文件同目录同名） */
  targetPath?: string
}

/** Office 转换可用的外部程序 */
export interface OfficeConverterInfo {
  /** 'libreoffice' | 'word' | 'excel' | 'powerpoint' | 'wps' | 'none' */
  kind: string
  /** 给用户看的名称 */
  label: string
  /** 支持的文件扩展名（不含点） */
  extensions: string[]
}
