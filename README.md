# UQMAnimationTool

UQMAnimationTool adds some extra features to regular UQM `.ani` files via an
"extension" stored in `#@` comment lines. See
[README_EXTENSIONSPECS.txt](README_EXTENSIONSPECS.txt) for the file format.

There are two versions in this repository:

- **`web/`** — the HTML5 / JavaScript port (runs in the browser, deployed to
  GitHub Pages). This is the recommended version.
- **`src/`** — the original Java/Swing application (NetBeans project, Maven
  build).

## Web version (HTML5)

Live: **https://jorisvddonk.github.io/uqmanimationtool/**

Open `index.html?example=chmmr` to start with the bundled example project;
add `&theme=dark` (or `&theme=light`) to force a colour scheme.

### Features

- Load a whole folder (`.ani` + images), a set of loose files, or a `.zip`
  archive. Drag & drop works too.
- Save the edited `.ani` straight back to disk with the File System Access API
  (Chrome/Edge). Other browsers get a normal file download instead.
- Download the project as a `.zip` (the `.ani` plus every referenced image) or
  export a SMIL file.
- Frame list, image workspace with zoom, hotspot, transparency helpers,
  "show only selected frame" and "highlight selected frame".
- Animation definition editor: add/remove/rename animations, change the
  animation type, edit frame durations, reorder/import/remove frames.
- Playback system: start/stop the animation system and play individual
  animations (CIRCULAR, RANDOM, TALK, YO_YO, BACKGROUND).
- Keyboard shortcuts: `W/A/S/D` (+ Shift for all frames, `Q/Z` for AZERTY),
  arrow keys, `Space` (play once), `P` (loop), `+`/`-` (zoom),
  `Ctrl+O` / `Ctrl+S` / `F6`.
- Light and dark mode (follows `prefers-color-scheme`, toggle in the title bar
  or the Display menu).

### Running locally

ES modules need an HTTP server (they do not work from `file://`):

```bash
cd web
python3 -m http.server 8080
# then open http://localhost:8080/
```

### Tests

```bash
cd web
npm test                                   # parser/writer unit tests (node)
python3 -m http.server 8099 &              # needed for the browser test
node tests/browser-check.mjs "http://localhost:8099/index.html?example=chmmr"
```

The browser check drives a headless Chrome over the DevTools Protocol and
verifies loading, rendering, selection, editing, playback, zip round-trips and
theming. It also writes screenshots when given `--screenshots=<dir>`.

### Deployment

`.github/workflows/pages.yml` runs the unit tests and publishes the contents of
`web/` to GitHub Pages on every push to `main`. In the repository settings,
set *Pages → Build and deployment → Source* to **GitHub Actions**.

## Java version

UQMAnimationTool is written in Java using Swing, and is developed with NetBeans 7.01
The GUI is developed mainly using NetBeans' Matisse swing GUI editor. All .form files
are files saved by this editor, NetBeans will autogenerate Java code based on these
files. For this reason, I advise you to use NetBeans, rather than some other IDE like
Eclipse.

Settings are saved in  ~/.uqmtools/uqmanimationtool.properties
 (%UserProfile%/.uqmtools/uqmanimationtool.properties on Windows)
