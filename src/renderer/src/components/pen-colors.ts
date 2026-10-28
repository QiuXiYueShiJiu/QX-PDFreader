// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔调色盘（单一来源）。
 *
 * 下栏悬浮条（BottomDock）与内容编辑条（edit/EditBar）共用这份色表：
 * 两处各写一份颜色必然漂移，用户看着就像「两套工具两套颜色」。
 *
 * 比 π6 的六色更克制：教学批注常用红蓝黑，因此把这三个排在前面。
 */
export const PEN_COLORS = [
  { value: '#e5484d', label: '红' },
  { value: '#2f7fe8', label: '蓝' },
  { value: '#1a9e5c', label: '绿' },
  { value: '#f5a623', label: '橙' },
  { value: '#a855f7', label: '紫' },
  { value: '#111418', label: '黑' }
] as const
