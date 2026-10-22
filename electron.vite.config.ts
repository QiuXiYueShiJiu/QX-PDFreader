import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      /**
       * ★ preload 必须是 CommonJS 且扩展名为 .cjs，与主进程里的引用保持一致。
       *
       * 踩坑记录：electron-vite 默认输出 index.js，而代码写 ../preload/index.cjs，
       * 文件名不匹配时 Electron 只打印一行 "Unable to load preload script" 就继续，
       * 结果是 window API 为 undefined、渲染层挂载抛异常、页面全白 ——
       * 主进程日志里看不到任何异常，极难排查。这里把格式与文件名固定下来。
       */
      lib: {
        entry: resolve('src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs'
      },
      rollupOptions: {
        output: { entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          /* 打印专用入口：隐藏窗口加载它，把 PDF 画成可打印的纯净页面 */
          print: resolve('src/renderer/print.html')
        }
      }
    }
  }
})
