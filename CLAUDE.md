# MyCity 3D Viewer — notes for Claude

Browser-based OBJ / USD viewer and light editor. three.js 0.186 + Vite 8, plain JS modules, no framework.
Live: https://pradhe.github.io/Online-3D-Viewer/ — every push to `main` deploys via `.github/workflows/deploy.yml`
(the workflow cancels stuck Pages deployments first; keep that step).

## Layout

- `index.html` — all UI markup (top bar, scene tree, viewport, right panel, dialogs).
- `src/main.js` — UI wiring: loading, menus, scene tree, Selection panel, Display settings (saved in localStorage under `mycity-viewer:settings:v2`), keyboard shortcuts.
- `src/viewer.js` — `Viewer` class: renderer, cameras, controls, selection/outline, measure, render modes, GTAO, shadows, lighting presets, tone mapping. Renders **on demand**: call `viewer.invalidate()` after anything that changes the image (viewer `_emit()` and global input events already do).
- `src/loaders.js` — OBJ/MTL (Phong converted to MeshStandardMaterial, mesh pivots recentred), files/folders/zip (zip entries unpacked lazily), USD entry points, `fetchRemote` (web URLs and `omniverse://…/NVIDIA/…` → NVIDIA's public S3 mirror, CORS-enabled).
- `src/workerClient.js` / `src/usd.worker.js` / `src/usdJob.js` / `src/sceneTransfer.js` — USD loading runs in a Web Worker: the job reads files, parses/merges layers, composes the scene (textures are stubbed, then decoded with `createImageBitmap`), and `packScene` splits the scene into three.js JSON + transferable typed arrays + exact float colours + texture slots; `unpackScene` rebuilds it on the main thread. One worker per job (terminate = Cancel); a second worker reads metadata in parallel; falls back to the same code inline if workers are unavailable. OBJ still loads on the main thread. `src/assets.js` holds the file/zip helpers shared by both.
- `src/memory.js` / `src/imageSize.js` — memory budget (`deviceLimits`: from `navigator.deviceMemory`/mobile, `?memory=<MB>` overrides for tests), `measureScene`, `fitToBudget` (caps textures at 4096/2048 px, then halves the largest until the scene fits), `disposeObject` (geometry, every texture slot, ImageBitmaps, instanced meshes). Textures are capped while decoding in the worker (size read from the PNG/JPEG/WebP header); `main.js` `fitModelToDevice` refuses a model above the hard limit, and for heavy models (>1.5M triangles or over budget) turns shadows/AO off for that model only.
- `src/usdStage.js` — multi-file USD: gathers referenced layers/payloads/sublayers/textures, merges sublayers, resolves paths as URLs under `file:///bundle/`, caches repeated references, builds PointInstancers, converts USD colours to linear.
- `src/usdFixes.js` — prototype patches for three.js' USD parsers/composer (binary references, payloads, sublayers, dictionaries, inline double vectors, string/uchar arrays; all reference forms in text files; MDL OmniPBR/OmniSurface/OmniGlass materials).
- `src/usdMetadata.js` — reads stage/prim metadata, attributes, relationships for the Selection panel (root layer only).
- `src/editor.js` — Appearance / Transform / USD property editing and the "USD edits layer" export (overrides that sublayer the original).
- `src/exporters.js` — GLB / OBJ / USDZ export. `src/toneMapping.js` — CPU copies of tone curves (keeps the background colour exact). `src/environments.js` — Studio / Soft / Outdoor IBL presets.

## Decisions and pitfalls (verified)

- Anything added to the USD pipeline must run without the DOM (it executes in a worker) and its output must survive `packScene`: new material/texture properties are carried by three's JSON, colours by the float table, textures by slots. `tests/unit/transfer.test.js` compares the rebuilt scene with the main-thread one — extend it when adding scene features.
- Playwright `setInputFiles` with an in-memory buffer blocks the page thread; give big test files as paths.

- Errors: `src/errors.js` — throw `ViewerError(message, hint)` for anything the user can act on; `checkUsdBytes` rejects empty/non-USD files early and `assertHasGeometry` fails a load that drew nothing (never open an empty scene as a success). `describeError` maps raw errors (truncated files, memory, network). Global `error`/`unhandledrejection` and WebGL context loss are handled in `main.js`.
- Crash reporting (`src/reporting.js`) is opt-in and off unless built with `VITE_ERROR_ENDPOINT`; it sends scrubbed error text only (no file names/URLs/model data), max 5 per session.

- USD colour values are **linear**. three.js' loader reads them as sRGB; `usdStage.linearizeUsdColors` undoes that and the editor writes linear values back. Checked against Pixar USD.
- `assetInfo` identifiers are labels, not links — only references/payloads/sublayers are followed; attribute values are fetched only when they are images.
- Binary USD inlines small vectors as int8 per component; three.js missed double/half vectors (crashed on `translate (0,45,0)`).
- Composed objects carry `userData.usdPath`; materials get the bound USD material's name.
- Side panel grids need `grid-template-columns: minmax(0, 1fr)` or they overflow horizontally.

## Testing

- `npm test` — Vitest unit tests (`tests/unit`): tone-mapping inverse, USD loading/composition/metadata against Pixar-authored fixtures in `tests/fixtures` (binary + text, references, sublayers, broken files).
- `npm run test:e2e` — Playwright smoke tests (`tests/e2e`): builds, serves `dist`, opens the OBJ/USD samples and files, checks errors and a non-blank canvas. In this sandbox set `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (software WebGL flags are already in `playwright.config.js`).
- CI: `.github/workflows/ci.yml` runs both; `deploy.yml` calls it first, so nothing deploys unless they pass. Dependabot is configured in `.github/dependabot.yml`.
- Regenerate fixtures with Pixar's `pxr` (`pip install usd-core`) — keep them tiny. A good manual check beyond CI: Pixar Kitchen Set (229 layers, 1,788 meshes), NVIDIA fridge (`Assets/ArchVis/Residential/Appliances/Refrigerators/fridge.usd`, 112 textures).
- Mutation check when adding a USD fix: disable the patch and confirm a test fails.

## Status / next steps

- Full plan: `ROADMAP.md` (ranked items in four priority tiers P0 to P3).
- Next: **UI redesign** — more polished, industry-standard look (cleaner toolbar, tabbed side panels, refined dark theme), keeping all features.
- Known limits: no inherits/specializes, `over` prims in text layers ignored, sublayer merge is per-prim, MDL approximated, no DDS/EXR, metadata only from the root layer.
- The NVIDIA "USD Explorer" sample (cloudfront host) was never tested directly — the network policy blocks that host.
- The copy of the viewer in the MyCity repo (`viewer/`) is the first version and is out of date.
