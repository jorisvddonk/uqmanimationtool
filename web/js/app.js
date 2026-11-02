/*
 * UQMAnimationTool — HTML5 port of the Swing application.
 *
 * The structure mirrors MainFrame.java: a frame list, an image workspace with
 * a hotspot, an animation definition panel and a playback panel. File access
 * goes through the File System Access API when available, with drag & drop,
 * <input type=file> and .zip support as fallbacks.
 */

import {
    ANIMATION_TYPES,
    Animation,
    AnimationSystem,
    AnimationType,
    Frame,
    TYPE_DESCRIPTIONS,
} from './model.js';
import { parseAni } from './parser.js';
import { generateSmil, serializeAni } from './writer.js';
import { generateTzoProgram, TZO_DEFAULT_FPS } from './tzo.js';
import * as files from './files.js';
import {
    chooseDialog,
    colorDialog,
    confirmDialog,
    formDialog,
    isDialogOpen,
    promptDialog,
    showTextDialog,
    toast,
} from './dialogs.js';

const SETTINGS_KEY = 'uqmanimationtool.settings.v1';

const HELP_TEXT = `UQMAnimationTool — HTML5 port
================================

Keyboard commands - Playback:
UP/DOWN arrows: select the next/previous frame in the list
SPACE: play the selected animation once
P: play/stop the selected animation repeatedly
+/-: zoom in/out

Keyboard commands - Editing:
W: Move the selected frame one pixel up
A: Move the selected frame one pixel left
S: Move the selected frame one pixel down
D: Move the selected frame one pixel right
SHIFT+W/A/S/D: Same as W/A/S/D, except it moves *all* frames one pixel.
Q/Z: AZERTY equivalents of A/W.

HELP:
- Everything should be pretty self-explanatory. Load a project, click an item
  in the list to bring it to the front of all images displayed.
- NOTE THAT everything is ALWAYS displayed and I am only messing with the Z
  order, UNLESS the "only show selected image" box is checked. If an animation
  works in UQMAnimationTool, this does not guarantee that it also works in UQM
  itself (code, etc). Alignment should mostly work allright though.
- The Hotspot color does not have an Alpha value.

Tools:
- "Export SMIL file" writes a SMIL 3.0 slideshow of the animations.
- "Export TZO animation (.json)" writes a TZO program for tzo-c's anim.c: the
  program loads every frame with loadImage(hotspotY, hotspotX, path) and plays
  the animations through the anim_anim_<i>_index / _active / _yy_direction /
  _tick context keys, drawing with beginDraw/drawFrame/endDraw. Frame durations
  are converted to host iterations using the configured frames-per-second
  (anim.c runs the VM ~30 times per second).

Files:
- "Open folder" reads the .ani file plus all images in that folder and saves
  straight back to disk (File System Access API, Chrome/Edge).
- "Open .ani file" lets you pick the .ani file together with its images.
- "Open .zip" reads an archive with the .ani file and images.
- In browsers without the File System Access API, Save downloads the file.
- "Download project as .zip" bundles the .ani file and every image.

This is a port of the Java/Swing UQMAnimationTool by Joris van de Donk.`;

const TYPES_HELP = `Animation types:
----------------
BACKGROUND: Background frames. These should *always* be visible in the background.
CIRCULAR: Circular animation. Shows all frames in order, then restarts from the top again.
RANDOM: Random animation. Frames are shown in a random order. Because SMIL does not appear to support randomness, the SMIL generator generates a random order.
TALK: Talk animation. These should be shown whenever the character is talking. Currently the exact same as CIRCULAR.
YO_YO: Yo-yo animation. Shows all frames in order, then shows them again in backwards order.

Note: animation definitions and frame assignments are stored inside the .ani
file as "#@" comment lines, which UQM itself ignores completely.`;

const PLAYBACK_HELP = `To use the animation system's playback feature, it first needs to be enabled
by hitting the "Start/stop ani system" button.

Once the playback system is running (the status bar should display
"Animation mode"), you can start or stop individual animations by clicking the
playback buttons in the table.

Note that even background 'animations' have to be started, or else they won't
be visible.`;

const DEFAULT_ANIMATION_NAME = 'Unnamed animation';

class App {
    constructor() {
        this.appEl = document.getElementById('app');
        this.workspaceEl = document.getElementById('workspace');
        this.framesLayer = document.getElementById('framesLayer');
        this.framesListEl = document.getElementById('framesList');
        this.frameCountEl = document.getElementById('frameCount');
        this.statusFileEl = document.getElementById('statusFile');
        this.statusMouseEl = document.getElementById('statusMouse');
        this.statusModeEl = document.getElementById('statusMode');
        this.toolbarHintEl = document.getElementById('toolbarHint');
        this.zoomSlider = document.getElementById('zoomSlider');
        this.zoomLabel = document.getElementById('zoomLabel');
        this.transparencySelect = document.getElementById('transparencySelect');
        this.animSelect = document.getElementById('animSelect');
        this.animTypeSelect = document.getElementById('animTypeSelect');
        this.animFramesBody = document.getElementById('animFramesBody');
        this.colDuration = document.getElementById('colDuration');
        this.playbackBody = document.getElementById('playbackBody');
        this.animSystemButton = document.getElementById('btnAnimSystem');
        this.animSystemIcon = document.getElementById('animSystemIcon');
        this.animSystemLabel = document.getElementById('animSystemLabel');
        this.dropOverlay = document.getElementById('dropOverlay');
        this.menubar = document.getElementById('menubar');
        this.themeToggle = document.getElementById('themeToggle');
        this.themeToggleLabel = document.getElementById('themeToggleLabel');
        this.splitterLeft = document.getElementById('splitterLeft');
        this.splitterRight = document.getElementById('splitterRight');
        this.paneLeft = this.appEl.querySelector('.pane-left');
        this.paneRight = this.appEl.querySelector('.pane-right');

        this.system = new AnimationSystem();
        this.project = this.emptyProject();
        this.selected = new Set();
        this.anchorIndex = -1;
        this.selectedAnimRows = new Set();
        this.selectedAnimation = 0;

        this.zoom = 3;
        this.transparencyMode = 0;
        this.showOnlySelected = false;
        this.showHotspot = true;
        this.highlightSelected = false;
        this.hotspotColor = '#ff0000';

        this.centerOffset = { x: 0, y: 0 };
        this.zOrder = [];
        this.frameElements = new Map();
        this.animationMode = false;
        this.oneShotPending = false;
        this.rafId = null;
        this.playbackSignature = '';
        this.dirty = false;
        this.loadingCount = 0;

        this.hotspotEl = document.createElement('div');
        this.hotspotEl.className = 'hotspot';
        this.hotspotEl.title = 'Hotspot (0,0)';
        this.framesLayer.appendChild(this.hotspotEl);

        this.settings = this.loadSettings();
        this.applySettings();
        this.initMenus();
        this.initTabs();
        this.initButtons();
        this.initSplitters();
        this.initWorkspace();
        this.initKeyboard();
        this.initDragAndDrop();
        this.initWindow();

        this.renderAll();
        this.updateStatus();

        // Optional query parameters: ?example=chmmr and ?theme=dark|light
        const params = new URLSearchParams(window.location.search);
        const theme = params.get('theme');
        if (theme === 'light' || theme === 'dark') {
            this.setTheme(theme, { persist: false });
        }
        const example = params.get('example');
        if (example) {
            this.openExample(example);
        }
    }

    /* ------------------------------------------------------------------ */
    /* State helpers                                                       */
    /* ------------------------------------------------------------------ */

    emptyProject() {
        return {
            kind: 'none',
            aniFileName: '',
            aniText: '',
            aniFileHandle: null,
            dirHandle: null,
            images: new Map(),
            zipBytes: null,
            label: '',
        };
    }

    currentAnimation() {
        return this.system.animations[this.selectedAnimation] || null;
    }

    getSelectedFrame() {
        if (this.selected.size === 0) {
            return null;
        }
        const index = Math.min(...this.selected);
        return this.system.frames[index] || null;
    }

    getSelectedFrameIndices() {
        return [...this.selected].sort((a, b) => a - b);
    }

    markDirty() {
        this.dirty = true;
        this.updateStatus();
        this.renderFrameList();
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                           */
    /* ------------------------------------------------------------------ */

    loadSettings() {
        const defaults = {
            zoom: 3,
            transparencyMode: 0,
            showOnlySelected: false,
            showHotspot: true,
            highlightSelected: false,
            hotspotColor: '#ff0000',
            theme: null,
            tzo: null,
        };
        try {
            const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return { ...defaults, ...stored };
        } catch {
            return defaults;
        }
    }

    saveSettings() {
        this.settings = {
            zoom: this.zoom,
            transparencyMode: this.transparencyMode,
            showOnlySelected: this.showOnlySelected,
            showHotspot: this.showHotspot,
            highlightSelected: this.highlightSelected,
            hotspotColor: this.hotspotColor,
            theme: document.documentElement.dataset.theme,
        };
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
        } catch {
            /* storage might be unavailable (private mode); ignore */
        }
    }

    applySettings() {
        const stored = this.settings;
        this.zoom = clamp(Number(stored.zoom) || 3, 1, 10);
        this.transparencyMode = clamp(Number(stored.transparencyMode) || 0, 0, 3);
        this.showOnlySelected = Boolean(stored.showOnlySelected);
        this.showHotspot = stored.showHotspot !== false;
        this.highlightSelected = Boolean(stored.highlightSelected);
        this.hotspotColor = stored.hotspotColor || '#ff0000';

        this.zoomSlider.value = String(this.zoom);
        this.zoomLabel.textContent = `Zoom: ${this.zoom}`;
        this.transparencySelect.value = String(this.transparencyMode);
        this.hotspotEl.style.background = this.hotspotColor;

        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.setTheme(stored.theme || (prefersDark ? 'dark' : 'light'), { persist: false });
    }

    setTheme(theme, { persist = true } = {}) {
        document.documentElement.dataset.theme = theme;
        this.themeToggleLabel.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
        this.themeToggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        if (persist) {
            this.saveSettings();
        }
        this.syncMenuChecks();
    }

    toggleTheme() {
        this.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    }

    /* ------------------------------------------------------------------ */
    /* UI wiring                                                          */
    /* ------------------------------------------------------------------ */

    initMenus() {
        for (const menu of this.menubar.querySelectorAll('.menu')) {
            const button = menu.querySelector('.menu-button');
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const wasOpen = menu.classList.contains('open');
                this.closeMenus();
                if (!wasOpen) {
                    menu.classList.add('open');
                }
            });
            menu.querySelector('.menu-popup').addEventListener('click', () => this.closeMenus());
        }
        document.addEventListener('click', () => this.closeMenus());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeMenus();
            }
        });
    }

    closeMenus() {
        for (const menu of this.menubar.querySelectorAll('.menu.open')) {
            menu.classList.remove('open');
        }
    }

    initTabs() {
        for (const tab of document.querySelectorAll('[data-side-tab]')) {
            tab.addEventListener('click', () => {
                const name = tab.dataset.sideTab;
                for (const other of document.querySelectorAll('[data-side-tab]')) {
                    const active = other === tab;
                    other.classList.toggle('active', active);
                    other.setAttribute('aria-selected', String(active));
                }
                for (const panel of document.querySelectorAll('[data-side-panel]')) {
                    panel.classList.toggle('active', panel.dataset.sidePanel === name);
                }
            });
        }
        for (const tab of document.querySelectorAll('[data-main-tab]')) {
            tab.addEventListener('click', () => {
                const name = tab.dataset.mainTab;
                for (const other of document.querySelectorAll('[data-main-tab]')) {
                    const active = other === tab;
                    other.classList.toggle('active', active);
                    other.setAttribute('aria-selected', String(active));
                }
                for (const panel of document.querySelectorAll('[data-main-panel]')) {
                    panel.classList.toggle('active', panel.dataset.mainPanel === name);
                }
            });
        }
    }

    initButtons() {
        for (const element of document.querySelectorAll('[data-action]')) {
            element.addEventListener('click', (event) => {
                event.preventDefault();
                this.handleAction(element.dataset.action);
            });
        }

        this.themeToggle.addEventListener('click', () => this.toggleTheme());

        this.framesListEl.addEventListener('click', (event) => this.onFrameListClick(event));
        this.framesListEl.addEventListener('keydown', (event) => this.onFrameListKeyDown(event));

        this.zoomSlider.addEventListener('input', () => this.setZoom(Number(this.zoomSlider.value)));
        this.transparencySelect.addEventListener('change', () => {
            this.transparencyMode = Number(this.transparencySelect.value) || 0;
            this.saveSettings();
            this.applyFrameViewStates();
        });

        this.animSelect.addEventListener('change', () => {
            this.selectedAnimation = Number(this.animSelect.value) || 0;
            this.selectedAnimRows.clear();
            this.renderAnimationPanel();
        });

        this.animTypeSelect.addEventListener('change', () => {
            const animation = this.currentAnimation();
            if (!animation) {
                return;
            }
            animation.aniType = this.animTypeSelect.value;
            this.markDirty();
            this.renderAnimationPanel();
            this.renderPlayback();
            this.applyFrameViewStates();
        });

        document.getElementById('btnAnimAdd').addEventListener('click', () => this.addAnimation());
        document.getElementById('btnAnimRemove').addEventListener('click', () => this.removeAnimation());
        document.getElementById('btnAnimRename').addEventListener('click', () => this.renameAnimation());
        document.getElementById('btnAnimTypeHelp').addEventListener('click', () => {
            showTextDialog({ title: 'Animation types HELP', text: TYPES_HELP, wrap: true });
        });
        document.getElementById('btnMoveUp').addEventListener('click', () => this.moveAnimationFrame(-1));
        document.getElementById('btnMoveDown').addEventListener('click', () => this.moveAnimationFrame(1));
        document.getElementById('btnImportFrames').addEventListener('click', () => this.importSelectedFrames());
        document.getElementById('btnRemoveFrames').addEventListener('click', () => this.removeAnimationFrames());
        document.getElementById('btnSetDuration').addEventListener('click', () => this.setDurationForSelected());
        document.getElementById('btnPlaybackHelp').addEventListener('click', () => {
            showTextDialog({ title: 'Animation system playback notes', text: PLAYBACK_HELP, wrap: true });
        });
        this.animSystemButton.addEventListener('click', () => {
            if (this.animationMode) {
                this.stopAnimationSystem();
            } else {
                this.startAnimationSystem();
            }
        });
    }

    initSplitters() {
        const setup = (element, side) => {
            element.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                element.setPointerCapture(event.pointerId);
                element.classList.add('dragging');
                const startX = event.clientX;
                const startWidth = side === 'left'
                    ? this.paneLeft.getBoundingClientRect().width
                    : this.paneRight.getBoundingClientRect().width;

                const onMove = (moveEvent) => {
                    const delta = moveEvent.clientX - startX;
                    const width = side === 'left' ? startWidth + delta : startWidth - delta;
                    const clamped = clamp(width, side === 'left' ? 150 : 190, side === 'left' ? 620 : 720);
                    this.appEl.style.setProperty(side === 'left' ? '--left-width' : '--right-width', `${Math.round(clamped)}px`);
                };
                const onUp = () => {
                    element.classList.remove('dragging');
                    element.removeEventListener('pointermove', onMove);
                    element.removeEventListener('pointerup', onUp);
                    element.removeEventListener('pointercancel', onUp);
                };
                element.addEventListener('pointermove', onMove);
                element.addEventListener('pointerup', onUp);
                element.addEventListener('pointercancel', onUp);
            });
        };
        setup(this.splitterLeft, 'left');
        setup(this.splitterRight, 'right');
    }

    initWorkspace() {
        let dragging = false;
        let lastX = 0;
        let lastY = 0;

        this.workspaceEl.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.target.closest('button')) {
                return;
            }
            dragging = true;
            lastX = event.clientX;
            lastY = event.clientY;
            this.workspaceEl.classList.add('dragging');
            this.workspaceEl.setPointerCapture(event.pointerId);
            this.workspaceEl.focus();
        });

        this.workspaceEl.addEventListener('pointermove', (event) => {
            if (dragging) {
                const dx = event.clientX - lastX;
                const dy = event.clientY - lastY;
                lastX = event.clientX;
                lastY = event.clientY;
                this.centerOffset.x += dx;
                this.centerOffset.y += dy;
                this.layoutFrames();
            }
            this.updateMousePosition(event);
        });

        const stop = () => {
            dragging = false;
            this.workspaceEl.classList.remove('dragging');
        };
        this.workspaceEl.addEventListener('pointerup', stop);
        this.workspaceEl.addEventListener('pointercancel', stop);
        this.workspaceEl.addEventListener('pointerleave', () => {
            if (!dragging) {
                this.statusMouseEl.textContent = 'Mouse: [x,y]';
            }
        });

        this.workspaceEl.addEventListener('wheel', (event) => {
            if (!event.ctrlKey && !event.metaKey) {
                return;
            }
            event.preventDefault();
            this.setZoom(this.zoom + (event.deltaY < 0 ? 1 : -1));
        }, { passive: false });
    }

    initKeyboard() {
        document.addEventListener('keydown', (event) => {
            if (isDialogOpen()) {
                return;
            }
            const tag = event.target && event.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                return;
            }

            const key = event.key;
            const ctrl = event.ctrlKey || event.metaKey;

            if (ctrl && key.toLowerCase() === 's') {
                event.preventDefault();
                this.save(false);
                return;
            }
            if (ctrl && key.toLowerCase() === 'o') {
                event.preventDefault();
                if (event.shiftKey) {
                    this.reload();
                } else {
                    this.openFolder();
                }
                return;
            }
            if (key === 'F6') {
                event.preventDefault();
                this.save(true);
                return;
            }

            if (ctrl) {
                return;
            }

            switch (key) {
                case 'ArrowUp':
                    event.preventDefault();
                    this.selectPrevious();
                    break;
                case 'ArrowDown':
                    event.preventDefault();
                    this.selectNext();
                    break;
                case 'w':
                case 'W':
                case 'z':
                case 'Z':
                    event.preventDefault();
                    this.translateSelected(0, 1, event.shiftKey);
                    break;
                case 'a':
                case 'A':
                case 'q':
                case 'Q':
                    event.preventDefault();
                    this.translateSelected(1, 0, event.shiftKey);
                    break;
                case 's':
                case 'S':
                    event.preventDefault();
                    this.translateSelected(0, -1, event.shiftKey);
                    break;
                case 'd':
                case 'D':
                    event.preventDefault();
                    this.translateSelected(-1, 0, event.shiftKey);
                    break;
                case ' ':
                    event.preventDefault();
                    this.playSelectedOnce();
                    break;
                case 'p':
                case 'P':
                    event.preventDefault();
                    this.toggleSelectedPlayback();
                    break;
                case '+':
                case '=':
                    event.preventDefault();
                    this.setZoom(this.zoom + 1);
                    break;
                case '-':
                case '_':
                    event.preventDefault();
                    this.setZoom(this.zoom - 1);
                    break;
                case 'Delete':
                    break;
                default:
                    break;
            }
        });
    }

    initDragAndDrop() {
        let depth = 0;
        const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');

        window.addEventListener('dragenter', (event) => {
            if (!hasFiles(event)) {
                return;
            }
            event.preventDefault();
            depth++;
            this.dropOverlay.classList.add('visible');
        });
        window.addEventListener('dragover', (event) => {
            if (!hasFiles(event)) {
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        window.addEventListener('dragleave', (event) => {
            if (!hasFiles(event)) {
                return;
            }
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
                this.dropOverlay.classList.remove('visible');
            }
        });
        window.addEventListener('drop', async (event) => {
            if (!hasFiles(event)) {
                return;
            }
            event.preventDefault();
            depth = 0;
            this.dropOverlay.classList.remove('visible');
            await this.handleDrop(event.dataTransfer);
        });
    }

    initWindow() {
        window.addEventListener('beforeunload', (event) => {
            if (this.dirty) {
                event.preventDefault();
                event.returnValue = '';
            }
        });
        window.addEventListener('resize', () => this.layoutFrames());
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                            */
    /* ------------------------------------------------------------------ */

    async handleAction(action) {
        switch (action) {
            case 'open-folder':
                await this.openFolder();
                break;
            case 'open-file':
                await this.openAniFile();
                break;
            case 'open-zip':
                await this.openZipDialog();
                break;
            case 'open-example':
                await this.openExample();
                break;
            case 'reload':
                await this.reload();
                break;
            case 'add-images':
                await this.addImages();
                break;
            case 'new-project':
                await this.newProject();
                break;
            case 'save':
                await this.save(false);
                break;
            case 'save-as':
                await this.save(true);
                break;
            case 'download-ani':
                this.downloadAni();
                break;
            case 'download-zip':
                await this.downloadZip();
                break;
            case 'export-smil':
                await this.exportSmil();
                break;
            case 'export-tzo':
                await this.exportTzo();
                break;
            case 'toggle-only-selected':
                this.showOnlySelected = !this.showOnlySelected;
                this.saveSettings();
                this.syncMenuChecks();
                this.applyFrameViewStates();
                break;
            case 'toggle-hotspot':
                this.showHotspot = !this.showHotspot;
                this.saveSettings();
                this.syncMenuChecks();
                this.applyFrameViewStates();
                break;
            case 'toggle-highlight':
                this.highlightSelected = !this.highlightSelected;
                this.saveSettings();
                this.syncMenuChecks();
                this.applyFrameViewStates();
                break;
            case 'toggle-theme':
                this.toggleTheme();
                break;
            case 'center-view':
                this.centerView();
                break;
            case 'zoom-in':
                this.setZoom(this.zoom + 1);
                break;
            case 'zoom-out':
                this.setZoom(this.zoom - 1);
                break;
            case 'hotspot-color':
                await this.pickHotspotColor();
                break;
            case 'set-xy':
                await this.setXYForSelected();
                break;
            case 'help':
                showTextDialog({ title: 'Help and Notes', text: HELP_TEXT, wrap: true });
                break;
            case 'extension-specs':
                await this.showDoc('docs/extension-specs.txt', '.ani extension specifications');
                break;
            case 'license':
                await this.showDoc('docs/LICENSE.txt', 'License information');
                break;
            default:
                break;
        }
    }

    async showDoc(path, title) {
        try {
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            const text = await response.text();
            await showTextDialog({ title, text, wrap: true });
        } catch (error) {
            toast(`Could not load ${path}: ${error.message}`, { type: 'error' });
        }
    }

    syncMenuChecks() {
        const set = (action, checked) => {
            for (const element of document.querySelectorAll(`[data-action="${action}"]`)) {
                element.setAttribute('aria-checked', String(checked));
            }
        };
        set('toggle-only-selected', this.showOnlySelected);
        set('toggle-hotspot', this.showHotspot);
        set('toggle-highlight', this.highlightSelected);
        set('toggle-theme', document.documentElement.dataset.theme === 'dark');
    }

    /* ------------------------------------------------------------------ */
    /* Opening projects                                                   */
    /* ------------------------------------------------------------------ */

    async openFolder() {
        if (typeof window.showDirectoryPicker === 'function') {
            const dirHandle = await files.pickDirectory();
            if (dirHandle) {
                await this.openDirectoryHandle(dirHandle);
            }
            return;
        }

        const selected = await files.pickFiles({ multiple: true, directory: true });
        if (!selected.length) {
            return;
        }
        const aniFiles = selected.filter((file) => files.isAniName(file.name));
        if (!aniFiles.length) {
            toast('No .ani file found in that folder.', { type: 'error' });
            return;
        }
        const chosen = await this.chooseAni(aniFiles.map((file) => ({ label: file.webkitRelativePath || file.name, value: file })));
        if (!chosen) {
            return;
        }
        await this.openProject({
            kind: 'files',
            aniText: await chosen.text(),
            aniFileName: chosen.name,
            images: files.imagesFromFiles(selected),
            label: chosen.webkitRelativePath || chosen.name,
        });
    }

    async openDirectoryHandle(dirHandle) {
        this.setBusy('Scanning folder…');
        try {
            const entries = await files.scanDirectory(dirHandle);
            const aniEntries = entries.filter((entry) => files.isAniName(entry.name));
            if (!aniEntries.length) {
                toast('No .ani file found in that folder.', { type: 'error' });
                return;
            }
            const chosen = await this.chooseAni(aniEntries.map((entry) => ({ label: entry.path, value: entry })));
            if (!chosen) {
                return;
            }
            const file = await chosen.handle.getFile();
            await this.openProject({
                kind: 'dir',
                aniText: await file.text(),
                aniFileName: chosen.name,
                aniFileHandle: chosen.handle,
                dirHandle,
                images: files.imagesFromDirectoryScan(entries),
                label: `${dirHandle.name}/${chosen.path}`,
            });
        } catch (error) {
            console.error(error);
            toast(`Could not open folder: ${error.message}`, { type: 'error' });
        } finally {
            this.setBusy(null);
        }
    }

    async openAniFile() {
        if (typeof window.showOpenFilePicker === 'function') {
            let picked;
            try {
                picked = await files.pickAniWithImages();
            } catch (error) {
                toast(`Could not open file: ${error.message}`, { type: 'error' });
                return;
            }
            if (!picked || !picked.aniEntry) {
                return;
            }
            const images = new Map();
            for (const entry of picked.entries) {
                if (entry === picked.aniEntry || files.isAniName(entry.name) || entry.name.toLowerCase().endsWith('.zip')) {
                    continue;
                }
                const key = entry.name.toLowerCase();
                if (!images.has(key)) {
                    images.set(key, { path: entry.name, getBlob: async () => entry.file });
                }
            }
            await this.openProject({
                kind: 'files',
                aniText: await picked.aniEntry.file.text(),
                aniFileName: picked.aniEntry.name,
                aniFileHandle: picked.aniEntry.handle,
                images,
                label: picked.aniEntry.name,
            });
            return;
        }

        const selected = await files.pickFiles({ multiple: true, accept: '.ani,.med,.big,.sml,.png,.jpg,.jpeg,.gif' });
        if (!selected.length) {
            return;
        }
        const aniFiles = selected.filter((file) => files.isAniName(file.name));
        if (!aniFiles.length) {
            toast('No .ani file selected.', { type: 'error' });
            return;
        }
        const chosen = aniFiles.length === 1
            ? aniFiles[0]
            : await this.chooseAni(aniFiles.map((file) => ({ label: file.name, value: file })));
        if (!chosen) {
            return;
        }
        await this.openProject({
            kind: 'files',
            aniText: await chosen.text(),
            aniFileName: chosen.name,
            images: files.imagesFromFiles(selected),
            label: chosen.name,
        });
    }

    async openZipDialog() {
        const selected = await files.pickFiles({ multiple: false, accept: '.zip,application/zip' });
        if (!selected.length) {
            return;
        }
        await this.openZipFile(selected[0]);
    }

    async openZipFile(file) {
        this.setBusy('Reading archive…');
        try {
            const { bytes, aniFiles, images } = await files.readZip(file);
            if (!aniFiles.length) {
                toast('No .ani file found in this zip archive.', { type: 'error' });
                return;
            }
            const chosen = await this.chooseAni(aniFiles.map((entry) => ({ label: entry.path, value: entry })));
            if (!chosen) {
                return;
            }
            await this.openProject({
                kind: 'zip',
                aniText: chosen.text,
                aniFileName: chosen.name,
                images,
                zipBytes: bytes,
                label: `${file.name}/${chosen.path}`,
            });
        } catch (error) {
            console.error(error);
            toast(`Could not read zip: ${error.message}`, { type: 'error' });
        } finally {
            this.setBusy(null);
        }
    }

    async openExample(name = 'chmmr') {
        this.setBusy('Loading example…');
        try {
            const { aniName, aniText, images } = await files.loadExample(name);
            await this.openProject({
                kind: 'example',
                aniText,
                aniFileName: aniName,
                images,
                label: `examples/chmmr/${aniName}`,
            });
        } catch (error) {
            console.error(error);
            toast(`Could not load example: ${error.message}`, { type: 'error' });
        } finally {
            this.setBusy(null);
        }
    }

    async chooseAni(options) {
        if (options.length === 1) {
            return options[0].value;
        }
        const chosen = await chooseDialog({
            title: 'Select animation file',
            message: 'This folder or archive contains multiple animation files. Pick the one to open:',
            options,
        });
        return chosen ? chosen.value : null;
    }

    async newProject() {
        if (this.dirty && !(await confirmDialog({
            title: 'New project',
            message: 'Discard unsaved changes and start a new empty project?',
            yesLabel: 'Discard',
            noLabel: 'Cancel',
        }))) {
            return;
        }
        await this.openProject({
            kind: 'memory',
            aniText: '',
            aniFileName: 'untitled.ani',
            images: new Map(),
            label: 'untitled.ani (not saved yet)',
        });
        toast('New empty project. Use "Add images as frames…" to add frames.');
    }

    async handleDrop(dataTransfer) {
        const dropped = await readDataTransfer(dataTransfer);
        if (!dropped.length) {
            return;
        }

        const zip = dropped.find((entry) => entry.file.name.toLowerCase().endsWith('.zip'));
        if (zip) {
            await this.openZipFile(zip.file);
            return;
        }

        const aniEntries = dropped.filter((entry) => files.isAniName(entry.file.name));
        if (!aniEntries.length) {
            toast('Drop an .ani file, a folder with an .ani file, or a .zip archive.', { type: 'error' });
            return;
        }
        const chosen = await this.chooseAni(aniEntries.map((entry) => ({ label: entry.path, value: entry })));
        if (!chosen) {
            return;
        }

        const images = new Map();
        for (const entry of dropped) {
            if (entry === chosen || files.isAniName(entry.file.name)) {
                continue;
            }
            const key = entry.file.name.toLowerCase();
            if (!images.has(key)) {
                images.set(key, { path: entry.path, getBlob: async () => entry.file });
            }
        }

        await this.openProject({
            kind: 'files',
            aniText: await chosen.file.text(),
            aniFileName: chosen.file.name,
            images,
            label: chosen.path,
        });
    }

    /**
     * Load a project description: parse the .ani text, decode the images and
     * reset all per-project state.
     */
    async openProject(spec) {
        const {
            kind = 'memory',
            aniText = '',
            aniFileName = 'untitled.ani',
            aniFileHandle = null,
            dirHandle = null,
            images = new Map(),
            zipBytes = null,
            label = aniFileName,
        } = spec;

        this.stopAnimationSystem();
        this.revokeObjectUrls();

        const { system, warnings } = parseAni(aniText);
        this.system = system;
        this.project = {
            kind, aniText, aniFileName, aniFileHandle, dirHandle, images, zipBytes, label,
        };

        this.selected.clear();
        this.anchorIndex = -1;
        this.selectedAnimRows.clear();
        this.selectedAnimation = 0;
        this.zOrder = [...system.frames].reverse();
        this.frameElements.clear();
        this.framesLayer.replaceChildren(this.hotspotEl);
        this.dirty = false;

        const missing = await this.loadImages();
        if (missing.length) {
            warnings.push('The following images could not be found (their frames are drawn as placeholders):');
            for (const name of missing) {
                warnings.push(`  - ${name}`);
            }
        }

        // Port of MainFrame.parseFile(): only centre when no negative offsets
        // were found in the file.
        const negativeFound = system.frames.some((frame) => frame.xoff < 0 || frame.yoff < 0);
        if (!negativeFound && system.frames.length > 0) {
            this.centerView();
        } else {
            this.centerOffset = { x: 0, y: 0 };
        }

        this.renderAll();
        this.updateStatus();

        if (warnings.length) {
            await showTextDialog({
                title: 'Errors occured while parsing the input file',
                text: warnings.join('\n'),
                width: 860,
            });
        }
    }

    async reload() {
        if (this.project.kind === 'none') {
            return;
        }
        if (this.dirty && !(await confirmDialog({
            title: 'Reload from disk',
            message: 'Discard unsaved changes and reload the project from its source?',
            yesLabel: 'Reload',
            noLabel: 'Cancel',
        }))) {
            return;
        }

        let aniText = this.project.aniText;
        if (this.project.kind === 'dir' && this.project.aniFileHandle) {
            try {
                const file = await this.project.aniFileHandle.getFile();
                aniText = await file.text();
            } catch (error) {
                toast(`Could not re-read the .ani file: ${error.message}`, { type: 'error' });
                return;
            }
        }
        await this.openProject({ ...this.project, aniText });
    }

    async loadImages() {
        const frames = this.system.frames;
        const missing = [];
        let done = 0;

        await Promise.all(frames.map(async (frame) => {
            const entry = this.project.images.get(frame.filename.toLowerCase());
            if (!entry) {
                frame.missing = true;
                missing.push(frame.filename);
                return;
            }
            try {
                const blob = await entry.getBlob();
                frame.blob = blob;
                if (entry.path) {
                    frame.path = entry.path;
                }
                await decodeFrame(frame, blob);
                frame.missing = false;
            } catch (error) {
                console.warn('Could not load image', frame.filename, error);
                frame.missing = true;
                missing.push(frame.filename);
            } finally {
                done++;
                this.setBusy(`Loading images ${done}/${frames.length}…`);
            }
        }));

        this.setBusy(null);
        return missing;
    }

    revokeObjectUrls() {
        for (const frame of this.system.frames) {
            if (frame.objectUrl) {
                URL.revokeObjectURL(frame.objectUrl);
                frame.objectUrl = null;
            }
            frame.bitmap = null;
        }
    }

    async addImages() {
        const selected = await files.pickFiles({ multiple: true, accept: 'image/*' });
        if (!selected.length) {
            return;
        }
        if (this.project.kind === 'none') {
            this.project = { ...this.emptyProject(), kind: 'memory', aniFileName: 'untitled.ani', label: 'untitled.ani (not saved yet)' };
        }

        const added = [];
        for (const file of selected) {
            if (!this.project.images.has(file.name.toLowerCase())) {
                this.project.images.set(file.name.toLowerCase(), {
                    path: file.webkitRelativePath || file.name,
                    getBlob: async () => file,
                });
            }
            const frame = new Frame({
                filename: file.name,
                split1: -1,
                split2: 10,
                xoff: 0,
                yoff: 0,
                path: file.name,
            });
            frame.blob = file;
            try {
                await decodeFrame(frame, file);
            } catch {
                frame.missing = true;
            }
            this.system.frames.push(frame);
            this.zOrder.unshift(frame);
            added.push(frame);
        }

        if (added.length) {
            this.dirty = true;
            this.workspaceEl.classList.toggle('has-project', this.system.frames.length > 0);
            this.syncWorkspaceDom();
            this.applyZOrder();
            this.renderFrameList();
            this.layoutFrames();
            this.applyFrameViewStates();
            this.updateStatus();
            toast(`Added ${added.length} frame(s).`);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Saving / exporting                                                 */
    /* ------------------------------------------------------------------ */

    async save(saveAs) {
        if (this.project.kind === 'none') {
            toast('Nothing to save — open or create a project first.', { type: 'error' });
            return false;
        }
        const text = serializeAni(this.system);
        const suggested = this.project.aniFileName || 'animation.ani';

        let handle = this.project.aniFileHandle;
        if (saveAs || !handle) {
            if (files.supportsFileSystemAccess) {
                try {
                    handle = await files.pickSaveFile(suggested);
                } catch (error) {
                    toast(`Could not open the save dialog: ${error.message}`, { type: 'error' });
                    return false;
                }
                if (!handle) {
                    return false;
                }
            }
        }

        if (handle) {
            try {
                if (!(await files.ensureWritePermission(handle))) {
                    toast('Write permission was denied; downloading the file instead.', { type: 'error' });
                    files.downloadText(text, suggested);
                    this.afterSave(suggested);
                    return true;
                }
                await files.writeTextToHandle(handle, text);
                this.project.aniFileHandle = handle;
                this.project.aniFileName = handle.name || suggested;
                this.project.aniText = text;
                if (this.project.kind === 'memory') {
                    this.project.kind = 'files';
                    this.project.label = this.project.aniFileName;
                }
                this.project.label = this.project.label || this.project.aniFileName;
                this.afterSave(this.project.aniFileName);
                toast(`Saved ${this.project.aniFileName}`, { type: 'success' });
                return true;
            } catch (error) {
                console.error(error);
                toast(`Could not save: ${error.message}`, { type: 'error' });
                return false;
            }
        }

        files.downloadText(text, suggested);
        this.project.aniText = text;
        this.afterSave(suggested);
        toast(`Downloaded ${suggested} (your browser cannot write to disk directly).`);
        return true;
    }

    afterSave(name) {
        this.dirty = false;
        this.renderFrameList();
        this.updateStatus();
        this.setTitle(name);
    }

    downloadAni() {
        if (this.project.kind === 'none') {
            toast('Nothing to download — open or create a project first.', { type: 'error' });
            return;
        }
        const text = serializeAni(this.system);
        const name = this.project.aniFileName || 'animation.ani';
        files.downloadText(text, name);
        this.dirty = false;
        this.renderFrameList();
        this.updateStatus();
        toast(`Downloaded ${name}`);
    }

    async downloadZip() {
        if (this.project.kind === 'none') {
            toast('Nothing to download — open or create a project first.', { type: 'error' });
            return;
        }
        const text = serializeAni(this.system);
        const aniName = this.project.aniFileName || 'animation.ani';
        this.setBusy('Creating archive…');
        try {
            const blob = await files.createZip(this.system, text, aniName);
            files.downloadBlob(blob, `${files.baseNameWithoutExtension(aniName)}.zip`);
            this.dirty = false;
            this.renderFrameList();
            this.updateStatus();
            toast(`Downloaded ${files.baseNameWithoutExtension(aniName)}.zip`, { type: 'success' });
        } catch (error) {
            console.error(error);
            toast(`Could not create zip: ${error.message}`, { type: 'error' });
        } finally {
            this.setBusy(null);
        }
    }

    async exportSmil() {
        if (this.system.frames.length === 0) {
            toast('Load a project first.', { type: 'error' });
            return;
        }
        const negate = await confirmDialog({
            title: 'Export SMIL file',
            message: 'Do you want to negate the X and Y offsets for all frames in the layout?\n\nAnswer "Yes" for communication screens, and "No" for anything else.',
            yesLabel: 'Yes, negate',
            noLabel: 'No',
        });
        const smil = generateSmil(this.system, negate ? -1 : 1);
        const name = `${files.baseNameWithoutExtension(this.project.aniFileName || 'animation')}.smil`;
        files.downloadText(smil, name, 'application/smil');
        toast(`Exported ${name}`, { type: 'success' });
    }

    /**
     * Export the animations as a TZO program for tzo-c's anim.c: loadImage /
     * beginDraw / endDraw / drawFrame foreign functions plus the
     * anim_anim_<i>_* context keys.
     */
    async exportTzo() {
        if (this.system.frames.length === 0) {
            toast('Load a project first.', { type: 'error' });
            return;
        }

        const stored = this.settings.tzo || {};
        const canWriteToFolder = Boolean(this.project.dirHandle) && files.supportsFileSystemAccess;
        const defaultPrefix = stored.pathPrefix !== undefined
            ? stored.pathPrefix
            : `base/comm/${files.baseNameWithoutExtension(this.project.aniFileName || 'animation')}/`;

        const fields = [
            {
                name: 'pathPrefix',
                label: 'Image path prefix',
                type: 'text',
                value: defaultPrefix,
                placeholder: 'e.g. base/comm/chmmr/',
                help: 'Prepended to every image filename in the loadImage calls (paths are resolved by PHYSFS in tzo-c).',
            },
            {
                name: 'fps',
                label: 'Host iterations per second',
                type: 'number',
                value: stored.fps ?? TZO_DEFAULT_FPS,
                min: 1,
                step: 1,
                help: 'anim.c runs the VM about 30 times per second; frame durations are converted into iterations.',
            },
            {
                name: 'startPlaying',
                label: 'Start all animations immediately',
                type: 'checkbox',
                value: stored.startPlaying !== false,
            },
            {
                name: 'dedupe',
                label: 'Reuse textures for identical frames',
                type: 'checkbox',
                value: stored.dedupe !== false,
            },
        ];
        if (canWriteToFolder) {
            fields.push({
                name: 'saveToFolder',
                label: `Also save the .json into the project folder (${this.project.dirHandle.name})`,
                type: 'checkbox',
                value: stored.saveToFolder !== false,
            });
        }

        const values = await formDialog({
            title: 'Export TZO animation',
            description: 'Generates a TZO program (JSON) that plays these animations with the animation '
                + 'extension used by tzo-c\'s anim.c (loadImage / beginDraw / endDraw / drawFrame and the '
                + 'anim_anim_<i>_index / _active / _yy_direction context keys).',
            fields,
            submitLabel: 'Export',
        });
        if (!values) {
            return;
        }

        this.settings.tzo = {
            pathPrefix: values.pathPrefix,
            fps: values.fps,
            startPlaying: values.startPlaying,
            dedupe: values.dedupe,
            saveToFolder: values.saveToFolder,
        };
        this.saveSettings();

        const exported = generateTzoProgram(this.system, {
            pathPrefix: values.pathPrefix,
            fps: values.fps,
            startPlaying: values.startPlaying,
            dedupe: values.dedupe,
        });
        const json = JSON.stringify(exported.state, null, 2);
        const name = `${files.baseNameWithoutExtension(this.project.aniFileName || 'animation')}.json`;

        let saved = false;
        if (values.saveToFolder && this.project.dirHandle) {
            try {
                const handle = await this.project.dirHandle.getFileHandle(name, { create: true });
                if (await files.ensureWritePermission(handle)) {
                    await files.writeTextToHandle(handle, json);
                    saved = true;
                    toast(`Saved ${name} into ${this.project.dirHandle.name}`, { type: 'success' });
                }
            } catch (error) {
                console.warn('Could not write the TZO program into the project folder', error);
            }
        }
        if (!saved) {
            files.downloadText(json, name, 'application/json');
            toast(
                `Exported ${name} — ${exported.stats.instructions} instructions, `
                + `${exported.stats.textures} textures, ${exported.stats.animations} animations`,
                { type: 'success' },
            );
        }

        if (exported.warnings.length > 0) {
            await showTextDialog({
                title: 'TZO export warnings',
                text: exported.warnings.join('\n\n'),
                wrap: true,
                width: 720,
            });
        }
    }

    async pickHotspotColor() {
        const color = await colorDialog({ title: 'Choose a color for the hotspot pixel', value: this.hotspotColor });
        if (!color) {
            return;
        }
        this.hotspotColor = color;
        this.hotspotEl.style.background = color;
        this.saveSettings();
    }

    /* ------------------------------------------------------------------ */
    /* Frame list / selection                                             */
    /* ------------------------------------------------------------------ */

    renderFrameList() {
        const fragment = document.createDocumentFragment();
        this.system.frames.forEach((frame, index) => {
            const item = document.createElement('li');
            item.textContent = frame.toString();
            item.dataset.index = String(index);
            item.title = frame.path || frame.filename;
            if (this.selected.has(index)) {
                item.classList.add('selected');
            }
            if (frame.missing) {
                item.classList.add('missing');
            }
            fragment.appendChild(item);
        });
        this.framesListEl.replaceChildren(fragment);
        this.frameCountEl.textContent = String(this.system.frames.length);
    }

    onFrameListClick(event) {
        const item = event.target.closest('li');
        if (!item) {
            return;
        }
        const index = Number(item.dataset.index);
        if (event.shiftKey && this.anchorIndex >= 0) {
            const start = Math.min(this.anchorIndex, index);
            const end = Math.max(this.anchorIndex, index);
            this.selected = new Set();
            for (let i = start; i <= end; i++) {
                this.selected.add(i);
            }
        } else if (event.ctrlKey || event.metaKey) {
            if (this.selected.has(index)) {
                this.selected.delete(index);
            } else {
                this.selected.add(index);
            }
            this.anchorIndex = index;
        } else {
            this.selected = new Set([index]);
            this.anchorIndex = index;
        }
        this.updateSelection();
    }

    onFrameListKeyDown(event) {
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.selectPrevious();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.selectNext();
        }
    }

    updateSelection() {
        for (const item of this.framesListEl.children) {
            item.classList.toggle('selected', this.selected.has(Number(item.dataset.index)));
        }
        const first = this.getSelectedFrameIndices()[0];
        if (first !== undefined) {
            const item = this.framesListEl.children[first];
            if (item) {
                item.scrollIntoView({ block: 'nearest' });
            }
        }
        this.applyFrameViewStates();
    }

    selectNext() {
        if (this.system.frames.length === 0) {
            return;
        }
        const current = this.getSelectedFrameIndices()[0];
        const next = current === undefined ? 0 : (current + 1) % this.system.frames.length;
        this.selected = new Set([next]);
        this.anchorIndex = next;
        this.updateSelection();
    }

    selectPrevious() {
        if (this.system.frames.length === 0) {
            return;
        }
        const current = this.getSelectedFrameIndices()[0];
        const previous = current === undefined
            ? this.system.frames.length - 1
            : (current - 1 + this.system.frames.length) % this.system.frames.length;
        this.selected = new Set([previous]);
        this.anchorIndex = previous;
        this.updateSelection();
    }

    translateSelected(dx, dy, all) {
        if (all) {
            for (const frame of this.system.frames) {
                frame.setDXoff(dx);
                frame.setDYoff(dy);
            }
        } else {
            const frame = this.getSelectedFrame();
            if (!frame) {
                return;
            }
            frame.setDXoff(dx);
            frame.setDYoff(dy);
        }
        this.dirty = true;
        this.renderFrameList();
        this.layoutFrames();
        this.renderAnimationFramesTable();
        this.updateStatus();
    }

    async setXYForSelected() {
        const selected = this.getSelectedFrameIndices();
        if (!selected.length) {
            toast('Select one or more frames in the list first.', { type: 'error' });
            return;
        }
        const newX = await promptDialog({
            title: 'Set x/y for selected frames',
            label: 'What should the new X position be for the selected frames (cancel to not change)?',
            value: '',
            placeholder: 'e.g. -36',
        });
        if (newX !== null && newX !== '') {
            const value = Number(newX);
            if (!Number.isInteger(value)) {
                toast('Please input a valid integer for X.', { type: 'error' });
            } else {
                for (const index of selected) {
                    this.system.frames[index].setXoff(value);
                }
            }
        }
        const newY = await promptDialog({
            title: 'Set x/y for selected frames',
            label: 'What should the new Y position be for the selected frames (cancel to not change)?',
            value: '',
            placeholder: 'e.g. -54',
        });
        if (newY !== null && newY !== '') {
            const value = Number(newY);
            if (!Number.isInteger(value)) {
                toast('Please input a valid integer for Y.', { type: 'error' });
            } else {
                for (const index of selected) {
                    this.system.frames[index].setYoff(value);
                }
            }
        }
        this.dirty = true;
        this.renderFrameList();
        this.layoutFrames();
        this.renderAnimationFramesTable();
        this.updateStatus();
    }

    /* ------------------------------------------------------------------ */
    /* Workspace rendering                                                */
    /* ------------------------------------------------------------------ */

    syncWorkspaceDom() {
        const alive = new Set(this.system.frames);

        for (const [frame, element] of [...this.frameElements.entries()]) {
            if (!alive.has(frame)) {
                element.remove();
                this.frameElements.delete(frame);
            }
        }

        for (const frame of this.system.frames) {
            if (this.frameElements.has(frame)) {
                continue;
            }
            let element;
            if (frame.loaded && frame.objectUrl) {
                element = document.createElement('img');
                element.className = 'frame-img';
                element.src = frame.objectUrl;
                element.alt = frame.filename;
                element.draggable = false;
            } else {
                element = document.createElement('div');
                element.className = 'frame-missing';
                element.textContent = frame.filename;
            }
            this.frameElements.set(frame, element);
            this.framesLayer.appendChild(element);
        }
    }

    layoutFrames() {
        const zoom = this.zoom;
        const { x: centerX, y: centerY } = this.centerOffset;

        for (const frame of this.system.frames) {
            const element = this.frameElements.get(frame);
            if (!element) {
                continue;
            }
            const width = (frame.width || 96) * zoom;
            const height = (frame.height || 40) * zoom;
            element.style.left = `${-frame.xoff * zoom + centerX}px`;
            element.style.top = `${-frame.yoff * zoom + centerY}px`;
            element.style.width = `${width}px`;
            element.style.height = `${height}px`;
        }

        // The original generateHotspot() creates a 100x100 ARGB image but only
        // sets the pixel at (0,0): the hotspot marker is a single UQM pixel,
        // drawn at the current zoom factor.
        this.hotspotEl.style.left = `${centerX}px`;
        this.hotspotEl.style.top = `${centerY}px`;
        this.hotspotEl.style.width = `${zoom}px`;
        this.hotspotEl.style.height = `${zoom}px`;
        this.hotspotEl.style.zIndex = String(this.zOrder.length + 100);
    }

    applyZOrder() {
        const total = this.zOrder.length;
        this.zOrder.forEach((frame, index) => {
            const element = this.frameElements.get(frame);
            if (element) {
                element.style.zIndex = String(total - index);
            }
        });
    }

    bringToFront(frame) {
        const index = this.zOrder.indexOf(frame);
        if (index > 0) {
            this.zOrder.splice(index, 1);
            this.zOrder.unshift(frame);
            this.applyZOrder();
        }
    }

    /** Port of MainFrame.repaintFrames(). */
    applyFrameViewStates() {
        const mode = this.transparencyMode;
        const selectedFrame = this.getSelectedFrame();

        if (this.animationMode) {
            for (const frame of this.system.frames) {
                frame.visible = this.system.isVisible(frame);
                frame.transparency = 1;
                frame.highlight = 1;
            }
        } else {
            for (const frame of this.system.frames) {
                frame.visible = true;
                switch (mode) {
                    case 2:
                        frame.transparency = 0.5;
                        frame.highlight = 0.5;
                        break;
                    case 3:
                        frame.transparency = 0.25;
                        frame.highlight = 0.25;
                        break;
                    default:
                        frame.transparency = 1;
                        frame.highlight = 1;
                        break;
                }
            }

            if (selectedFrame) {
                if (this.showOnlySelected) {
                    for (const frame of this.system.frames) {
                        frame.visible = false;
                    }
                }
                selectedFrame.visible = true;
                switch (mode) {
                    case 1:
                    case 3:
                        selectedFrame.transparency = 0.5;
                        break;
                    default:
                        selectedFrame.transparency = 1;
                        break;
                }
                selectedFrame.highlight = this.highlightSelected ? 2 : selectedFrame.transparency;
                this.bringToFront(selectedFrame);
            }
        }

        const hotspotVisible = this.showHotspot && this.project.kind !== 'none' && this.system.frames.length > 0;
        this.hotspotEl.style.display = hotspotVisible ? '' : 'none';
        this.applyViewStyles();
    }

    applyViewStyles() {
        for (const frame of this.system.frames) {
            const element = this.frameElements.get(frame);
            if (!element) {
                continue;
            }
            element.style.display = frame.visible ? '' : 'none';
            element.style.opacity = String(frame.transparency);
            element.style.filter = frame.highlight === 1 ? '' : `brightness(${frame.highlight})`;
        }
    }

    centerView() {
        this.centerOffset = {
            x: Math.round(this.workspaceEl.clientWidth / 2),
            y: Math.round(this.workspaceEl.clientHeight / 2),
        };
        this.layoutFrames();
    }

    setZoom(value) {
        this.zoom = clamp(Math.round(value), 1, 10);
        this.zoomSlider.value = String(this.zoom);
        this.zoomLabel.textContent = `Zoom: ${this.zoom}`;
        this.saveSettings();
        this.layoutFrames();
    }

    updateMousePosition(event) {
        if (this.project.kind === 'none') {
            return;
        }
        const rect = this.workspaceEl.getBoundingClientRect();
        const x = event.clientX - rect.left - this.centerOffset.x;
        const y = event.clientY - rect.top - this.centerOffset.y;
        const mx = Math.trunc(x / this.zoom);
        const my = Math.trunc(y / this.zoom);
        this.statusMouseEl.textContent = `Mouse: [${mx},${my}]`;
    }

    /* ------------------------------------------------------------------ */
    /* Animation definition panel                                        */
    /* ------------------------------------------------------------------ */

    renderAnimationPanel() {
        const animations = this.system.animations;

        const options = animations.map((animation, index) => new Option(animation.toString(), String(index)));
        this.animSelect.replaceChildren(...options);
        this.animSelect.disabled = animations.length === 0;
        if (animations.length > 0) {
            this.selectedAnimation = clamp(this.selectedAnimation, 0, animations.length - 1);
            this.animSelect.selectedIndex = this.selectedAnimation;
        }

        const animation = this.currentAnimation();
        this.animTypeSelect.replaceChildren(...ANIMATION_TYPES.map((type) => {
            const option = new Option(type, type);
            option.title = TYPE_DESCRIPTIONS[type] || '';
            return option;
        }));
        this.animTypeSelect.disabled = !animation;
        if (animation) {
            this.animTypeSelect.value = animation.aniType;
        }

        this.renderAnimationFramesTable();
    }

    renderAnimationFramesTable() {
        const animation = this.currentAnimation();
        const background = animation ? animation.aniType === AnimationType.BACKGROUND : false;
        this.colDuration.style.display = background ? 'none' : '';

        const rows = [];
        if (!animation) {
            const row = document.createElement('tr');
            row.className = 'empty-row';
            const cell = document.createElement('td');
            cell.colSpan = 2;
            cell.textContent = this.project.kind === 'none'
                ? 'No project loaded.'
                : 'No animations defined yet — press the + button.';
            row.appendChild(cell);
            rows.push(row);
        } else if (animation.frames.length === 0) {
            const row = document.createElement('tr');
            row.className = 'empty-row';
            const cell = document.createElement('td');
            cell.colSpan = background ? 1 : 2;
            cell.textContent = 'No frames in this animation. Select frames on the left and press "Import selected frame(s)".';
            row.appendChild(cell);
            rows.push(row);
        } else {
            animation.frames.forEach((animationFrame, index) => {
                const row = document.createElement('tr');
                if (this.selectedAnimRows.has(index)) {
                    row.classList.add('selected');
                }
                row.addEventListener('mousedown', (event) => this.selectAnimationRow(index, event));

                if (!background) {
                    const durationCell = document.createElement('td');
                    const input = document.createElement('input');
                    // A text input (instead of type=number) keeps "0.1" as "0.1"
                    // instead of showing the locale's decimal separator.
                    input.type = 'text';
                    input.inputMode = 'decimal';
                    input.className = 'duration-input';
                    input.value = String(animationFrame.duration);
                    input.title = 'Frame duration in seconds';
                    input.addEventListener('change', () => {
                        const raw = input.value.trim().replace(',', '.');
                        const value = Number(raw);
                        if (raw === '' || !Number.isFinite(value)) {
                            toast('Invalid duration specified.', { type: 'error' });
                            input.value = String(animationFrame.duration);
                            return;
                        }
                        animationFrame.setDuration(value);
                        input.value = String(value);
                        this.dirty = true;
                        this.updateStatus();
                    });
                    durationCell.appendChild(input);
                    row.appendChild(durationCell);
                }

                const frameCell = document.createElement('td');
                frameCell.className = 'frame-cell';
                frameCell.textContent = animationFrame.frame.toString();
                frameCell.title = animationFrame.frame.toSource();
                row.appendChild(frameCell);

                rows.push(row);
            });
        }

        this.animFramesBody.replaceChildren(...rows);
    }

    selectAnimationRow(index, event) {
        if (event.ctrlKey || event.metaKey) {
            if (this.selectedAnimRows.has(index)) {
                this.selectedAnimRows.delete(index);
            } else {
                this.selectedAnimRows.add(index);
            }
        } else if (event.shiftKey) {
            const anchor = this.selectedAnimRows.size ? Math.min(...this.selectedAnimRows) : index;
            const start = Math.min(anchor, index);
            const end = Math.max(anchor, index);
            this.selectedAnimRows.clear();
            for (let i = start; i <= end; i++) {
                this.selectedAnimRows.add(i);
            }
        } else {
            this.selectedAnimRows = new Set([index]);
        }
        this.renderAnimationFramesTable();
    }

    addAnimation() {
        const animation = new Animation();
        animation.aniType = AnimationType.CIRCULAR;
        this.system.addAnimation(animation);
        this.selectedAnimation = this.system.animations.length - 1;
        this.selectedAnimRows.clear();
        this.dirty = true;
        this.renderAnimationPanel();
        this.renderPlayback();
        this.updateStatus();
    }

    removeAnimation() {
        const animation = this.currentAnimation();
        if (!animation) {
            return;
        }
        this.system.animations.splice(this.selectedAnimation, 1);
        this.selectedAnimation = 0;
        this.selectedAnimRows.clear();
        this.dirty = true;
        this.renderAnimationPanel();
        this.renderPlayback();
        this.applyFrameViewStates();
        this.updateStatus();
    }

    async renameAnimation() {
        const animation = this.currentAnimation();
        if (!animation) {
            return;
        }
        const result = await promptDialog({
            title: 'Rename animation',
            label: 'What should the new name of the animation be?',
            value: animation.name,
        });
        if (result === null) {
            return;
        }
        if (result.includes('[') || result.includes(']')) {
            toast("Characters '[' and ']' are not allowed. Removing them.", { type: 'error' });
        }
        animation.setName(result);
        this.dirty = true;
        this.renderAnimationPanel();
        this.renderPlayback();
        this.updateStatus();
    }

    importSelectedFrames() {
        const animation = this.currentAnimation();
        if (!animation) {
            toast('Create an animation first with the + button.', { type: 'error' });
            return;
        }
        const indices = this.getSelectedFrameIndices();
        if (!indices.length) {
            toast('Select one or more frames in the list on the left first.', { type: 'error' });
            return;
        }
        const duration = animation.aniType === AnimationType.BACKGROUND ? -1 : 1;
        for (const index of indices) {
            const frame = this.system.frames[index];
            if (frame) {
                animation.addFrame(frame, duration);
            }
        }
        this.dirty = true;
        this.renderAnimationPanel();
        this.renderPlayback();
        this.updateStatus();
    }

    removeAnimationFrames() {
        const animation = this.currentAnimation();
        if (!animation) {
            return;
        }
        const rows = [...this.selectedAnimRows].sort((a, b) => b - a);
        for (const row of rows) {
            if (row >= 0 && row < animation.frames.length) {
                animation.frames.splice(row, 1);
            }
        }
        this.selectedAnimRows.clear();
        this.dirty = true;
        this.renderAnimationPanel();
        this.renderPlayback();
        this.updateStatus();
    }

    moveAnimationFrame(delta) {
        const animation = this.currentAnimation();
        if (!animation) {
            return;
        }
        const rows = [...this.selectedAnimRows].sort((a, b) => a - b);
        const oldIndex = rows.length ? rows[0] : -1;
        if (oldIndex < 0 || oldIndex >= animation.frames.length) {
            return;
        }
        const newIndex = clamp(oldIndex + delta, 0, animation.frames.length - 1);
        if (newIndex === oldIndex) {
            return;
        }
        const [moved] = animation.frames.splice(oldIndex, 1);
        animation.frames.splice(newIndex, 0, moved);
        this.selectedAnimRows = new Set([newIndex]);
        this.dirty = true;
        this.renderAnimationPanel();
        this.updateStatus();
    }

    async setDurationForSelected() {
        const animation = this.currentAnimation();
        if (!animation) {
            return;
        }
        const rows = [...this.selectedAnimRows];
        if (!rows.length) {
            toast('Select one or more rows in the animation table first.', { type: 'error' });
            return;
        }
        const result = await promptDialog({
            title: 'Set duration',
            label: 'What should the new duration be for ALL selected frames (cancel to not change)?',
            value: '',
            placeholder: 'e.g. 0.1',
        });
        if (result === null || result === '') {
            return;
        }
        const value = Number(result);
        if (!Number.isFinite(value)) {
            toast('Please input a valid number.', { type: 'error' });
            return;
        }
        for (const row of rows) {
            const animationFrame = animation.frames[row];
            if (animationFrame) {
                animationFrame.setDuration(value);
            }
        }
        this.dirty = true;
        this.renderAnimationFramesTable();
        this.updateStatus();
    }

    /* ------------------------------------------------------------------ */
    /* Playback                                                           */
    /* ------------------------------------------------------------------ */

    renderPlayback() {
        const rows = this.system.animations.map((animation, index) => {
            const row = document.createElement('tr');
            row.dataset.index = String(index);
            if (index === this.selectedAnimation) {
                row.classList.add('selected');
            }

            const playCell = document.createElement('td');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'play-button';
            button.title = animation.isPlaying() ? 'Stop animation' : 'Play animation';
            const icon = document.createElement('img');
            icon.src = animation.isPlaying() ? 'icons/media-playback-stop.png' : 'icons/media-playback-start.png';
            icon.alt = animation.isPlaying() ? 'Stop' : 'Play';
            button.appendChild(icon);
            button.addEventListener('click', () => {
                this.selectedAnimation = index;
                this.selectedAnimRows.clear();
                this.startAnimationSystem();
                animation.oneShot = false;
                animation.setIsPlaying(!animation.isPlaying(), performance.now());
                this.renderAnimationPanel();
                this.renderPlayback();
                this.applyFrameViewStates();
            });
            playCell.appendChild(button);
            row.appendChild(playCell);

            const nameCell = document.createElement('td');
            nameCell.className = 'frame-cell';
            nameCell.textContent = animation.toString();
            row.appendChild(nameCell);

            row.addEventListener('click', (event) => {
                if (event.target.closest('button')) {
                    return;
                }
                this.selectedAnimation = index;
                this.selectedAnimRows.clear();
                this.renderAnimationPanel();
                this.renderPlayback();
            });

            return row;
        });

        if (!rows.length) {
            const row = document.createElement('tr');
            row.className = 'empty-row';
            const cell = document.createElement('td');
            cell.colSpan = 2;
            cell.textContent = 'No animations defined yet.';
            row.appendChild(cell);
            rows.push(row);
        }

        this.playbackBody.replaceChildren(...rows);
        this.updateAnimSystemButton();
    }

    updateAnimSystemButton() {
        if (this.animationMode) {
            this.animSystemIcon.src = 'icons/media-playback-stop.png';
            this.animSystemLabel.textContent = 'Stop ani system';
            this.statusModeEl.textContent = 'Animation mode';
        } else {
            this.animSystemIcon.src = 'icons/media-playback-start.png';
            this.animSystemLabel.textContent = 'Start/stop ani system';
            this.statusModeEl.textContent = 'Layout mode';
        }
    }

    startAnimationSystem() {
        if (this.animationMode) {
            return;
        }
        this.animationMode = true;
        this.oneShotPending = false;
        const now = performance.now();
        for (const animation of this.system.animations) {
            animation.resetTimer(now);
        }
        this.updateAnimSystemButton();
        this.applyFrameViewStates();

        const tick = () => {
            if (!this.animationMode) {
                return;
            }
            const timestamp = performance.now();
            for (const animation of this.system.animations) {
                animation.processAnimationDelta(timestamp);
            }
            this.applyFrameViewStates();

            const signature = this.system.animations.map((animation) => animation.playingState).join(',');
            if (signature !== this.playbackSignature) {
                this.playbackSignature = signature;
                this.renderPlayback();
            }
            if (this.oneShotPending && !this.system.animations.some((animation) => animation.isPlaying())) {
                // A SPACE "play once" finished: go back to layout mode so all
                // frames become visible again.
                this.stopAnimationSystem();
                return;
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    stopAnimationSystem() {
        if (!this.animationMode) {
            return;
        }
        this.animationMode = false;
        this.oneShotPending = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        for (const animation of this.system.animations) {
            animation.setIsPlaying(false);
        }
        this.updateAnimSystemButton();
        this.renderPlayback();
        this.applyFrameViewStates();
    }

    playSelectedOnce() {
        const animation = this.currentAnimation();
        if (!animation || animation.frames.length === 0) {
            return;
        }
        this.startAnimationSystem();
        for (const other of this.system.animations) {
            if (other !== animation) {
                other.setIsPlaying(false);
            }
        }
        animation.oneShot = true;
        animation.setIsPlaying(true, performance.now());
        this.oneShotPending = true;
        this.renderPlayback();
    }

    toggleSelectedPlayback() {
        const animation = this.currentAnimation();
        if (!animation || animation.frames.length === 0) {
            return;
        }
        this.startAnimationSystem();
        animation.oneShot = false;
        animation.setIsPlaying(!animation.isPlaying(), performance.now());
        this.renderPlayback();
    }

    /* ------------------------------------------------------------------ */
    /* Status / rendering orchestration                                   */
    /* ------------------------------------------------------------------ */

    setBusy(message) {
        if (message) {
            this.toolbarHintEl.textContent = message;
        } else {
            this.updateStatus();
        }
    }

    updateStatus() {
        const hasProject = this.project.kind !== 'none';
        const name = this.project.aniFileName || 'untitled.ani';
        if (!hasProject) {
            this.statusFileEl.textContent = 'No file loaded';
            this.statusFileEl.title = 'No file loaded';
            this.toolbarHintEl.textContent = 'No project loaded';
            this.setTitle(null);
            return;
        }

        this.statusFileEl.textContent = `Loaded: ${this.project.label || name}${this.dirty ? ' *' : ''}`;
        this.statusFileEl.title = `${this.project.label || name}${this.dirty ? ' (unsaved changes)' : ''}`;
        this.toolbarHintEl.textContent = `${this.system.frames.length} frames · ${this.system.animations.length} animations · ${describeKind(this.project.kind)}`;
        this.setTitle(name);
    }

    setTitle(name) {
        document.title = name
            ? `${this.dirty ? '*' : ''}${name} — UQMAnimationTool`
            : 'UQMAnimationTool — HTML5 port';
    }

    renderAll() {
        this.syncWorkspaceDom();
        this.applyZOrder();
        this.renderFrameList();
        this.renderAnimationPanel();
        this.renderPlayback();
        this.applyFrameViewStates();
        this.layoutFrames();
        const showEmptyState = this.project.kind === 'none' || this.system.frames.length === 0;
        this.workspaceEl.classList.toggle('has-project', !showEmptyState);
        const emptyTitle = this.workspaceEl.querySelector('.workspace-empty-title');
        if (emptyTitle) {
            emptyTitle.textContent = this.project.kind === 'none' ? 'No project loaded' : 'No frames yet';
        }
        this.updateStatus();
    }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function describeKind(kind) {
    switch (kind) {
        case 'dir':
            return 'folder';
        case 'zip':
            return 'zip archive';
        case 'example':
            return 'bundled example';
        case 'memory':
            return 'new project';
        case 'files':
            return 'local files';
        default:
            return 'no project';
    }
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not decode image'));
        image.src = url;
    });
}

async function decodeFrame(frame, blob) {
    const url = URL.createObjectURL(blob);
    try {
        const image = await loadImage(url);
        frame.bitmap = image;
        frame.width = image.naturalWidth || image.width;
        frame.height = image.naturalHeight || image.height;
        frame.objectUrl = url;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

/** Walk a DataTransfer (files, folders) into a flat list of {file, path}. */
async function readDataTransfer(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    const roots = [];

    for (const item of items) {
        if (item.kind !== 'file') {
            continue;
        }
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
            roots.push(entry);
        } else {
            const file = item.getAsFile();
            if (file) {
                roots.push({ isFile: true, isDirectory: false, name: file.name, file });
            }
        }
    }

    if (!roots.length) {
        for (const file of Array.from(dataTransfer.files || [])) {
            roots.push({ isFile: true, isDirectory: false, name: file.name, file });
        }
    }

    const out = [];

    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            const file = entry.file
                ? entry.file
                : await new Promise((resolve, reject) => entry.file(resolve, reject));
            out.push({ file, path: prefix ? `${prefix}${file.name}` : file.name });
            return;
        }
        if (entry.isDirectory) {
            const reader = entry.createReader();
            const path = prefix ? `${prefix}${entry.name}/` : `${entry.name}/`;
            // readEntries() returns at most 100 entries per call.
            for (;;) {
                const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (!children.length) {
                    break;
                }
                for (const child of children) {
                    await walk(child, path);
                }
            }
        }
    };

    for (const root of roots) {
        await walk(root, '');
    }

    return out;
}

/* Boot */
const app = new App();
window.uqmaniApp = app;
