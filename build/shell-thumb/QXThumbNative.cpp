// 秋夕-PDF阅读器 · 原生 PDF 缩略图提供器（IThumbnailProvider）
// 编译：cl /LD /EHsc /O2 QXThumbNative.cpp /link windowscodecs.lib ole32.lib shlwapi.lib shcore.lib
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <thumbcache.h>
#include <shlwapi.h>
#include <wincodec.h>
#include <string>
#include <cstdio>

static const wchar_t* kClsid = L"{0A1B2C3D-4E5F-4A6B-8C7D-9E0F11223344}";
static const CLSID CLSID_QxThumb = {0x0A1B2C3D,0x4E5F,0x4A6B,{0x8C,0x7D,0x9E,0x0F,0x11,0x22,0x33,0x44}};

static void Trace(const char* fmt, ...) {
  wchar_t tmp[MAX_PATH]; GetTempPathW(MAX_PATH, tmp);
  wcscat_s(tmp, L"qxthumb-native.log");
  FILE* f = nullptr;
  if (_wfopen_s(&f, tmp, L"a") == 0 && f) {
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(f, "%02d:%02d:%02d ", st.wHour, st.wMinute, st.wSecond);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fprintf(f, "\n"); fclose(f);
  }
}

static std::wstring ReadString(HKEY root, const wchar_t* sub, const wchar_t* name) {
  HKEY k; std::wstring out;
  if (RegOpenKeyExW(root, sub, 0, KEY_READ, &k) == ERROR_SUCCESS) {
    wchar_t buf[1024]; DWORD cb = sizeof(buf); DWORD type = 0;
    if (RegQueryValueExW(k, name, nullptr, &type, (LPBYTE)buf, &cb) == ERROR_SUCCESS && (type == REG_SZ || type == REG_EXPAND_SZ))
      out.assign(buf, cb / sizeof(wchar_t) > 0 ? (cb / sizeof(wchar_t)) - 1 : 0);
    RegCloseKey(k);
  }
  return out;
}

static std::wstring ThumbExe() {
  std::wstring v = ReadString(HKEY_LOCAL_MACHINE, (std::wstring(L"Software\\Classes\\CLSID\\") + kClsid).c_str(), L"ThumbExe");
  if (v.empty()) v = ReadString(HKEY_CURRENT_USER, (std::wstring(L"Software\\Classes\\CLSID\\") + kClsid).c_str(), L"ThumbExe");
  return v;
}
static std::wstring ThumbArgs() {
  std::wstring v = ReadString(HKEY_LOCAL_MACHINE, (std::wstring(L"Software\\Classes\\CLSID\\") + kClsid).c_str(), L"ThumbArgs");
  if (v.empty()) v = ReadString(HKEY_CURRENT_USER, (std::wstring(L"Software\\Classes\\CLSID\\") + kClsid).c_str(), L"ThumbArgs");
  return v;
}

static std::wstring CachePath(const std::wstring& file) {
  wchar_t dir[MAX_PATH]; SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, dir);
  std::wstring base(dir); base += L"\\QiuxiPdfThumbs";
  CreateDirectoryW(base.c_str(), nullptr);
  WIN32_FILE_ATTRIBUTE_DATA fad{};
  GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &fad);
  wchar_t name[64];
  swprintf_s(name, L"%08x%08x%08x.png", fad.ftLastWriteTime.dwHighDateTime, fad.ftLastWriteTime.dwLowDateTime, fad.nFileSizeLow);
  return base + L"\\" + name;
}

static bool Fresh(const std::wstring& a, const std::wstring& b) {
  WIN32_FILE_ATTRIBUTE_DATA fa{}, fb{};
  if (!GetFileAttributesExW(a.c_str(), GetFileExInfoStandard, &fa)) return false;
  if (!GetFileAttributesExW(b.c_str(), GetFileExInfoStandard, &fb)) return false;
  return CompareFileTime(&fa.ftLastWriteTime, &fb.ftLastWriteTime) >= 0;
}

static void RunRender(const std::wstring& file, const std::wstring& png) {
  std::wstring exe = ThumbExe();
  if (exe.empty() || GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) { Trace("no ThumbExe"); return; }
  std::wstring args = ThumbArgs();
  wchar_t cmd[4096];
  swprintf_s(cmd, L"\"%s\" %s --render-thumb \"%s\" \"%s\"", exe.c_str(), args.c_str(), file.c_str(), png.c_str());
  STARTUPINFOW si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
    Trace("CreateProcess failed %lu", GetLastError()); return;
  }
  DWORD w = WaitForSingleObject(pi.hProcess, 20000);
  if (w != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  Trace("rendered ret=%lu exists=%d", w, GetFileAttributesW(png.c_str()) != INVALID_FILE_ATTRIBUTES);
}

static HBITMAP LoadPng(const std::wstring& png, UINT cx) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  IWICImagingFactory* fac = nullptr;
  hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&fac));
  if (FAILED(hr)) { Trace("WIC factory 0x%08lx", hr); return nullptr; }
  IWICBitmapDecoder* dec = nullptr;
  hr = fac->CreateDecoderFromFilename(png.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &dec);
  if (FAILED(hr)) { fac->Release(); Trace("decode 0x%08lx", hr); return nullptr; }
  IWICBitmapFrameDecode* frame = nullptr; dec->GetFrame(0, &frame);
  IWICFormatConverter* conv = nullptr; fac->CreateFormatConverter(&conv);
  UINT w = 0, h = 0; frame->GetSize(&w, &h);
  double scale = (cx > 0 && w > cx) ? (double)cx / (double)w : 1.0;
  UINT nw = (UINT)(w * scale), nh = (UINT)(h * scale);
  conv->Initialize(frame, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom);
  HBITMAP bmp = nullptr;
  IWICBitmap* scaled = nullptr;
  IWICBitmapScaler* scaler = nullptr;
  fac->CreateBitmapScaler(&scaler); scaler->Initialize(conv, nw, nh, WICBitmapInterpolationModeFant);
  IWICBitmapSource* src = scaler;
  // 用 CreateBitmapFromSource 拿到 IWICBitmap，再画到 DIB 上
  fac->CreateBitmapFromSource(src, WICBitmapCacheOnLoad, &scaled);
  BITMAPINFO bi{}; bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = nw; bi.bmiHeader.biHeight = -(LONG)nh;
  bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC dc = GetDC(nullptr);
  bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  if (bmp && bits) {
    WICRect rc{0, 0, (INT)nw, (INT)nh};
    scaled->CopyPixels(&rc, nw * 4, nw * nh * 4, (BYTE*)bits);
    for (UINT i = 0; i < nw * nh; ++i) ((BYTE*)bits)[i * 4 + 3] = 255; // 缩略图不需要透明
  }
  if (scaled) scaled->Release();
  if (scaler) scaler->Release();
  if (conv) conv->Release();
  if (frame) frame->Release();
  if (dec) dec->Release();
  if (fac) fac->Release();
  if (SUCCEEDED(hr) && hr == S_OK) CoUninitialize();
  return bmp;
}

class Provider : public IInitializeWithItem, public IInitializeWithFile, public IThumbnailProvider, public IInitializeWithStream {
 public:
  Provider() : _ref(1) {}
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IInitializeWithItem) *ppv = static_cast<IInitializeWithItem*>(this);
    else if (riid == IID_IInitializeWithFile) *ppv = static_cast<IInitializeWithFile*>(this);
    else if (riid == IID_IThumbnailProvider) *ppv = static_cast<IThumbnailProvider*>(this);
    else if (riid == IID_IInitializeWithStream) *ppv = static_cast<IInitializeWithStream*>(this);
    else { wchar_t buf[64]; StringFromGUID2(riid, buf, 64); char u8[128]; WideCharToMultiByte(CP_UTF8, 0, buf, -1, u8, sizeof(u8), nullptr, nullptr); Trace("QI fail for %s", u8); return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&_ref); }
  IFACEMETHODIMP_(ULONG) Release() override { ULONG c = InterlockedDecrement(&_ref); if (!c) delete this; return c; }

  IFACEMETHODIMP Initialize(IShellItem* psi, DWORD) override {
    PWSTR path = nullptr;
    HRESULT hr = psi ? psi->GetDisplayName(SIGDN_FILESYSPATH, &path) : E_INVALIDARG;
    if (SUCCEEDED(hr)) { _file.assign(path); CoTaskMemFree(path); }
    Trace("Initialize(item) hr=0x%08lx file=%ls", hr, _file.c_str());
    return hr;
  }
  /** 外壳实际请求的是 IInitializeWithStream —— 必须把流落成临时文件再交给渲染进程。 */
  IFACEMETHODIMP Initialize(IStream* stream, DWORD) override {
    if (!stream) return E_INVALIDARG;
    wchar_t dir[MAX_PATH]; SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, dir);
    std::wstring base(dir); base += L"\\QiuxiPdfThumbs"; CreateDirectoryW(base.c_str(), nullptr);
    base += L"\\src"; CreateDirectoryW(base.c_str(), nullptr);
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

  IFACEMETHODIMP Initialize(PCWSTR path, DWORD) override {
    _file.assign(path ? path : L"");
    Trace("Initialize(file) %ls", _file.c_str());
    return S_OK;
  }

  IFACEMETHODIMP GetThumbnail(UINT cx, HBITMAP* phbmp, WTS_ALPHATYPE* pdwAlpha) override {
    if (!phbmp || !pdwAlpha) return E_POINTER;
    *phbmp = nullptr; *pdwAlpha = WTSAT_ARGB;
    if (_file.empty()) return E_UNEXPECTED;
    std::wstring png = CachePath(_file);
    if (!Fresh(png, _file)) RunRender(_file, png);
    if (GetFileAttributesW(png.c_str()) == INVALID_FILE_ATTRIBUTES) { Trace("no png for %ls", _file.c_str()); return E_FAIL; }
    *phbmp = LoadPng(png, cx);
    Trace("GetThumbnail cx=%u -> %p", cx, *phbmp);
    return *phbmp ? S_OK : E_FAIL;
  }

 private:
  LONG _ref;
  std::wstring _file;
};

class Factory : public IClassFactory {
 public:
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == IID_IUnknown || riid == IID_IClassFactory) { *ppv = static_cast<IClassFactory*>(this); AddRef(); return S_OK; }
    *ppv = nullptr; return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&_ref); }
  IFACEMETHODIMP_(ULONG) Release() override { ULONG c = InterlockedDecrement(&_ref); if (!c) delete this; return c; }
  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    Provider* p = new (std::nothrow) Provider();
    if (!p) return E_OUTOFMEMORY;
    HRESULT hr = p->QueryInterface(riid, ppv);
    p->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL) override { return S_OK; }
 private:
  LONG _ref = 1;
};

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
  Trace("GCO enter clsid-match=%d", rclsid == CLSID_QxThumb);
  if (rclsid != CLSID_QxThumb) return CLASS_E_CLASSNOTAVAILABLE;
  Factory* f = new (std::nothrow) Factory();
  if (!f) return E_OUTOFMEMORY;
  HRESULT hr = f->QueryInterface(riid, ppv);
  f->Release();
  return hr;
}
extern "C" HRESULT __stdcall DllCanUnloadNow() { return S_OK; }
BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; } // 不能在 DllMain 里做文件 IO（会 CO_E_ERRORINDLL）