/*
Copyright (C) 2011 Joris van de Donk

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
claim that you wrote the original software. If you use this software
in a product, an acknowledgment in the product documentation would be
appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

Joris van de Donk - joris@mooses.nl
 */

/*
 * HTML5 port of the UQMAnimationTool data model.
 *
 * This is a fairly direct port of AnimationSystem.java, Animation.java,
 * AnimationFrame.java, AnimationType.java and the data-half of ImagePanel.java.
 * A Frame replaces ImagePanel: instead of a Swing component it holds a decoded
 * bitmap plus its UQM .ani properties.
 */

export const AnimationType = Object.freeze({
    CIRCULAR: 'CIRCULAR',
    RANDOM: 'RANDOM',
    TALK: 'TALK',
    YO_YO: 'YO_YO',
    BACKGROUND: 'BACKGROUND',
    UNDEFINED: 'UNDEFINED',
});

/** Order used by the "animation type" combo box in the original tool. */
export const ANIMATION_TYPES = [
    AnimationType.BACKGROUND,
    AnimationType.CIRCULAR,
    AnimationType.RANDOM,
    AnimationType.TALK,
    AnimationType.YO_YO,
];

export const TYPE_DESCRIPTIONS = {
    BACKGROUND: 'Background frames. These should *always* be visible in the background.',
    CIRCULAR: 'Circular animation. Shows all frames in order, then restarts from the top again.',
    RANDOM: 'Random animation. Frames are shown in a random order.',
    TALK: 'Talk animation. Shown whenever the character is talking (same as CIRCULAR).',
    YO_YO: 'Yo-yo animation. Shows all frames in order, then backwards.',
    UNDEFINED: 'Not defined yet.',
};

/** A single frame, i.e. one line of a UQM .ani file plus its bitmap. */
export class Frame {
    constructor({ filename = 'NULL', split1 = -2, split2 = 1, xoff = 0, yoff = 0, path = null } = {}) {
        this.filename = filename;
        /** Path inside the project (zip entry / folder), used when saving a zip. */
        this.path = path || filename;
        this.split1 = split1;
        this.split2 = split2;
        this.xoff = xoff;
        this.yoff = yoff;

        this.changed = false;
        this.missing = false;

        /** ImageBitmap (or HTMLImageElement fallback) once decoded. */
        this.bitmap = null;
        this.width = 0;
        this.height = 0;
        /** Blob of the original image file, used for "download as zip". */
        this.blob = null;
        this.objectUrl = null;

        // View state (originally stored on ImagePanel).
        this.transparency = 1;
        this.highlight = 1;
        this.visible = true;
        this.zIndex = 0;
    }

    get loaded() {
        return this.bitmap !== null;
    }

    /** The "source" string as written in the .ani file. */
    toSource() {
        return `${this.filename} ${this.split1} ${this.split2} ${this.xoff} ${this.yoff}`;
    }

    /** The string shown in the frame list (ImagePanel.toString()). */
    toString() {
        return `${this.changed ? '*' : ' '}${this.filename} ${this.split1} ${this.split2} ${this.xoff} ${this.yoff}`;
    }

    setXoff(xoff) {
        this.changed = true;
        this.xoff = xoff;
    }

    setYoff(yoff) {
        this.changed = true;
        this.yoff = yoff;
    }

    setDXoff(dx) {
        this.changed = true;
        this.xoff += dx;
    }

    setDYoff(dy) {
        this.changed = true;
        this.yoff += dy;
    }
}

/** An entry in an animation: a frame plus the time it is shown (seconds). */
export class AnimationFrame {
    constructor(frame, duration) {
        this.frame = frame;
        this.duration = duration;
    }

    getDuration() {
        return this.duration;
    }

    setDuration(duration) {
        this.duration = duration;
    }

    toString() {
        if (this.duration < 0) {
            return `b [${this.frame.toSource()}]`;
        }
        return `${this.duration} [${this.frame.toSource()}]`;
    }
}

export class Animation {
    constructor() {
        this.frames = [];
        this.aniType = AnimationType.UNDEFINED;
        this.name = 'Unnamed animation';

        // Playback state (0 = stopped, 1 = forwards, -1 = backwards for yo-yo).
        this.playingState = 0;
        this.currentlyPlaying = 0;
        this.lastPlayingEndTime = 0;
        this.lastProcessing = 0;

        /**
         * Web-only addition: stop after one full cycle. Used by the SPACE
         * shortcut ("loop through the animation once") which the original
         * help text documents but never implemented.
         */
        this.oneShot = false;
    }

    toString() {
        return `${this.name} (${this.frames.length})`;
    }

    setName(name) {
        this.name = String(name).replace(/\[/g, '').replace(/\]/g, '');
    }

    getName() {
        return this.name;
    }

    setIsPlaying(isPlaying, now = performance.now()) {
        if (isPlaying && this.frames.length > 0) {
            this.playingState = 1;
            if (this.aniType !== AnimationType.BACKGROUND) {
                this.resetTimer(now);
            }
        } else {
            this.playingState = 0;
            this.oneShot = false;
        }
    }

    isPlaying() {
        return this.playingState !== 0;
    }

    resetTimer(now = performance.now()) {
        this.lastProcessing = now;
        this.currentlyPlaying = 0;
        if (this.frames.length > 0) {
            this.lastPlayingEndTime = now + this.frames[this.currentlyPlaying].duration * 1000;
        }
    }

    processAnimationDelta(now = performance.now()) {
        if (this.aniType !== AnimationType.BACKGROUND && this.frames.length > 0 && this.playingState !== 0) {
            this.lastProcessing = now;
            if (this.lastPlayingEndTime < now) {
                this.nextFrame(now);
            }
        }
    }

    nextFrame(now = performance.now()) {
        const count = this.frames.length;
        if (count === 0) {
            return;
        }
        if (this.aniType === AnimationType.CIRCULAR || this.aniType === AnimationType.TALK) {
            this.currentlyPlaying += 1;
            if (this.currentlyPlaying >= count) {
                this.currentlyPlaying = 0;
                if (this.oneShot) {
                    this.setIsPlaying(false);
                    return;
                }
            }
        } else if (this.aniType === AnimationType.RANDOM) {
            this.currentlyPlaying = Math.floor(Math.random() * count);
        } else if (this.aniType === AnimationType.YO_YO) {
            if (this.currentlyPlaying >= count - 1) {
                this.playingState = -1;
            } else if (this.currentlyPlaying === 0) {
                this.playingState = 1;
                if (this.oneShot) {
                    this.setIsPlaying(false);
                    return;
                }
            }
            this.currentlyPlaying = this.currentlyPlaying + this.playingState;
        }
        if (this.currentlyPlaying < 0 || this.currentlyPlaying >= count) {
            this.currentlyPlaying = 0;
        }
        const duration = this.frames[this.currentlyPlaying].duration;
        this.lastPlayingEndTime = this.lastProcessing + duration * 1000 - (this.lastProcessing - this.lastPlayingEndTime);
    }

    addFrame(frame, duration) {
        this.frames.push(new AnimationFrame(frame, duration));
    }

    addAnimationFrame(animationFrame) {
        this.frames.push(animationFrame);
    }
}

export class AnimationSystem {
    constructor() {
        /** @type {Frame[]} */
        this.frames = [];
        /** @type {Animation[]} */
        this.animations = [];
    }

    size() {
        return this.frames.length;
    }

    get(i) {
        return this.frames[i];
    }

    addElement(frame) {
        this.frames.push(frame);
    }

    addAnimation(animation) {
        this.animations.push(animation);
    }

    clear() {
        this.frames.length = 0;
        this.animations.length = 0;
    }

    /** Port of AnimationSystem.isVisible(). */
    isVisible(frame) {
        for (const animation of this.animations) {
            if (animation.playingState !== 0) {
                if (animation.aniType === AnimationType.BACKGROUND) {
                    if (animation.frames.some((af) => af.frame === frame)) {
                        return true;
                    }
                } else {
                    const current = animation.frames[animation.currentlyPlaying];
                    if (current && current.frame === frame) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
