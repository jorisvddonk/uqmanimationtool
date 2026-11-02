/*
 * File access helpers.
 *
 * Supports three ways of getting a project into the tool:
 *  - a folder (File System Access API, or a webkitdirectory file input),
 *  - a set of loose files (ani + images) or a dropped folder,
 *  - a .zip archive containing the .ani file and its images.
 *
 * Saving uses the File System Access API when available and falls back to a
 * regular browser download (which is all Safari/Firefox support).
 */

const fflate = globalThis.fflate;

export const ANI_EXTENSIONS = ['ani', 'med', 'big', 'sml'];

export function isAniName(name) {
    const lower = String(name).toLowerCase();
    return ANI_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

export function basename(path) {
    const clean = String(path).replace(/\\/g, '/');
    return clean.substring(clean.lastIndexOf('/') + 1);
}

export function dirname(path) {
    const clean = String(path).replace(/\\/g, '/');
    const index = clean.lastIndexOf('/');
    return index === -1 ? '' : clean.substring(0, index);
}

function requireZipLibrary() {
    if (!fflate) {
        throw new Error('The zip library (js/vendor/fflate.js) is not loaded.');
    }
}

export const supportsFileSystemAccess = typeof window !== 'undefined'
    && typeof window.showOpenFilePicker === 'function'
    && typeof window.showSaveFilePicker === 'function';

/* ------------------------------------------------------------------ */
/* Picking things                                                      */
/* ------------------------------------------------------------------ */

/** Ask for a folder. Returns a FileSystemDirectoryHandle or null. */
export async function pickDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
        return null;
    }
    try {
        return await window.showDirectoryPicker({ id: 'uqmanimationtool', mode: 'readwrite' });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

/**
 * Ask for the .ani file plus (optionally) its images. Selecting the images in
 * the same dialog means we keep a writable handle for the .ani file and can
 * still resolve every frame.
 *
 * @returns {Promise<{entries: Array<{handle, file, name}>, aniEntry: object|null}|null>}
 */
export async function pickAniWithImages() {
    if (!supportsFileSystemAccess) {
        return null;
    }
    try {
        const handles = await window.showOpenFilePicker({
            id: 'uqmanimationtool-ani',
            multiple: true,
            types: [{
                description: 'UQM animation file with images',
                accept: {
                    'text/plain': ['.ani', '.med', '.big', '.sml'],
                    'image/png': ['.png'],
                    'image/jpeg': ['.jpg', '.jpeg'],
                    'image/gif': ['.gif'],
                    'image/webp': ['.webp'],
                    'application/zip': ['.zip'],
                },
            }],
        });
        const entries = [];
        for (const handle of handles) {
            const file = await handle.getFile();
            entries.push({ handle, file, name: file.name });
        }
        const aniEntry = entries.find((entry) => isAniName(entry.name)) || null;
        return { entries, aniEntry };
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

/** Ask where to save an .ani file. Returns a FileSystemFileHandle or null. */
export async function pickSaveFile(suggestedName = 'animation.ani') {
    if (!supportsFileSystemAccess) {
        return null;
    }
    try {
        return await window.showSaveFilePicker({
            id: 'uqmanimationtool-save',
            suggestedName,
            types: [{
                description: 'UQM animation file',
                accept: { 'text/plain': ['.ani', '.med', '.big', '.sml'] },
            }],
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

/** Open a regular <input type=file> picker. */
export function pickFiles({ multiple = true, accept = '', directory = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        if (accept) {
            input.accept = accept;
        }
        if (directory) {
            input.webkitdirectory = true;
        }
        input.style.display = 'none';
        document.body.appendChild(input);
        let settled = false;
        const done = (files) => {
            if (settled) {
                return;
            }
            settled = true;
            input.remove();
            resolve(files);
        };
        input.addEventListener('change', () => done(Array.from(input.files || [])));
        input.addEventListener('cancel', () => done([]));
        input.click();
    });
}

/* ------------------------------------------------------------------ */
/* Directory / file-list scanning                                      */
/* ------------------------------------------------------------------ */

/**
 * Recursively scan a directory handle.
 * @returns {Promise<Array<{name: string, path: string, handle: FileSystemFileHandle}>>}
 */
export async function scanDirectory(dirHandle, prefix = '', depth = 0, out = []) {
    if (depth > 4) {
        return out;
    }
    for await (const [name, handle] of dirHandle.entries()) {
        if (name.startsWith('.')) {
            continue;
        }
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
            await scanDirectory(handle, path, depth + 1, out);
        } else {
            out.push({ name, path, handle });
        }
    }
    return out;
}

/**
 * Build the image lookup table for a scanned directory.
 * @returns {Map<string, {path: string, getBlob: () => Promise<Blob>}>}
 */
export function imagesFromDirectoryScan(entries) {
    const images = new Map();
    for (const entry of entries) {
        if (isAniName(entry.name) || entry.name.toLowerCase().endsWith('.zip')) {
            continue;
        }
        const key = entry.name.toLowerCase();
        if (!images.has(key)) {
            images.set(key, {
                path: entry.path,
                getBlob: () => entry.handle.getFile(),
            });
        }
    }
    return images;
}

/** Build the image lookup table for a list of File objects (loose files / drop). */
export function imagesFromFiles(files) {
    const images = new Map();
    for (const file of files) {
        if (isAniName(file.name) || file.name.toLowerCase().endsWith('.zip')) {
            continue;
        }
        const key = file.name.toLowerCase();
        if (!images.has(key)) {
            images.set(key, {
                path: file.webkitRelativePath || file.name,
                getBlob: async () => file,
            });
        }
    }
    return images;
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read a zip file into ani candidates + image sources.
 * @param {Blob} blob
 */
export async function readZip(blob) {
    requireZipLibrary();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const entries = fflate.unzipSync(bytes);
    const aniFiles = [];
    const images = new Map();
    let imageCount = 0;

    for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith('/')) {
            continue;
        }
        const name = basename(path);
        if (isAniName(name)) {
            aniFiles.push({ name, path, text: fflate.strFromU8(data) });
        } else {
            imageCount++;
            const key = name.toLowerCase();
            if (!images.has(key)) {
                images.set(key, {
                    path,
                    getBlob: async () => new Blob([data]),
                });
            }
        }
    }

    return { bytes, aniFiles, images, imageCount };
}

/**
 * Create a zip containing the .ani file and every referenced image.
 * @param {import('./model.js').AnimationSystem} system
 * @param {string} aniText
 * @param {string} aniFileName
 * @returns {Promise<Blob>}
 */
export async function createZip(system, aniText, aniFileName) {
    requireZipLibrary();
    const files = {};
    files[basename(aniFileName)] = fflate.strToU8(aniText);

    for (const frame of system.frames) {
        if (!frame.blob) {
            continue;
        }
        if (files[frame.filename]) {
            continue;
        }
        files[frame.filename] = new Uint8Array(await frame.blob.arrayBuffer());
    }

    const zipped = fflate.zipSync(files, { level: 6 });
    return new Blob([zipped], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ */
/* Examples (bundled with the site)                                    */
/* ------------------------------------------------------------------ */

/**
 * Load a bundled example project from web/examples/<name>/.
 * @returns {Promise<{aniName: string, aniText: string, images: Map}>}
 */
export async function loadExample(name) {
    const base = new URL(`examples/${name}/`, document.baseURI);
    const manifestUrl = new URL('manifest.json', base);
    const response = await fetch(manifestUrl);
    if (!response.ok) {
        throw new Error(`Could not load example manifest (${response.status})`);
    }
    const manifest = await response.json();

    const aniResponse = await fetch(new URL(manifest.ani, base));
    if (!aniResponse.ok) {
        throw new Error(`Could not load example .ani (${aniResponse.status})`);
    }
    const aniText = await aniResponse.text();

    const images = new Map();
    for (const fileName of manifest.images) {
        const url = new URL(fileName, base);
        images.set(fileName.toLowerCase(), {
            path: fileName,
            getBlob: async () => {
                const imageResponse = await fetch(url);
                if (!imageResponse.ok) {
                    throw new Error(`Could not load ${fileName} (${imageResponse.status})`);
                }
                return imageResponse.blob();
            },
        });
    }

    return { aniName: manifest.ani, aniText, images };
}

/* ------------------------------------------------------------------ */
/* Saving                                                             */
/* ------------------------------------------------------------------ */

export async function ensureWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
        return false;
    }
    const options = { mode: 'readwrite' };
    if ((await handle.queryPermission(options)) === 'granted') {
        return true;
    }
    return (await handle.requestPermission(options)) === 'granted';
}

export async function writeTextToHandle(fileHandle, text) {
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadText(text, filename, mime = 'text/plain') {
    downloadBlob(new Blob([text], { type: mime }), filename);
}

export function baseNameWithoutExtension(name) {
    const base = basename(name);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.substring(0, dot) : base;
}
