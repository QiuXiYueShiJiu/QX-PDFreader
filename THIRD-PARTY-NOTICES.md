# 第三方组件与许可清单

生成时间：2026-10-16（`node tools/check-licenses.mjs --write`）

## 一、随安装包分发的运行时依赖（13 个）

| 包 | 版本 | 许可 |
|---|---|---|
| @napi-rs/canvas | 0.1.100 | MIT |
| @napi-rs/canvas-win32-x64-msvc | 0.1.100 | MIT |
| @pdf-lib/standard-fonts | 1.0.0 | MIT |
| @pdf-lib/upng | 1.0.1 | MIT |
| lucide-react | 0.469.0 | ISC |
| pako | 1.0.11 | (MIT AND Zlib) |
| pdf-lib | 1.17.1 | MIT |
| pdfjs-dist | 4.10.38 | Apache-2.0 |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| scheduler | 0.23.2 | MIT |
| tslib | 1.14.1 | 0BSD |
| zustand | 5.0.15 | MIT |

## 二、桌面运行时

| 组件 | 许可 |
|---|---|
| Electron 33.x（内含 Chromium、Node.js、V8、Skia、ICU、FFmpeg、SwiftShader） | MIT；Chromium 及其第三方库见安装目录下的 `LICENSES.chromium.html` |

## 三、开发与打包工具链（不随包分发）

| 包 | 版本 | 许可 |
|---|---|---|
| @types/node | 22.20.5 | MIT |
| @types/react | 18.3.31 | MIT |
| @types/react-dom | 18.3.7 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| electron | 33.4.11 | MIT |
| electron-builder | 25.1.8 | MIT |
| electron-vite | 2.3.0 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 5.4.21 | MIT |

## 四、合规结论

- 强传染（copyleft）依赖：**0 个**（要求为 0）
- 随包分发的依赖全部为宽松许可（MIT / Apache-2.0 / ISC / BSD / 0BSD / Zlib）。
- 各组件完整许可原文见 `node_modules/<包名>/LICENSE*` 与 Electron 的 `LICENSES.chromium.html`。
