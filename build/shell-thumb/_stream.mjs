import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const p = fileURLToPath(new URL('QXThumbNative.cpp', import.meta.url))
let s = readFileSync(p, 'utf8')

// 1) 声明 IInitializeWithStream
if (!s.includes('IInitializeWithStream')) {
  s = s.replace('class Provider : public IInitializeWithItem', `[ComImport, Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f")]
interface IInitializeWithStream;

class Provider : public IInitializeWithItem`)
  // 用标准 CLSID 定义代替（C++ 里不能 ComImport）
  s = s.replace(`[ComImport, Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f")]
interface IInitializeWithStream;

class Provider : public IInitializeWithItem`,
`static const IID IID_IInitializeWithStream =
  {0xb824b49d, 0x22ac, 0x4161, {0xac, 0x8a, 0x99, 0x16, 0xe8, 0xfa, 0x3f, 0x7f}};

class Provider : public IInitializeWithItem`)
}

// 2) 继承 IInitializeWithStream 并实现
s = s.replace('public IThumbnailProvider {', 'public IThumbnailProvider, public IInitializeWithStream {')
if (!s.includes('IInitializeWithStream* stream')) {
  s = s.replace(`  IFACEMETHODIMP Initialize(PCWSTR path, DWORD) override {`,
`  /** 外壳实际请求的是 IInitializeWithStream —— 必须把流落成临时文件再交给渲染进程。 */
  IFACEMETHODIMP Initialize(IStream* stream, DWORD) override {
    if (!stream) return E_INVALIDARG;
    wchar_t dir[MAX_PATH]; SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, dir);
    std::wstring base(dir); base += L"\\\\QiuxiPdfThumbs"; CreateDirectoryW(base.c_str(), nullptr);
    base += L"\\\\src"; CreateDirectoryW(base.c_str(), nullptr);
    wchar_t tmp[MAX_PATH]; GetTempFileNameW(base.c_str(), L"qx", 0, tmp);
    std::wstring path(tmp); path += L".pdf";
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) { Trace("stream->file failed %lu", GetLastError()); return E_FAIL; }
    char buf[65536]; ULONG got = 0;
    while (SUCCEEDED(stream->Read(buf, sizeof(buf), &got)) && got > 0) { DWORD wrote = 0; WriteFile(h, buf, got, &wrote, nullptr); }
    CloseHandle(h);
    _file = path;
    Trace("Initialize(stream) -> %ls", _file.c_str());
    return S_OK;
  }

  IFACEMETHODIMP Initialize(PCWSTR path, DWORD) override {`)
}
writeFileSync(p, s)
console.log('patched', s.includes('IInitializeWithStream* stream'))
