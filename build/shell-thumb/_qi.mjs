import { readFileSync, writeFileSync } from 'node:fs'
const p = 'QXThumbNative.cpp'
let s = readFileSync(p, 'utf8')
const start = s.indexOf('IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {')
const end = s.indexOf('IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&_ref); }')
if (start < 0 || end < 0) { console.log('MARKER MISSING'); process.exit(1) }
const replacement = `IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IInitializeWithItem) *ppv = static_cast<IInitializeWithItem*>(this);
    else if (riid == IID_IInitializeWithFile) *ppv = static_cast<IInitializeWithFile*>(this);
    else if (riid == IID_IThumbnailProvider) *ppv = static_cast<IThumbnailProvider*>(this);
    else { Trace("QI fail"); return E_NOINTERFACE; }
    AddRef();
    return S_OK;
  }
  `
s = s.slice(0, start) + replacement + s.slice(end)
writeFileSync(p, s)
console.log('QI replaced')
