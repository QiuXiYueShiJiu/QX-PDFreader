// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 内容编辑工具的共用常量与几何工具。
 *
 * ── 坐标系统一说明（本目录所有文件都遵守） ─────────────────────
 *  矩形一律用**页面坐标**：scale = 1、与 `.pdf-page__canvas` 的位图同框的
 *  CSS 像素。屏幕上显示时乘 `scale`（= store.actualScale），
 *  换算只走 DocumentView 里那个 `toPagePoint`（它从 DOM 实测缩放，
 *  缩放动画期间也不会和手指错位）—— 这里不再造第二套换算。
 */

import { CONTENT_ANNOTATION_TYPES, type Annotation, type AnnotationRect } from '@shared/types'

/** 字号档位（页面坐标像素）：12 起跳保证触屏上也点得准，32 封顶免得一行放不下几个字 */
export const FONT_SIZES = [12, 14, 16, 20, 24, 32] as const
export const DEFAULT_FONT_SIZE = 16

/** 线宽档位（页面坐标像素） */
export const STROKE_WIDTHS = [1, 2, 4, 6] as const
export const DEFAULT_STROKE_WIDTH = 2

/** 文本框行高倍数：与 anno-export.ts 的 TEXT_LINE_HEIGHT 必须一致，否则导出会串行 */
export const LINE_HEIGHT = 1.35

/** 新建文本框的默认宽度（页面坐标）。A4 宽 595，220 约等于三分之一页宽，够写一行短句 */
export const DEFAULT_TEXT_WIDTH = 220

/** 物件的下限尺寸：比这更小就没法再选中/拖动，视为误触 */
export const MIN_ITEM_SIZE = 8

/** 拖拽绘制图形的最小有效尺寸：太小的一次抖动不该产生一条看不见的矩形 */
export const MIN_SHAPE_SIZE = 4

/** 图片放置时最多占页面宽/高的比例，避免一张桌面截图把整页盖住 */
export const IMAGE_MAX_RATIO = 0.6

export type Corner = 'nw' | 'ne' | 'sw' | 'se'
export const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se']

export interface PageBounds {
  width: number
  height: number
}

/** 判断一条批注是不是「会改内容」的类型（涂白/图形/文字/图片） */
export function isContentAnnotation(item: Annotation): boolean {
  return (CONTENT_ANNOTATION_TYPES as readonly string[]).includes(item.type)
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 把矩形整体收进页面范围（拖动到页面外时用，避免物件"丢"到看不见的地方） */
export function clampRect(rect: AnnotationRect, bounds: PageBounds): AnnotationRect {
  const width = Math.min(Math.max(MIN_ITEM_SIZE, rect.width), Math.max(MIN_ITEM_SIZE, bounds.width))
  const height = Math.min(Math.max(MIN_ITEM_SIZE, rect.height), Math.max(MIN_ITEM_SIZE, bounds.height))
  return {
    x: clamp(rect.x, 0, Math.max(0, bounds.width - width)),
    y: clamp(rect.y, 0, Math.max(0, bounds.height - height)),
    width,
    height
  }
}

/** 拖动位移：保持尺寸不变，只挪位置 */
export function moveRect(
  origin: AnnotationRect,
  dx: number,
  dy: number,
  bounds: PageBounds
): AnnotationRect {
  return clampRect({ ...origin, x: origin.x + dx, y: origin.y + dy }, bounds)
}

/** 两点围出的矩形（拖拽绘制用），宽高恒为正 */
export function rectFromPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number
): AnnotationRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(ax - bx),
    height: Math.abs(ay - by)
  }
}

/**
 * 四角缩放。
 *
 * 被拖的那个角跟手，**对角保持不动** —— 这是所有绘图软件的行为，
 * 也让"从右下角往外拉"和"从左上角往外拉"的结果可以互相复现。
 *
 * @param aspect 传正数则等比缩放（图片默认如此）；按住 Shift 时调用方传 null 变自由缩放
 */
export function resizeRect(
  origin: AnnotationRect,
  corner: Corner,
  pointerX: number,
  pointerY: number,
  options: { bounds: PageBounds; aspect?: number | null; min?: number }
): AnnotationRect {
  const min = options.min ?? MIN_ITEM_SIZE
  const aspect = options.aspect ?? null
  const west = corner === 'nw' || corner === 'sw'
  const north = corner === 'nw' || corner === 'ne'
  const fixedX = west ? origin.x + origin.width : origin.x
  const fixedY = north ? origin.y + origin.height : origin.y

  let width = Math.max(min, Math.abs(pointerX - fixedX))
  let height = Math.max(min, Math.abs(pointerY - fixedY))

  if (aspect && aspect > 0) {
    /*
     * 等比时按"变化幅度更大的那一轴"定尺寸：只用宽度推算会让
     * 上下拖动几乎没反应（手感发"粘"），反之亦然。
     */
    const ratioW = Math.abs(pointerX - fixedX) / Math.max(1, origin.width)
    const ratioH = Math.abs(pointerY - fixedY) / Math.max(1, origin.height)
    if (ratioW >= ratioH) height = Math.max(min, width / aspect)
    else width = Math.max(min, height * aspect)
  }

  return clampRect(
    { x: west ? fixedX - width : fixedX, y: north ? fixedY - height : fixedY, width, height },
    options.bounds
  )
}

/** 读一张 dataURL 图片的原始尺寸（放置前要按它算初始大小） */
export function imageNaturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/** 小于一个中文字宽度的拖动视为"点选"，不产生位移批注（避免手抖改掉位置） */
export const DRAG_THRESHOLD = 1.5
