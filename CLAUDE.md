# MyCity 3D Viewer — notes for Claude

Browser-based OBJ / USD viewer and light editor. three.js 0.186 + Vite 8, plain JS modules, no framework.
Live: https://pradhe.github.io/Online-3D-Viewer/ — every push to `main` deploys via `.github/workflows/deploy.yml`
(the workflow cancels stuck Pages deployments first; keep that step).

## Layout

- `index.html` — all UI markup (top bar, scene tree, viewport, right panel, dialogs).
- `src/main.js` — UI wiring: loading, menus, scene tree, Selection panel, Display settings (saved in localStorage under `mycity-viewer:settings:v2`), keyboard shortcuts.
- `src/viewer.js` — `Viewer` class: renderer, cameras, controls, selection/outline, measure, render modes, GTAO, shadows, lighting presets, tone mapping. Renders **on demand**: call `viewer.invalidate()` after anything that changes the image (viewer `_emit()` and global input events already do).
- `src/loaders.js` — OBJ/MTL (Phong converted to MeshStandardMaterial, mesh pivots recentred), files/folders/zip (zip entries unpacked lazily), USD entry points, `fetchRemote` (web URLs and `omniverse://…/NVIDIA/…` → NVIDIA's public S3 mirror, CORS-enabled).
- `src/usdStage.js` — multi-file USD: gathers referenced layers/payloads/sublayers/textures, merges sublayers, resolves paths as URLs under `file:///bundle/`, caches repeated references, builds PointInstancers, converts USD colours to linear.
- `src/usdFixes.js` — prototype patches for three.js' USD parsers/composer (binary references, payloads, sublayers, dictionaries, inline double vectors, string/uchar arrays; all reference forms in text files; MDL OmniPBR/OmniSurface/OmniGlass materials).
- `src/usdMetadata.js` — reads stage/prim metadata, attributes, relationships for the Selection panel (root layer only).
- `src/editor.js` — Appearance / Transform / USD property editing and the "USD edits layer" export (overrides that sublayer the original).
- `src/exporters.js` — GLB / OBJ / USDZ export. `src/toneMapping.js` — CPU copies of tone curves (keeps the background colour exact). `src/environments.js` — Studio / Soft / Outdoor IBL presets.

## Decisions and pitfalls (verified)

- USD colour values are **linear**. three.js' loader reads them as sRGB; `usdStage.linearizeUsdColors` undoes that and the editor writes linear values back. Checked against Pixar USD.
- `assetInfo` identifiers are labels, not links — only references/payloads/sublayers are followed; attribute values are fetched only when they are images.
- Binary USD inlines small vectors as int8 per component; three.js missed double/half vectors (crashed on `translate (0,45,0)`).
- Composed objects carry `userData.usdPath`; materials get the bound USD material's name.
- Side panel grids need `grid-template-columns: minmax(0, 1fr)` or they overflow horizontally.

## Testing

`npm run build`, serve `dist/` under `/Online-3D-Viewer/`, drive it with Playwright (Chromium at `/opt/pw-browsers/chromium`, flags `--use-angle=swiftshader --enable-unsafe-swiftshader`). Useful checks: Pixar Kitchen Set (229 layers, 1,788 meshes — matches Pixar USD), NVIDIA fridge (`Assets/ArchVis/Residential/Appliances/Refrigerators/fridge.usd`, 112 textures), city OBJ sample, shapes USDA sample. `pip install usd-core` gives Pixar's `pxr` for authoring test files and verifying edits layers.

## Status / next steps

- Full plan: `ROADMAP.md` (seven phases: stability, formats, features, interface, engineering, release, AI assistant chat).
- Next: **UI redesign** — more polished, industry-standard look (cleaner toolbar, tabbed side panels, refined dark theme), keeping all features.
- Known limits: no inherits/specializes, `over` prims in text layers ignored, sublayer merge is per-prim, MDL approximated, no DDS/EXR, metadata only from the root layer.
- The NVIDIA "USD Explorer" sample (cloudfront host) was never tested directly — the network policy blocks that host.
- The copy of the viewer in the MyCity repo (`viewer/`) is the first version and is out of date.
