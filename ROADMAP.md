# Online 3D Viewer: Product Roadmap

Written 2026-10-18.

The viewer already opens OBJ and multi-file USD scenes, edits colours and properties, and exports. The next step is making it reliable enough that people trust it with real work, in seven phases.

## Where we are

- **Works today:** OBJ and USD/USDA/USDC/USDZ input, folders and zips, NVIDIA and Pixar sample scenes, metadata panel, colour and transform editing with a USD edits layer, GLB/OBJ/USDZ export, tone mapping, ambient occlusion and shadows.
- **Hosting:** GitHub Pages, deployed from `main`. While the repo is private the build is skipped and the site is offline until the repo is public.
- **Known limits:** no USD inherits or specializes, variants authored in sublayers are not applied, MDL materials are approximated, no DDS or EXR textures, metadata is read from the root layer only, and large scenes block the page while loading.

## Order of work

Stability comes first because every later feature is only as trustworthy as the tests under it. Effort is a rough guide: S is days, M is a couple of weeks, L is a month or more.

| Phase | Gate |
| --- | --- |
| 1. Stability | Tests run on every push; a 30 MB scene loads without freezing |
| 2. Formats | Kitchen Set and fridge match Pixar; glTF/GLB opens |
| 3. Features | Mark up a model, share a link, a colleague sees the same view |
| 4. Interface | Keyboard-only use works; layout holds at phone width |
| 5. Engineering | Files split into smaller modules; faster first load |
| 6. Release | Licence, privacy statement and hosting in place |
| 7. AI assistant | A chat request changes the model and Undo reverses it |

Phase 4 (the UI redesign) can run alongside Phase 1; the other phases follow in order. Phase 7 comes last because it needs the tests from Phase 1 and undo from Phase 3.

## Phase 1: Stability and trust

Goal: the viewer never freezes, crashes silently or regresses without anyone noticing.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| Automated tests and CI | Move the throwaway Playwright checks into the repo, add Vitest tests for the USD parsers, keep small sample files (Kitchen Set, a texture-heavy asset, a broken file), and make the deploy wait for green tests | Stops regressions; today nothing checks a change before it goes live | M |
| Loading in Web Workers | Parse USD and OBJ off the main thread, show real progress and a Cancel button | The 29 MB NVIDIA fridge froze the page for about 45 seconds | M |
| Memory and size limits | Memory budget, texture downscaling for huge images, a heavy-model warning, proper disposal of the previous model | A 2.4 million-vertex scene can crash a phone | M |
| Error handling and reporting | Clear messages for corrupt or unsupported files; optional crash reporting such as Sentry | Failures are noticed before users complain | S |
| Dependency safety | Pin versions, enable Dependabot, run the tests on every upgrade | The USD code leans on three.js internals that change between versions | S |

**Done when:** every push runs the tests, a 30 MB scene loads without freezing the page, and a bad file shows a readable error.

## Phase 2: Correctness and format coverage

Goal: what the viewer shows matches what the file contains, and the common formats open.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| glTF/GLB input | Add the format through three.js' existing loader, with Draco and meshopt compression | The most common web 3D format; the quickest win for users | S |
| FBX, STL, PLY and 3MF input | Add loaders, reusing the same scene tree and selection | Covers CAD, scanning and printing workflows | M |
| Validation report | List what a file contains and what could not be shown or was approximated | Users know when the picture is not the full truth | S |
| Fuller USD composition | Support inherits, specializes, `over` prims, variants from sublayers and layer time offsets; metadata from every layer | Closes the main known gaps against Pixar's results | L |
| Pixar USD in WebAssembly | Evaluate compiling the real USD engine to WebAssembly for exact composition | Exact results instead of a simplified reimplementation; heavy download, so a decision point | L |
| Materials and textures | MaterialX, KTX2, DDS, EXR and UDIM tiles; a closer MDL approximation | Fewer missing or wrong-looking textures | L |

**Done when:** the Kitchen Set and the NVIDIA fridge match Pixar's own output, and glTF/GLB opens with the same selection and export features as OBJ.

## Phase 3: Professional features

Goal: the tools people expect from an industry viewer, in the order they are most often asked for.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| Undo and redo | One history across colour, transform and property edits | Editing without undo feels unsafe | M |
| Saved views and sharing | Camera bookmarks, shareable links that carry the view, embed code, turntable video or GIF export | Lets people show a model to others | M |
| Measuring | Angles, areas, radius, unit switching, snap to vertex | Extends the distance tool already there | M |
| Sections and exploded view | Clipping planes and part separation | Standard for inspecting assemblies and buildings | M |
| Annotations | Notes pinned to points on the model, saved with the session | Review and feedback workflows | M |
| USD variants | A switcher for variant sets such as colour or configuration | Core USD feature, needed for product models | M |
| Animation timeline | Scrubbing, speed and range controls | The player today only plays and pauses | S |
| Compare | Two models or two versions side by side, differences highlighted | Useful for revision checks | L |
| Session save | Save and reopen edits, views and notes | Work survives closing the tab | M |

**Done when:** a reviewer can open a model, mark it up, share a link, and a colleague sees the same view.

## Phase 4: Interface and accessibility

Goal: a polished, industry-standard look that everyone can use. The UI redesign was already planned as the next step, so it can start in parallel with Phase 1.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| UI redesign | Cleaner toolbar, tabbed side panels, refined dark theme, all current features kept | A more professional look | M |
| Light theme and settings screen | Theme switch, remembered preferences | Comfort and screenshots for documents | S |
| Keyboard and screen-reader support | Full keyboard navigation, labelled controls, focus order (WCAG) | Required by many organisations | M |
| Touch and phones | Gesture controls, larger targets, a layout for narrow screens | Viewing on tablets and phones | M |
| Languages | Move text into translation files | Reach beyond English | S |

**Done when:** every control works from the keyboard, and the layout holds at phone width.

## Phase 5: Engineering quality

Goal: the code stays easy to change as features are added.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| Split large files | Break `main.js` and `viewer.js`, each over 1,000 lines, into focused modules | Bugs are easier to find and fix | M |
| TypeScript | Move module by module, starting with the USD code | Catches mistakes before users do | L |
| Load-time performance | Split the bundle (over 900 KB today) so the first page appears sooner | Faster first visit | S |
| Large-scene performance | Level of detail, culling, faster picking with a BVH | Smooth navigation of big scenes | L |
| Offline use | Progressive Web App so it installs and works without internet | Fits the no-upload privacy promise | S |

**Done when:** no source file is over about 600 lines, and the first page loads noticeably faster on a mid-range phone.

## Phase 6: Legal, security and product

Goal: it can be released to the public, or to customers, without surprises.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| Licences | Add a LICENSE for the code, credit three.js (MIT), and check the terms of the bundled city sample and any NVIDIA or Pixar sample files | Avoids legal problems when public | S |
| Privacy statement | State plainly that files never leave the browser | A real selling point; keep the Content Security Policy | S |
| Account and repo security | Two-factor authentication with recovery codes, Dependabot, a ruleset protecting `main`, a local backup clone | Protects against losing the account or code | S |
| Hosting for a private repo | Netlify or Cloudflare Pages (config already in the repo), or GitHub's private Pages on a paid plan | Keeps the site online while the code stays private | S |
| Releases and docs | Version numbers, a changelog, a user guide, a sample gallery | Users and contributors can follow changes | M |
| Target audience | Decide: free public viewer, internal tool, or paid product | Decides whether accounts, cloud storage, sharing permissions or analytics are needed | decision |

**Done when:** the repo has a licence, the privacy statement is on the site, and hosting works with the repo in the state you want.

## Phase 7: AI assistant (live chat)

Goal: a chat panel inside the viewer where you type "hide the roof", "make the walls light grey" or "show the front view" and the viewer does it. It builds on Phase 1 (tests) and Phase 3 (undo and redo), so it comes last.

| Item | What we do | Why it matters | Effort |
| --- | --- | --- | --- |
| Action layer | Turn every viewer operation (select, isolate, hide, colour, transform, camera, measure, section, export) into a named command with typed parameters | The chat and the buttons call the same commands, so they behave the same and can be tested and undone | M |
| Chat panel | Docked panel with message history, streaming replies, a visible list of the actions taken, and a Stop button | The live feel; you always see what the assistant changed | M |
| Model connection | Send the chat and the command list to the Claude API with tool use; the model replies with commands the viewer runs. Two options: your own API key kept in the browser, or a small backend proxy that holds the key and limits use | A static GitHub Pages site cannot keep a secret key, so this choice decides cost and who can use it | M |
| Scene awareness | Send a compact summary only (object names, USD paths, materials, bounding boxes, current selection), never geometry or textures | "The left window" can be resolved to an object, and model files stay on the device | M |
| Safety | Edits are undoable, bulk or destructive changes ask for confirmation, a cap on commands per message, and the assistant can only call viewer commands | Prevents surprises from a misread request | S |
| Questions about the model | Answer "how many meshes", "which materials are used", "what is this prim" from the metadata | Useful even when nothing is changed | S |
| Evaluation set | Sample prompts with the expected commands, run in CI | Keeps behaviour stable when the model or the commands change | M |

The feature is off by default and the privacy statement must say that chat messages and the scene summary go to the model provider.

**Done when:** typing "isolate the fridge and make it red" does it in one message, Undo reverses it, and nothing leaves the browser except the chat text and the scene summary.

## Decisions and next step

Start with tests and CI, then Web Workers with progress and cancel, then glTF/GLB input and the validation report, with the UI redesign running alongside.

Decisions that change the plan:

- [ ] Who is the viewer for: free public tool, internal tool, or paid product?
- [ ] Hosting while the repo is private: Netlify or Cloudflare Pages, or make the repo public?
- [ ] Exact USD results: invest in a WebAssembly build of Pixar USD (large download, high accuracy), or keep extending the current loader?
- [ ] Which extra formats matter most: glTF/GLB first, then FBX, STL, PLY, 3MF?
- [ ] AI assistant: bring-your-own API key in the browser, or a backend proxy that holds the key?
