import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const THUMB_CLSID = '{0A1B2C3D-4E5F-4A6B-8C7D-9E0F11223344}'
const LEGACY_CLSID = '{7C4F1E2A-9B31-4D8E-9A57-2E6C0B7A55D1}'
const HANDLER = '{E357FCCD-A995-4576-B01F-234630154E96}'
const MARKER = 'qxthumb-native-1'
const HKCU = 'HKCU\\Software\\Classes'
const HKLM = 'HKLM\\Software\\Classes'

function reg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err) => resolve(!err))
  })
}

async function addKey(root: string, key: string, name: string | null, value: string): Promise<boolean> {
  const full = root + '\\' + key
  const args = name ? ['add', full, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'] : ['add', full, '/ve', '/t', 'REG_SZ', '/d', value, '/f']
  return reg(args)
}

function paths(): { dll: string; exe: string } {
  const dll = app.isPackaged
    ? join(process.resourcesPath, 'shell-thumb', 'QXThumbNative.dll')
    : join(app.getAppPath(), 'build', 'shell-thumb', 'QXThumbNative.dll')
  return { dll, exe: app.getPath('exe') }
}

async function writeTree(root: string, dll: string, exe: string, appPath: string): Promise<void> {
  const clsid = 'CLSID\\' + THUMB_CLSID
  await addKey(root, clsid, null, 'QiuXi PDF thumbnail')
  await addKey(root, clsid + '\\InprocServer32', null, dll)
  await addKey(root, clsid + '\\InprocServer32', 'ThreadingModel', 'Apartment')
  await addKey(root, clsid, 'ThumbExe', exe)
  await addKey(root, clsid, 'ThumbArgs', app.isPackaged ? '' : appPath)
  await addKey(root, clsid, 'Marker', MARKER)
  await addKey(root, '.pdf\\ShellEx\\' + HANDLER, null, THUMB_CLSID)
  await addKey(root, 'SystemFileAssociations\\.pdf\\ShellEx\\' + HANDLER, null, THUMB_CLSID)
}

export async function ensureShellThumb(): Promise<boolean> {
  /*
   * 缩略图提供器是 Windows COM（IThumbnailProvider + 注册表）专属实现，
   * Linux 侧没有对应物，也不存在「移植」一说：直接跳过，不做静默降级。
   */
  if (process.platform !== 'win32') return false
  try {
    const { dll, exe } = paths()
    if (!existsSync(dll)) { console.warn('[thumb] 缺少组件：', dll); return false }
    await writeTree(HKCU, dll, exe, app.getAppPath())
    await writeTree(HKLM, dll, exe, app.getAppPath())
    await reg(['delete', HKCU + '\\CLSID\\' + LEGACY_CLSID, '/f'])
    console.log('[thumb] 缩略图提供器已注册：', dll)
    return true
  } catch (err) {
    console.warn('[thumb] 注册失败：', err)
    return false
  }
}

export async function removeShellThumb(): Promise<void> {
  if (process.platform !== 'win32') return
  for (const root of [HKCU, HKLM]) {
    await reg(['delete', root + '\\CLSID\\' + THUMB_CLSID, '/f'])
    await reg(['delete', root + '\\CLSID\\' + LEGACY_CLSID, '/f'])
    await reg(['delete', root + '\\.pdf\\ShellEx\\' + HANDLER, '/f'])
    await reg(['delete', root + '\\SystemFileAssociations\\.pdf\\ShellEx\\' + HANDLER, '/f'])
  }
}
