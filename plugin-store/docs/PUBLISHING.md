# 上架流程

1. **准备包**：按 `docs/API.md` 第 2 节打 zip，根目录放 `manifest.json`。
2. **算校验值**：
   ```powershell
   (Get-FileHash .\theme-qingyue-1.0.0.zip -Algorithm SHA256).Hash.ToLower()
   (Get-Item .\theme-qingyue-1.0.0.zip).Length
   ```
3. **传包**：GitHub Release（tag `themes`）或任意 HTTPS 静态托管；确认直链能直接下载 zip。
4. **改清单**：在 `index.json` 的 `items` 里加一条，填 `download` / `sha256` / `size` / `minAppVersion`。
5. **本地自检**：`node tools/check-market.mjs`（校验 schema、直链、sha 长度、id 唯一）。
6. **发 PR**：改完提 PR，合并后 5 分钟内生效（若走镜像站，另有 10 分钟缓存）。

## 审核口径

- 不含可执行代码（本仓库只收主题包）。
- 不含第三方版权素材，或已附授权说明。
- 不收集用户数据、不含外链跳转。
- 命名规范：`theme-<拼音>` / 插件 `plugin-<拼音>`。
