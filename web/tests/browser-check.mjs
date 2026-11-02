/*
 * End-to-end smoke test for the web app, driven over the Chrome DevTools
 * Protocol (no extra npm dependencies: Node's built-in WebSocket is used).
 *
 * Usage:
 *   node tests/browser-check.mjs [url] [--screenshots=dir]
 *
 * The page is expected to be served over http (ES modules do not work from
 * file://). Start one with:  python3 -m http.server 8099
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean);

const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith('--')) || 'http://localhost:8099/index.html?example=chmmr';
const screenshotArg = args.find((arg) => arg.startsWith('--screenshots='));
const screenshotDir = screenshotArg ? screenshotArg.split('=')[1] : null;

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
    results.push({ name, ok: Boolean(condition), detail });
    if (!condition) {
        failures++;
    }
    const status = condition ? 'PASS' : 'FAIL';
    console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class CDP {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    reject(new Error(`${message.error.message} (${message.error.code})`));
                } else {
                    resolve(message.result);
                }
                return;
            }
            const handlers = this.listeners.get(message.method) || [];
            for (const handler of handlers) {
                handler(message.params);
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    once(method) {
        return new Promise((resolve) => {
            const handler = (params) => {
                const list = this.listeners.get(method) || [];
                this.listeners.set(method, list.filter((entry) => entry !== handler));
                resolve(params);
            };
            const list = this.listeners.get(method) || [];
            list.push(handler);
            this.listeners.set(method, list);
        });
    }
}

async function findChrome() {
    for (const candidate of CHROME_CANDIDATES) {
        try {
            const { accessSync, constants } = await import('node:fs');
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            /* try next */
        }
    }
    throw new Error('Chrome/Chromium not found; set CHROME=/path/to/chrome');
}

async function waitForDevTools(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (response.ok) {
                const targets = await response.json();
                const page = targets.find((target) => target.type === 'page');
                if (page) {
                    return page.webSocketDebuggerUrl;
                }
            }
        } catch {
            /* not up yet */
        }
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for the Chrome DevTools endpoint');
        }
        await sleep(150);
    }
}

async function main() {
    const chromePath = await findChrome();
    const port = 9411 + Math.floor(Math.random() * 200);
    const userDataDir = mkdtempSync(join(tmpdir(), 'uqmani-chrome-'));
    if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
    }

    const chrome = spawn(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--window-size=1400,900',
        'about:blank',
    ], { stdio: 'ignore' });

    let cdp;
    try {
        const wsUrl = await waitForDevTools(port);
        const socket = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        cdp = new CDP(socket);

        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1400,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });

        const consoleErrors = [];
        const listeners = cdp.listeners;
        listeners.set('Runtime.exceptionThrown', [(params) => {
            consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
        }]);
        listeners.set('Log.entryAdded', [(params) => {
            if (params.entry.level === 'error') {
                consoleErrors.push(params.entry.text);
            }
        }]);

        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url });
        await loaded;

        const evaluate = async (expression) => {
            const response = await cdp.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });
            if (response.exceptionDetails) {
                throw new Error(response.exceptionDetails.exception?.description
                    || response.exceptionDetails.text
                    || 'evaluation failed');
            }
            return response.result.value;
        };

        const waitFor = async (expression, timeoutMs = 20000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                try {
                    if (await evaluate(expression)) {
                        return true;
                    }
                } catch {
                    /* page still booting */
                }
                if (Date.now() > deadline) {
                    return false;
                }
                await sleep(100);
            }
        };

        /* ------------------------------------------------------------ */
        /* Boot                                                          */
        /* ------------------------------------------------------------ */
        check('app object exists', await waitFor('Boolean(window.uqmaniApp)'));

        const exampleLoaded = await waitFor(
            `window.uqmaniApp.project.kind === 'example'
             && window.uqmaniApp.system.frames.length > 0
             && window.uqmaniApp.system.frames.every((frame) => frame.loaded)`,
            30000,
        );
        check('bundled example loads with all images decoded', exampleLoaded);

        const summary = await evaluate(`(() => {
            const app = window.uqmaniApp;
            return {
                frames: app.system.frames.length,
                animations: app.system.animations.length,
                listItems: document.querySelectorAll('#framesList li').length,
                workspaceImages: document.querySelectorAll('#framesLayer img.frame-img').length,
                firstFrame: app.system.frames[0].toSource(),
                firstImage: (() => { const f = app.system.frames[0]; return { w: f.width, h: f.height }; })(),
                names: app.system.animations.map((animation) => animation.name),
            };
        })()`);
        check('85 frames parsed', summary.frames === 85, `got ${summary.frames}`);
        check('8 animations parsed', summary.animations === 8, `got ${summary.animations}`);
        check('frame list rendered', summary.listItems === 85, `got ${summary.listItems}`);
        check('workspace has one image per frame', summary.workspaceImages === 85, `got ${summary.workspaceImages}`);
        check('first frame source matches file', summary.firstFrame === 'chmmr.0.png -1 10 0 0', summary.firstFrame);
        check('first image decoded', summary.firstImage.w === 243 && summary.firstImage.h === 107, JSON.stringify(summary.firstImage));
        check('animation names parsed', summary.names[0] === 'Static background' && summary.names[7] === 'Bouncy3', summary.names.join(', '));

        /* ------------------------------------------------------------ */
        /* Geometry / zoom                                               */
        /* ------------------------------------------------------------ */
        const geometry = await evaluate(`(() => {
            const app = window.uqmaniApp;
            const frame = app.system.frames[1];
            const element = app.frameElements.get(frame);
            const style = element.style;
            return {
                left: style.left, top: style.top, width: style.width, height: style.height,
                zoom: app.zoom,
                xoff: frame.xoff, yoff: frame.yoff,
            };
        })()`);
        check('frame offsets are applied at the current zoom',
            geometry.left === `${-geometry.xoff * geometry.zoom}px` && geometry.top === `${-geometry.yoff * geometry.zoom}px`,
            JSON.stringify(geometry));

        await evaluate('window.uqmaniApp.setZoom(5)');
        const zoomed = await evaluate(`(() => {
            const app = window.uqmaniApp;
            const frame = app.system.frames[0];
            const element = app.frameElements.get(frame);
            return { zoom: app.zoom, width: element.style.width, height: element.style.height, label: document.getElementById('zoomLabel').textContent };
        })()`);
        check('zooming rescales images',
            zoomed.zoom === 5 && zoomed.width === '1215px' && zoomed.height === '535px',
            JSON.stringify(zoomed));
        await evaluate('window.uqmaniApp.setZoom(3)');

        /* ------------------------------------------------------------ */
        /* Selection and z-order                                         */
        /* ------------------------------------------------------------ */
        const selection = await evaluate(`(() => {
            const list = document.getElementById('framesList');
            list.children[4].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const app = window.uqmaniApp;
            const selected = app.getSelectedFrame();
            const element = app.frameElements.get(selected);
            const zIndexes = app.system.frames.map((frame) => Number(app.frameElements.get(frame).style.zIndex || 0));
            return {
                selectedSource: selected.toSource(),
                listSelected: document.querySelectorAll('#framesList li.selected').length,
                topZ: Number(element.style.zIndex),
                maxZ: Math.max(...zIndexes),
                onlySelected: app.showOnlySelected,
            };
        })()`);
        check('clicking a list item selects exactly one frame',
            selection.listSelected === 1 && selection.selectedSource === 'chmmr.4.png -1 10 -77 -54',
            JSON.stringify(selection));
        check('selected frame is brought to the front', selection.topZ === selection.maxZ, JSON.stringify(selection));

        const onlySelected = await evaluate(`(() => {
            const app = window.uqmaniApp;
            app.showOnlySelected = true;
            app.applyFrameViewStates();
            const visible = app.system.frames.filter((frame) => frame.visible).length;
            app.showOnlySelected = false;
            app.applyFrameViewStates();
            const allVisible = app.system.frames.filter((frame) => frame.visible).length;
            return { visible, allVisible };
        })()`);
        check('"show only selected frame" hides the other frames',
            onlySelected.visible === 1 && onlySelected.allVisible === 85,
            JSON.stringify(onlySelected));

        /* ------------------------------------------------------------ */
        /* Animation definition panel                                    */
        /* ------------------------------------------------------------ */
        const table = await evaluate(`(() => {
            const app = window.uqmaniApp;
            app.selectedAnimation = 7;
            app.renderAnimationPanel();
            const rows = document.querySelectorAll('#animFramesBody tr').length;
            const firstDuration = document.querySelector('#animFramesBody input.duration-input')?.value;
            const type = document.getElementById('animTypeSelect').value;
            return { rows, firstDuration, type, selected: app.currentAnimation().name };
        })()`);
        check('animation frame table shows the selected animation',
            table.rows === 23 && table.type === 'CIRCULAR' && table.selected === 'Bouncy3',
            JSON.stringify(table));

        const editDuration = await evaluate(`(() => {
            const app = window.uqmaniApp;
            const input = document.querySelector('#animFramesBody input.duration-input');
            input.value = '0.42';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { duration: app.currentAnimation().frames[0].duration, dirty: app.dirty };
        })()`);
        check('editing a duration updates the model and marks the project dirty',
            editDuration.duration === 0.42 && editDuration.dirty === true,
            JSON.stringify(editDuration));

        const importFrames = await evaluate(`(() => {
            const app = window.uqmaniApp;
            app.selectedAnimation = 7;
            app.selected = new Set([10, 11]);
            app.importSelectedFrames();
            const animation = app.currentAnimation();
            return { count: animation.frames.length, last: animation.frames[animation.frames.length - 1].frame.filename };
        })()`);
        check('importing selected frames appends them to the animation',
            importFrames.count === 25 && importFrames.last === 'chmmr.11.png',
            JSON.stringify(importFrames));

        /* ------------------------------------------------------------ */
        /* Playback                                                      */
        /* ------------------------------------------------------------ */
        const playback = await evaluate(`(async () => {
            const app = window.uqmaniApp;
            app.selectedAnimation = 7;
            app.selectedAnimRows.clear();
            app.renderAnimationPanel();
            const animation = app.currentAnimation();
            const before = animation.currentlyPlaying;
            app.playSelectedOnce();
            const modeAfterStart = app.animationMode;
            await new Promise((resolve) => setTimeout(resolve, 900));
            const advanced = animation.currentlyPlaying !== before;
            const mode = document.getElementById('statusMode').textContent;
            app.stopAnimationSystem();
            return {
                modeAfterStart, advanced, mode,
                stopped: app.animationMode,
                modeAfterStop: document.getElementById('statusMode').textContent,
                visibleWhilePlaying: app.system.frames.filter((frame) => frame.visible).length,
            };
        })()`);
        check('animation system runs and advances frames',
            playback.modeAfterStart === true && playback.advanced === true && playback.mode === 'Animation mode',
            JSON.stringify(playback));
        check('stopping the animation system returns to layout mode',
            playback.stopped === false && playback.modeAfterStop === 'Layout mode',
            JSON.stringify(playback));

        /* ------------------------------------------------------------ */
        /* Keyboard editing                                              */
        /* ------------------------------------------------------------ */
        const keyboard = await evaluate(`(() => {
            const app = window.uqmaniApp;
            app.selected = new Set([2]);
            const frame = app.getSelectedFrame();
            const start = { x: frame.xoff, y: frame.yoff };
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            const moved = { x: frame.xoff, y: frame.yoff };
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
            const restored = { x: frame.xoff, y: frame.yoff };
            return { start, moved, restored };
        })()`);
        check('W/A/S/D move the selected frame and restore it',
            keyboard.moved.y === keyboard.start.y + 1
            && keyboard.moved.x === keyboard.start.x + 1
            && keyboard.restored.x === keyboard.start.x
            && keyboard.restored.y === keyboard.start.y,
            JSON.stringify(keyboard));

        /* ------------------------------------------------------------ */
        /* Serialisation + zip round trip                                */
        /* ------------------------------------------------------------ */
        const serialized = await evaluate(`(async () => {
            const { serializeAni } = await import(new URL('js/writer.js', document.baseURI).href);
            const app = window.uqmaniApp;
            const text = serializeAni(app.system);
            const lines = text.trimEnd().split('\\n');
            return {
                frameLines: lines.filter((line) => !line.startsWith('#')).length,
                anidefLines: lines.filter((line) => line.startsWith('#@ anidef')).length,
                aniframeLines: lines.filter((line) => line.startsWith('#@ aniframe')).length,
                startsWithFrame: lines[0].startsWith('chmmr.0.png'),
            };
        })()`);
        check('serialisation writes frames, then anidef, then aniframe lines',
            serialized.frameLines === 85 && serialized.anidefLines === 8 && serialized.startsWithFrame,
            JSON.stringify(serialized));

        const zip = await evaluate(`(async () => {
            const { serializeAni } = await import(new URL('js/writer.js', document.baseURI).href);
            const fileHelpers = await import(new URL('js/files.js', document.baseURI).href);
            const app = window.uqmaniApp;
            const blob = await fileHelpers.createZip(app.system, serializeAni(app.system), 'chmmr.ani');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const entries = Object.keys(window.fflate.unzipSync(bytes));
            const file = new File([blob], 'project.zip', { type: 'application/zip' });
            await app.openZipFile(file);
            return {
                zipSize: bytes.length,
                entries: entries.length,
                hasAni: entries.includes('chmmr.ani'),
                hasImage: entries.includes('chmmr.0.png'),
                projectKind: app.project.kind,
                frames: app.system.frames.length,
                imagesLoaded: app.system.frames.filter((frame) => frame.loaded).length,
            };
        })()`);
        check('project can be downloaded as a zip with all images',
            zip.hasAni && zip.hasImage && zip.entries === 86 && zip.zipSize > 10000,
            JSON.stringify({ entries: zip.entries, size: zip.zipSize }));
        check('a zip project can be opened again (frames + images)',
            zip.projectKind === 'zip' && zip.frames === 85 && zip.imagesLoaded === 85,
            JSON.stringify(zip));

        /* ------------------------------------------------------------ */
        /* Theme                                                         */
        /* ------------------------------------------------------------ */
        const theme = await evaluate(`(() => {
            const app = window.uqmaniApp;
            app.setTheme('light');
            const light = getComputedStyle(document.body).backgroundColor;
            app.setTheme('dark');
            const dark = getComputedStyle(document.body).backgroundColor;
            const stored = JSON.parse(localStorage.getItem('uqmanimationtool.settings.v1') || '{}').theme;
            return { light, dark, stored, attr: document.documentElement.dataset.theme };
        })()`);
        check('dark mode changes the theme and persists it',
            theme.light === 'rgb(240, 240, 240)' && theme.dark === 'rgb(30, 32, 35)' && theme.stored === 'dark',
            JSON.stringify(theme));

        /* ------------------------------------------------------------ */
        /* Empty project + programmatic file sources                      */
        /* ------------------------------------------------------------ */
        const emptyProject = await evaluate(`(async () => {
            const app = window.uqmaniApp;
            await app.newProject();
            return {
                kind: app.project.kind,
                frames: app.system.frames.length,
                hasProjectClass: document.getElementById('workspace').classList.contains('has-project'),
                emptyVisible: getComputedStyle(document.getElementById('workspaceEmpty')).display !== 'none',
                hotspotHidden: document.getElementById('framesLayer').querySelector('.hotspot').style.display === 'none',
                status: document.getElementById('statusFile').textContent,
            };
        })()`);
        check('new empty project shows the empty workspace state',
            emptyProject.kind === 'memory'
            && emptyProject.frames === 0
            && emptyProject.hasProjectClass === false
            && emptyProject.emptyVisible === true
            && emptyProject.hotspotHidden === true,
            JSON.stringify(emptyProject));

        const synthetic = await evaluate(`(async () => {
            const app = window.uqmaniApp;
            const makePng = (width, height, color) => new Promise((resolve) => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, width, height);
                canvas.toBlob(resolve, 'image/png');
            });
            const a = await makePng(20, 10, '#ff0000');
            const b = await makePng(30, 40, '#00ff00');
            const images = new Map([
                ['a.png', { path: 'a.png', getBlob: async () => a }],
                ['b.png', { path: 'b.png', getBlob: async () => b }],
            ]);
            const aniText = 'a.png -1 10 0 0\\nb.png -1 10 5 6\\n#@ anidef 0 CIRCULAR [Test]\\n#@ aniframe 0 0.2 [a.png -1 10 0 0]\\n';
            await app.openProject({ kind: 'files', aniText, aniFileName: 'test.ani', images, label: 'test.ani' });
            return {
                frames: app.system.frames.length,
                animations: app.system.animations.length,
                animationFrames: app.system.animations[0].frames.length,
                centered: app.centerOffset.x > 0 && app.centerOffset.y > 0,
                listText: document.querySelector('#framesList li').textContent,
                imageWidth: app.system.frames[0].width,
                status: document.getElementById('statusFile').textContent,
            };
        })()`);
        check('a synthetic project loads, renders and gets centred',
            synthetic.frames === 2
            && synthetic.animations === 1
            && synthetic.animationFrames === 1
            && synthetic.centered === true
            && synthetic.imageWidth === 20
            && synthetic.listText === ' a.png -1 10 0 0'
            && synthetic.status === 'Loaded: test.ani',
            JSON.stringify(synthetic));

        /* ------------------------------------------------------------ */
        /* Screenshots                                                   */
        /* ------------------------------------------------------------ */
        if (screenshotDir) {
            const capture = async (name) => {
                const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join(screenshotDir, name), Buffer.from(data, 'base64'));
            };

            await evaluate(`(async () => {
                const app = window.uqmaniApp;
                await app.openExample('chmmr');
                app.setTheme('light');
                app.selected = new Set([24]);
                app.updateSelection();
                app.selectedAnimation = 7;
                app.renderAnimationPanel();
                return true;
            })()`);
            await sleep(500);
            await capture('app-light.png');

            await evaluate('window.uqmaniApp.setTheme("dark")');
            await sleep(300);
            await capture('app-dark.png');

            await evaluate(`(() => {
                const app = window.uqmaniApp;
                app.playSelectedOnce();
                return true;
            })()`);
            await sleep(400);
            await capture('app-dark-playing.png');
            await evaluate('window.uqmaniApp.stopAnimationSystem()');
            await evaluate('window.uqmaniApp.setTheme("light")');

            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 430,
                height: 860,
                deviceScaleFactor: 1,
                mobile: true,
            });
            await sleep(400);
            await capture('app-mobile.png');
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 1400,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
            });

            await evaluate(`(async () => {
                const app = window.uqmaniApp;
                await app.newProject();
                app.setTheme('light');
                return true;
            })()`);
            await sleep(400);
            await capture('app-empty.png');
        }

        check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

        console.log(`\n${results.filter((result) => result.ok).length}/${results.length} checks passed`);
    } finally {
        try {
            if (cdp) {
                await cdp.send('Browser.close').catch(() => {});
            }
        } catch {
            /* ignore */
        }
        chrome.kill('SIGKILL');
        await sleep(300);
        try {
            rmSync(userDataDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }

    if (failures > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
