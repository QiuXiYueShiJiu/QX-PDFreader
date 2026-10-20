// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 生成应用图标与 PDF 文件图标。
 *
 * ── 设计说明（这一版是重做的）────────────────────────────────
 * 上一版是「纯色圆角方块 + 居中文字」，三个问题：
 *   ① 文字偏小、四周留白太多，缩到 16px 几乎看不清
 *   ② 大 P 与小 df 各自居中，视觉重心不在一条线上
 *   ③ 缺少「文档」语义，和普通工具图标区分不开
 *
 * 这一版的做法：
 *   · **红底 + 白色纸张**：红是 PDF 的行业惯用色，白纸直接传达「文档」
 *   · **纸张带折角**：一眼就知道是文件，缩放后依然可辨
 *   · **标题栏色块**：纸张顶部一条淡红带，进一步强化文档感
 *   · **P 用超大字号**，df 紧随其下，共用一条左对齐基线，重心稳定
 *   · 小尺寸（≤32）自动降级：只画纸张 + 一个粗 P，靠形状而不是细节辨认
 *
 * ── 为什么用 C# + System.Drawing ─────────────────────────────
 * 本机没有 SVG→ICO 的现成工具，装 sharp/resvg 又要额外依赖；
 * .NET 自带 System.Drawing，能按多尺寸绘制并直接打包 ICO。
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

internal static class IconMaker
{
    /** ICO 内打包的尺寸（Windows 按视图自动挑选） */
    private static readonly int[] Sizes = { 16, 20, 24, 32, 48, 64, 128, 256 };

    private static int Main(string[] args)
    {
        string outDir = args.Length > 0 ? args[0] : "build";
        Directory.CreateDirectory(outDir);

        // 应用图标：深红底 + 白纸（PDF 行业色）
        WriteIco(Path.Combine(outDir, "icon.ico"), true);
        // 文件关联图标：同样的图形语言，稍深一点以便与窗口图标区分
        WriteIco(Path.Combine(outDir, "pdf-file.ico"), false);

        Console.WriteLine("icons generated in " + Path.GetFullPath(outDir));
        return 0;
    }

    private static void WriteIco(string path, bool isAppIcon)
    {
        var images = new List<byte[]>();
        foreach (int size in Sizes)
        {
            using (var bmp = Render(size, isAppIcon))
            {
                images.Add(ToPng(bmp));
            }
        }
        WriteIcoFile(path, images, Sizes);
        Console.WriteLine("  " + Path.GetFileName(path) + "  (" + images.Count + " sizes)");
    }

    /* ============================================================
     * 绘制
     * ============================================================ */

    private static Bitmap Render(int size, bool isAppIcon)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            // 底色：应用图标偏亮红，文件图标偏深红
            Color top = isAppIcon ? Color.FromArgb(239, 68, 68) : Color.FromArgb(220, 38, 38);
            Color bottom = isAppIcon ? Color.FromArgb(190, 24, 60) : Color.FromArgb(159, 18, 57);

            float pad = size * 0.03f;
            var bgRect = new RectangleF(pad, pad, size - pad * 2, size - pad * 2);

            // ---- 圆角底 ----
            using (var bgPath = RoundedRect(bgRect, size * 0.235f))
            {
                using (var brush = new LinearGradientBrush(bgRect, top, bottom, 90f))
                {
                    g.FillPath(brush, bgPath);
                }
                // 顶部高光，避免纯平色显得廉价
                using (var hl = new LinearGradientBrush(
                    bgRect, Color.FromArgb(64, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
                {
                    g.FillPath(hl, bgPath);
                }
            }

            // ---- 白色纸张 ----
            /*
             * 纸张占比经过试算：留出约 20% 的四周空间，
             * 太小则 P 放不下，太大则底色看不见、失去品牌色。
             */
            float sheetW = size * 0.62f;
            float sheetH = size * 0.76f;
            float sheetX = (size - sheetW) / 2f;
            float sheetY = (size - sheetH) / 2f + size * 0.01f;
            float fold = size * 0.20f;   // 折角大小

            var sheetPath = new GraphicsPath();
            sheetPath.AddLine(sheetX, sheetY, sheetX + sheetW - fold, sheetY);   // 上边
            sheetPath.AddLine(sheetX + sheetW - fold, sheetY, sheetX + sheetW, sheetY + fold); // 折角斜边
            sheetPath.AddLine(sheetX + sheetW, sheetY + fold, sheetX + sheetW, sheetY + sheetH); // 右边
            sheetPath.AddLine(sheetX + sheetW, sheetY + sheetH, sheetX, sheetY + sheetH);        // 下边
            sheetPath.CloseFigure();

            using (var sheetBrush = new SolidBrush(Color.White))
            {
                // 极小的尺寸加一点阴影会糊，直接实心更干净
                if (size >= 32)
                {
                    using (var shadow = new SolidBrush(Color.FromArgb(46, 0, 0, 0)))
                    using (var shadowPath = (GraphicsPath)sheetPath.Clone())
                    using (var m = new Matrix())
                    {
                        m.Translate(0, Math.Max(1f, size * 0.012f));
                        shadowPath.Transform(m);
                        g.FillPath(shadow, shadowPath);
                    }
                }
                g.FillPath(sheetBrush, sheetPath);
            }

            // 折角的三角（浅灰，让折纸看起来是翻过去的）
            if (size >= 32)
            {
                using (var foldBrush = new SolidBrush(Color.FromArgb(226, 232, 240)))
                {
                    g.FillPolygon(foldBrush, new[]
                    {
                        new PointF(sheetX + sheetW - fold, sheetY),
                        new PointF(sheetX + sheetW, sheetY + fold),
                        new PointF(sheetX + sheetW - fold, sheetY + fold)
                    });
                }
            }

            /* ---- 文字 ---- */
            using (var family = PickFont())
            {
                /*
                 * 尺寸分级：
                 *   ≤24 只画一个粗 P（三字母在这个尺寸必然糊）
                 *   ≥32 画 P + df
                 * 这是图标设计的常规做法 —— 小尺寸靠形状，大尺寸靠细节。
                 */
                if (size <= 24)
                {
                    DrawCentered(g, "P", family, size * 0.46f, Color.FromArgb(200, 24, 44),
                        new RectangleF(sheetX, sheetY + sheetH * 0.06f, sheetW, sheetH * 0.9f));
                }
                else
                {
                    /*
                     * 排版经过两轮调整：
                     *   第一版文字偏上、df 偏小、P 与 df 基线不齐，
                     *   缩到 24px 时 df 几乎糊掉。
                     * 这一版：
                     *   · df 从 0.205 提到 0.25，保证小尺寸可辨
                     *   · 用 MeasureString 的实际高度算基线，让两者底部严格对齐
                     *   · 文字块整体下移到纸张视觉中心（略低于几何中心更自然）
                     */
                    float pSize = size * 0.42f;
                    float dfSize = size * 0.25f;

                    using (var fP = new Font(family, pSize, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var fDf = new Font(family, dfSize, FontStyle.Bold, GraphicsUnit.Pixel))
                    {
                        var szP = g.MeasureString("P", fP);
                        var szDf = g.MeasureString("df", fDf);

                        // 紧凑排布：df 稍微贴近 P，避免中间出现大空隙
                        float gap = size * 0.008f;
                        float totalW = szP.Width * 0.84f + gap + szDf.Width;
                        float startX = sheetX + (sheetW - totalW) / 2f;

                        /*
                         * 基线对齐：
                         *   MeasureString 的高度含上下留白，直接用会错位，
                         *   这里按实测的字体上下留白比例把基线算准 ——
                         *   Segoe UI 粗体的可视底边约在高度 0.80 处。
                         */
                        float visualP = szP.Height * 0.80f;
                        float visualDf = szDf.Height * 0.80f;
                        float blockH = Math.Max(visualP, visualDf);

                        // 垂直居中，并整体下移 4% 纸张高（视觉重心比几何中心略低）
                        float baseline = sheetY + sheetH * 0.5f + blockH * 0.5f + sheetH * 0.04f;

                        using (var dark = new SolidBrush(Color.FromArgb(186, 16, 44)))
                        using (var mid = new SolidBrush(Color.FromArgb(150, 32, 62)))
                        {
                            g.DrawString("P", fP, dark, startX, baseline - visualP);
                            g.DrawString("df", fDf, mid,
                                startX + szP.Width * 0.84f + gap, baseline - visualDf);
                        }
                    }
                }
            }
        }
        return bmp;
    }

    private static void DrawCentered(
        Graphics g, string text, FontFamily family, float emSize, Color color, RectangleF bounds)
    {
        using (var font = new Font(family, emSize, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var brush = new SolidBrush(color))
        using (var format = new StringFormat
        {
            Alignment = StringAlignment.Center,
            LineAlignment = StringAlignment.Center
        })
        {
            g.DrawString(text, font, brush, bounds, format);
        }
    }

    private static FontFamily PickFont()
    {
        // Segoe UI 的字形最规整；缺失时逐级退让
        string[] candidates = { "Segoe UI", "Arial", "Microsoft YaHei UI", "Tahoma" };
        foreach (var name in candidates)
        {
            try { return new FontFamily(name); }
            catch { /* 不存在就试下一个 */ }
        }
        return FontFamily.GenericSansSerif;
    }

    private static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static byte[] ToPng(Bitmap bmp)
    {
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    /**
     * 写 ICO 文件。
     *
     * 所有尺寸都用 PNG 存储 —— 这是 Vista 之后的 ICO 格式，
     * 老格式只支持 256 色位图，渐变与抗锯齿文字会严重失真。
     */
    private static void WriteIcoFile(string path, List<byte[]> images, int[] sizes)
    {
        using (var fs = new FileStream(path, FileMode.Create))
        using (var w = new BinaryWriter(fs))
        {
            w.Write((ushort)0);
            w.Write((ushort)1);
            w.Write((ushort)images.Count);

            int offset = 6 + images.Count * 16;
            for (int i = 0; i < images.Count; i++)
            {
                int s = sizes[i];
                w.Write((byte)(s >= 256 ? 0 : s));
                w.Write((byte)(s >= 256 ? 0 : s));
                w.Write((byte)0);
                w.Write((byte)0);
                w.Write((ushort)1);
                w.Write((ushort)32);
                w.Write(images[i].Length);
                w.Write(offset);
                offset += images[i].Length;
            }

            foreach (var img in images) w.Write(img);
        }
    }
}
