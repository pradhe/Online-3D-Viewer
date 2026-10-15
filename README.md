# MyCity 3D Viewer

**Live:** https://pradhe.github.io/Online-3D-Viewer/

A browser-based 3D model viewer for **OBJ** and **USD** files, built with [three.js](https://threejs.org) and [Vite](https://vite.dev).
Files are opened locally in the browser and are never uploaded anywhere.

## Supported formats

| Format | Extensions | Notes |
|---|---|---|
| Wavefront OBJ | `.obj` (+ `.mtl`, textures) | Select or drop the `.obj` together with its `.mtl` and texture images, a folder, or a `.zip` containing them. A renamed `.mtl` is still picked up. |
| Universal Scene Description | `.usd`, `.usda`, `.usdc`, `.usdz` | ASCII and binary (crate) USD, and USDZ packages with embedded textures. Z-up stages and `metersPerUnit` are respected. Skeletal animation clips can be played. |

You can also open a model from a URL (the server must allow CORS), or link straight to one:
`index.html?model=https://example.com/model.usdz`. The bundled samples open with `?sample=city` or `?sample=shapes`.

## Features

- **Navigation** – rotate, pan and zoom (zoom goes towards the cursor), smooth focus animations, fit-to-view, front/back/left/right/top/bottom/iso views, perspective/orthographic toggle, auto-rotate, adjustable field of view. Works with touch.
- **Selection** – click (or tap) to select, Shift/Ctrl+click for multi-select, double-click to focus. Selected objects are outlined and shown in the scene tree.
- **Scene tree** – browse the model's hierarchy, search by name, and show or hide objects.
- **Properties** – vertex and triangle counts, size, position and materials of the selection. Hide, isolate and show all.
- **USD metadata** – for USD files, the selected prim's path, type, kind, doc, `customData`, `assetInfo`, API schemas, every attribute (custom ones first, with type, `uniform` and `animated` badges) and relationships such as `material:binding`. The **USD stage** section shows layer metadata: `defaultPrim`, `upAxis`, `metersPerUnit`, time codes, `doc` and `customLayerData`. Works for `.usda`, `.usdc` and `.usdz`.
- **Transform gizmo** – move, rotate or scale the selected part, and reset it.
- **Measure** – click two points on the surface to measure the distance between them.
- **Display options** – render modes (shaded, clay, wireframe, X-ray, normals), background color, grid, axes, bounding box, shadows, double-sided materials, light/environment/exposure sliders, and Y-up/Z-up correction. Settings are remembered in the browser.
- **Model info** – file size, objects, meshes, vertices, triangles, materials, textures, dimensions and load time.
- **Output** – PNG screenshot, and export to GLB, OBJ or USDZ (so it doubles as an OBJ ↔ USDZ converter).
- Fullscreen, a keyboard shortcuts help screen (`?`), and a responsive layout for phones.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `F` | Focus selection / fit all |
| `1`–`7` | Front, back, left, right, top, bottom, iso view |
| `P` | Perspective / orthographic |
| `W` `E` `R` / `Q` | Move / rotate / scale gizmo / gizmo off |
| `H` `I` `U` | Hide / isolate / show all |
| `M` | Measure |
| `G` | Grid |
| `Esc` | Exit measure, turn off the gizmo, or clear the selection |
| `Ctrl+O` | Open files |

## Development

Requires Node.js 18+.

```bash
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # production build in dist/
npm run preview   # serve the production build
```

## Deploying

Every push to `main` is built and published to GitHub Pages by `.github/workflows/deploy.yml`
(repository **Settings → Pages → Source** must be set to **GitHub Actions**).

`npm run build` produces a fully static site in `dist/` with relative paths, so it can also be hosted from any folder on
Netlify, Vercel, Cloudflare Pages, S3, or any web server.

## Project layout

```
Online-3D-Viewer/
├── .github/workflows/deploy.yml  # GitHub Pages deployment
├── index.html          # UI layout
├── public/samples/     # bundled sample models (low-poly city OBJ, shapes USDA)
└── src/
    ├── main.js         # UI wiring: panels, tree, menus, shortcuts, drag & drop
    ├── viewer.js       # three.js scene, camera, controls, selection, measure, display modes
    ├── loaders.js      # OBJ/MTL and USD loading from files, zips, folders and URLs
    ├── usdMetadata.js  # USD stage/prim metadata, attributes and relationships
    ├── usdFixes.js     # fixes for three.js' binary USD reader
    ├── exporters.js    # GLB / OBJ / USDZ export
    └── style.css
```

## Limitations

- USD loading uses three.js' `USDLoader`, with fixes for binary USD (`src/usdFixes.js`): double/half vectors stored inline (e.g. a `translate` of `(0, 45, 0)`) and `string[]` values. Metadata is read separately in `src/usdMetadata.js`. It covers meshes, primitives (cube, sphere, cylinder, cone, capsule), `UsdPreviewSurface` materials, transforms, lights, cameras and skeletal animation. External references and sublayers in a separate file are not resolved when you open a single local file; package them as `.usdz` instead.
- OBJ export contains geometry only. Use GLB or USDZ to keep materials.
- Very large models (millions of triangles) depend on the device's GPU and memory.

## Credits

The low-poly city sample is the *Lowpoly City Free Pack* by [Anton Moek](https://www.antonmoek.com).
