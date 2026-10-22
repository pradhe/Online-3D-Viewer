# Online 3D Viewer: Product Roadmap

Written 2026-10-18, reordered by priority.

The viewer already opens OBJ and multi-file USD scenes, edits colours and properties, and exports. The next step is making it reliable enough that people trust it with real work. Every item below has a priority and a rank; do them in rank order.

## Where we are

- **Works today:** OBJ and USD/USDA/USDC/USDZ input, folders and zips, NVIDIA and Pixar sample scenes, metadata panel, colour and transform editing with a USD edits layer, GLB/OBJ/USDZ export, tone mapping, ambient occlusion and shadows.
- **Hosting:** GitHub Pages, deployed from `main`. While the repo is private the build is skipped and the site is offline until the repo is public.
- **Known limits:** no USD inherits or specializes, variants authored in sublayers are not applied, MDL materials are approximated, no DDS or EXR textures, metadata is read from the root layer only, and large scenes block the page while loading.

## How priorities work

| Priority | Meaning | Items | Rule of thumb |
| --- | --- | --- | --- |
| P0 Foundation | Protects or unblocks everything else | 9 | Do first, in order |
| P1 High value | The biggest gain for users, plus the groundwork for later features | 8 | Start once P0 tests are running; the UI redesign can start earlier |
| P2 Professional | What people expect from an industry viewer, including the AI assistant | 20 | Pick by what users ask for |
| P3 Later | Large or niche work; decide after real feedback | 6 | Revisit after P1 ships |

Effort is a rough guide: S is days, M is a couple of weeks, L is a month or more. The Area column shows which theme an item belongs to: Stability, Formats, Features, Interface, Engineering, Release or AI.

Dependencies: the AI chat (P2) needs the action layer and undo from P1, and the tests from P0.

## P0 Foundation

Goal: nothing freezes or regresses unnoticed, and the basics for releasing are settled.

| # | Item | Area | What we do | Why it matters | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Target audience | Release | Decide: free public viewer, internal tool, or paid product | Decides whether accounts, cloud storage, sharing permissions or analytics are needed | decision |
| 2 | Automated tests and CI (done) | Stability | Move the throwaway Playwright checks into the repo, add Vitest tests for the USD parsers, keep small sample files (Kitchen Set, a texture-heavy asset, a broken file), and make the deploy wait for green tests | Stops regressions; today nothing checks a change before it goes live | M |
| 3 | Dependency safety (done) | Stability | Pin versions, enable Dependabot, run the tests on every upgrade | The USD code leans on three.js internals that change between versions | S |
| 4 | Error handling and reporting (done) | Stability | Clear messages for corrupt or unsupported files; optional crash reporting such as Sentry | Failures are noticed before users complain | S |
| 5 | Loading in Web Workers (done for USD) | Stability | Parse USD and OBJ off the main thread, show real progress and a Cancel button | The 29 MB NVIDIA fridge froze the page for about 45 seconds | M |
| 6 | Memory and size limits (done) | Stability | Memory budget, texture downscaling for huge images, a heavy-model warning, proper disposal of the previous model | A 2.4 million-vertex scene can crash a phone | M |
| 7 | Account and repo security | Release | Two-factor authentication with recovery codes, Dependabot, a ruleset protecting `main`, a local backup clone | Protects against losing the account or code | S |
| 8 | Hosting for a private repo | Release | Netlify or Cloudflare Pages (config already in the repo), or GitHub's private Pages on a paid plan | Keeps the site online while the code stays private | S |
| 9 | Licences | Release | Add a LICENSE for the code, credit three.js (MIT), and check the terms of the bundled city sample and any NVIDIA or Pixar sample files | Avoids legal problems when public | S |

**Done when:** every push runs the tests, a 30 MB scene loads without freezing the page, a bad file shows a readable error, and the licence and hosting are settled.

## P1 High value

Goal: the improvements users notice most, and the groundwork that later features stand on.

| # | Item | Area | What we do | Why it matters | Effort |
| --- | --- | --- | --- | --- | --- |
| 10 | glTF/GLB input | Formats | Add the format through three.js' existing loader, with Draco and meshopt compression | The most common web 3D format; the quickest win for users | S |
| 11 | Validation report | Formats | List what a file contains and what could not be shown or was approximated | Users know when the picture is not the full truth | S |
| 12 | UI redesign | Interface | Cleaner toolbar, tabbed side panels, refined dark theme, all current features kept | A more professional look | M |
| 13 | Action layer | AI | Turn every viewer operation (select, isolate, hide, colour, transform, camera, measure, section, export) into a named command with typed parameters | Undo, tests and the AI chat all build on it, and the buttons and chat behave the same | M |
| 14 | Undo and redo | Features | One history across colour, transform and property edits | Editing without undo feels unsafe | M |
| 15 | Saved views and sharing | Features | Camera bookmarks, shareable links that carry the view, embed code, turntable video or GIF export | Lets people show a model to others | M |
| 16 | Privacy statement | Release | State plainly that files never leave the browser; keep the Content Security Policy | A real selling point | S |
| 17 | Split large files | Engineering | Break `main.js` and `viewer.js`, each over 1,000 lines, into focused modules | Bugs are easier to find and fix, and every later feature gets cheaper | M |

**Done when:** glTF/GLB opens, edits can be undone, the new UI is live, and a view can be shared by link.

## P2 Professional

Goal: the tools an industry viewer is expected to have. Order within this tier by what users ask for; the AI assistant items are grouped together and run in the order shown.

| # | Item | Area | What we do | Why it matters | Effort |
| --- | --- | --- | --- | --- | --- |
| 18 | Chat panel | AI | Docked panel with message history, streaming replies, a visible list of the actions taken, and a Stop button | The live feel; you always see what the assistant changed | M |
| 19 | Model connection | AI | Send the chat and the command list to the Claude API with tool use; the model replies with commands the viewer runs. Two options: your own API key kept in the browser, or a small backend proxy that holds the key and limits use | A static GitHub Pages site cannot keep a secret key, so this choice decides cost and who can use it | M |
| 20 | Scene awareness | AI | Send a compact summary only (object names, USD paths, materials, bounding boxes, current selection), never geometry or textures | "The left window" can be resolved to an object, and model files stay on the device | M |
| 21 | Assistant safety | AI | Edits are undoable, bulk or destructive changes ask for confirmation, a cap on commands per message, and the assistant can only call viewer commands | Prevents surprises from a misread request | S |
| 22 | Questions about the model | AI | Answer "how many meshes", "which materials are used", "what is this prim" from the metadata | Useful even when nothing is changed | S |
| 23 | Assistant evaluation set | AI | Sample prompts with the expected commands, run in CI | Keeps behaviour stable when the model or the commands change | M |
| 24 | Measuring | Features | Angles, areas, radius, unit switching, snap to vertex | Extends the distance tool already there | M |
| 25 | Sections and exploded view | Features | Clipping planes and part separation | Standard for inspecting assemblies and buildings | M |
| 26 | USD variants | Features | A switcher for variant sets such as colour or configuration | Core USD feature, needed for product models | M |
| 27 | Annotations | Features | Notes pinned to points on the model, saved with the session | Review and feedback workflows | M |
| 28 | Session save | Features | Save and reopen edits, views and notes | Work survives closing the tab | M |
| 29 | Animation timeline | Features | Scrubbing, speed and range controls | The player today only plays and pauses | S |
| 30 | FBX, STL, PLY and 3MF input | Formats | Add loaders, reusing the same scene tree and selection | Covers CAD, scanning and printing workflows | M |
| 31 | Fuller USD composition | Formats | Support inherits, specializes, `over` prims, variants from sublayers and layer time offsets; metadata from every layer | Closes the main known gaps against Pixar's results | L |
| 32 | Keyboard and screen-reader support | Interface | Full keyboard navigation, labelled controls, focus order (WCAG) | Required by many organisations | M |
| 33 | Touch and phones | Interface | Gesture controls, larger targets, a layout for narrow screens | Viewing on tablets and phones | M |
| 34 | Light theme and settings screen | Interface | Theme switch, remembered preferences | Comfort and screenshots for documents | S |
| 35 | Load-time performance | Engineering | Split the bundle (over 900 KB today) so the first page appears sooner | Faster first visit | S |
| 36 | Large-scene performance | Engineering | Level of detail, culling, faster picking with a BVH | Smooth navigation of big scenes | L |
| 37 | Releases and docs | Release | Version numbers, a changelog, a user guide, a sample gallery | Users and contributors can follow changes | M |

The AI assistant is off by default, and the privacy statement must say that chat messages and the scene summary go to the model provider.

**Done when:** a user can measure, section and switch variants, and typing "isolate the fridge and make it red" does it in one message, Undo reverses it, and nothing leaves the browser except the chat text and the scene summary.

## P3 Later

Goal: large or niche work, decided after real user feedback.

| # | Item | Area | What we do | Why it matters | Effort |
| --- | --- | --- | --- | --- | --- |
| 38 | Materials and textures | Formats | MaterialX, KTX2, DDS, EXR and UDIM tiles; a closer MDL approximation | Fewer missing or wrong-looking textures | L |
| 39 | Pixar USD in WebAssembly | Formats | Evaluate compiling the real USD engine to WebAssembly for exact composition | Exact results instead of a simplified reimplementation; heavy download, so a decision point | L |
| 40 | Compare | Features | Two models or two versions side by side, differences highlighted | Useful for revision checks | L |
| 41 | TypeScript | Engineering | Move module by module, starting with the USD code | Catches mistakes before users do | L |
| 42 | Offline use | Engineering | Progressive Web App so it installs and works without internet | Fits the no-upload privacy promise | S |
| 43 | Languages | Interface | Move text into translation files | Reach beyond English | S |

**Done when:** each item is either scheduled into P1 or P2 based on feedback, or dropped.

## Decisions and next step

Start with P0 in rank order, with the UI redesign (rank 12) running alongside from the beginning.

Decisions that change the plan:

- [ ] Who is the viewer for: free public tool, internal tool, or paid product? (rank 1, blocks the others)
- [ ] Hosting while the repo is private: Netlify or Cloudflare Pages, or make the repo public? (rank 8)
- [ ] AI assistant timing: it is P2 because it needs the action layer, undo and tests first. Move it earlier if it is your main selling point.
- [ ] AI assistant key: bring-your-own API key in the browser, or a backend proxy that holds the key? (rank 19)
- [ ] Exact USD results: invest in a WebAssembly build of Pixar USD (large download, high accuracy), or keep extending the current loader? (ranks 31 and 39)
