/*
 * Exporter for the TZO "animation extension" program format used by
 * tzo-c's anim.c (https://github.com/jorisvddonk/tzo-c/blob/main/anim.c).
 *
 * The host registers four foreign functions:
 *   loadImage(hotspotY, hotspotX, path)   - pops path, then hotspotX, then hotspotY
 *   beginDraw()
 *   endDraw()
 *   drawFrame(textureIndex)
 *
 * and keeps per-animation state in the TZO context:
 *   anim_anim_<i>_index         current frame index
 *   anim_anim_<i>_active        0 = stopped, 1 = playing, -1 = draw once more then stop
 *   anim_anim_<i>_yy_direction  1 or -1 (yo-yo animations only)
 *   anim_anim_<i>_tick          loop counter used to honour frame durations
 *   anim_anim_<i>_step          frames-to-wait for the current frame (only when durations differ)
 *
 * Program layout (same shape as tzo-c's yehat.json):
 *   1. loadImage calls for every (unique) frame
 *   2. setContext calls initialising the animation state
 *   3. pause                    <- host can now prepare its blit buffer
 *   4. mainAnimationLoop: beginDraw, draw frames, endDraw, advance animations,
 *      clear finished (-1) animations, pause, goto mainAnimationLoop
 */

import { AnimationType } from './model.js';

export const TZO_DEFAULT_FPS = 30;
export const TZO_MAX_TEXTURES = 128; // MAX_TEXTURES in tzo-c's anim.c
export const TZO_LOOP_LABEL = 'mainAnimationLoop';

const CONTEXT_PREFIX = 'anim_anim_';

/** Small helper that keeps the emitted instruction list readable. */
class ProgramBuilder {
    constructor() {
        this.program = [];
    }

    get length() {
        return this.program.length;
    }

    pushNumber(value, comment) {
        this.program.push(withComment({ type: 'push-number-instruction', value }, comment));
        return this;
    }

    pushString(value, comment) {
        this.program.push(withComment({ type: 'push-string-instruction', value }, comment));
        return this;
    }

    invoke(functionName, comment) {
        this.program.push(withComment({ type: 'invoke-function-instruction', functionName }, comment));
        return this;
    }

    /** Emit `if (condition) { body }` using the jgz/{ } idiom of TZO. */
    ifBlock(condition, body) {
        condition(this);
        this.invoke('jgz');
        this.invoke('{');
        body(this);
        this.invoke('}');
        return this;
    }
}

function withComment(instruction, comment) {
    if (comment) {
        instruction.comment = comment;
    }
    return instruction;
}

function contextKey(animationIndex, suffix) {
    return `${CONTEXT_PREFIX}${animationIndex}_${suffix}`;
}

function normalizePrefix(prefix) {
    const value = String(prefix || '').trim().replace(/\\/g, '/');
    if (!value) {
        return '';
    }
    return value.endsWith('/') ? value : `${value}/`;
}

function stepsForDuration(duration, fps) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return 1;
    }
    return Math.max(1, Math.round(seconds * fps));
}

/**
 * Build a TZO program (the JSON "VM state" representation) that plays the
 * animations of an AnimationSystem.
 *
 * @param {import('./model.js').AnimationSystem} system
 * @param {object} [options]
 * @param {string} [options.pathPrefix] prefix for every image path, e.g. "base/comm/chmmr/"
 * @param {number} [options.fps] number of host iterations per second (anim.c runs at ~30)
 * @param {boolean} [options.startPlaying] start non-background animations immediately
 * @param {boolean} [options.dedupe] reuse one texture for identical frames
 * @param {string} [options.label] label of the main loop
 * @returns {{state: object, warnings: string[], stats: object, textures: Array}}
 */
export function generateTzoProgram(system, options = {}) {
    const {
        pathPrefix = '',
        fps = TZO_DEFAULT_FPS,
        startPlaying = true,
        dedupe = true,
        label = TZO_LOOP_LABEL,
    } = options;

    const frameRate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : TZO_DEFAULT_FPS;
    const prefix = normalizePrefix(pathPrefix);
    const warnings = [];
    const builder = new ProgramBuilder();

    /* ---------------------------------------------------------------- */
    /* 1. Textures: one loadImage call per unique frame                  */
    /* ---------------------------------------------------------------- */
    const textures = [];
    const textureByKey = new Map();
    const textureIndexByFrame = new Map();

    for (const frame of system.frames) {
        const key = dedupe
            ? `${frame.filename}\u0000${frame.xoff}\u0000${frame.yoff}`
            : `#${textures.length}`;
        let index = textureByKey.get(key);
        if (index === undefined) {
            index = textures.length;
            textureByKey.set(key, index);
            textures.push({ frame, index, path: `${prefix}${frame.filename}` });
        }
        textureIndexByFrame.set(frame, index);
    }

    if (textures.length > TZO_MAX_TEXTURES) {
        warnings.push(
            `This project uses ${textures.length} textures; tzo-c's anim.c only supports ${TZO_MAX_TEXTURES} `
            + '(MAX_TEXTURES). Raise that limit in the host, or split the animation.',
        );
    }

    for (const texture of textures) {
        const { frame, path } = texture;
        builder.pushNumber(frame.yoff, `hotspot y of ${frame.filename}`);
        builder.pushNumber(frame.xoff);
        builder.pushString(path);
        builder.invoke('loadImage');
    }

    /* ---------------------------------------------------------------- */
    /* 2. Initial animation state                                       */
    /* ---------------------------------------------------------------- */
    const animations = system.animations.map((animation, index) => {
        const steps = animation.frames.map((animationFrame) => stepsForDuration(animationFrame.duration, frameRate));
        const uniformSteps = steps.length > 0 && steps.every((value) => value === steps[0]);
        return { animation, index, steps, uniformSteps, key: (suffix) => contextKey(index, suffix) };
    });

    for (const entry of animations) {
        const { animation, key } = entry;
        builder.pushNumber(0);
        builder.pushString(key('index'));
        builder.invoke('setContext');

        const initialActive = animation.aniType === AnimationType.BACKGROUND || startPlaying ? 1 : 0;
        builder.pushNumber(initialActive);
        builder.pushString(key('active'), `${animation.name} (${animation.aniType})`);
        builder.invoke('setContext');

        if (animation.aniType !== AnimationType.BACKGROUND) {
            builder.pushNumber(1);
            builder.pushString(key('yy_direction'));
            builder.invoke('setContext');

            if (animation.frames.length > 0) {
                builder.pushNumber(0);
                builder.pushString(key('tick'));
                builder.invoke('setContext');
                if (!entry.uniformSteps) {
                    builder.pushNumber(entry.steps[0]);
                    builder.pushString(key('step'));
                    builder.invoke('setContext');
                }
            }
        }

        if (animation.aniType === AnimationType.UNDEFINED) {
            warnings.push(`Animation "${animation.name}" has no type; it is exported as CIRCULAR.`);
        }
    }

    builder.invoke('pause', 'all textures and animation state are ready');

    /* ---------------------------------------------------------------- */
    /* 3. Main loop                                                     */
    /* ---------------------------------------------------------------- */
    const loopStart = builder.length;
    builder.invoke('nop', `main animation loop (${label})`);

    // Draw first, then advance: this way the first frame of every animation is
    // visible for a full frame duration before the animation moves on.
    builder.invoke('beginDraw');
    for (const entry of drawOrder(animations, textureIndexByFrame)) {
        emitDraw(builder, entry, textureIndexByFrame);
    }
    builder.invoke('endDraw');

    for (const entry of animations) {
        if (entry.animation.aniType === AnimationType.BACKGROUND || entry.animation.frames.length === 0) {
            continue;
        }
        emitAdvance(builder, entry, frameRate);
    }

    for (const entry of animations) {
        const { key } = entry;
        builder.pushString(key('active'));
        builder.invoke('getContext');
        builder.pushNumber(-1);
        builder.invoke('eq');
        builder.invoke('jgz');
        builder.invoke('{');
        builder.pushNumber(0);
        builder.pushString(key('active'));
        builder.invoke('setContext');
        builder.invoke('}');
    }

    builder.invoke('pause');
    builder.pushString(label);
    builder.invoke('goto');

    const state = {
        context: {},
        exit: false,
        pause: false,
        labelMap: { [label]: loopStart },
        programList: builder.program,
        programCounter: 0,
        stack: [],
    };

    return {
        state,
        warnings,
        textures,
        stats: {
            instructions: builder.program.length,
            textures: textures.length,
            frames: system.frames.length,
            animations: system.animations.length,
            fps: frameRate,
            loopStart,
        },
    };
}

/* ---------------------------------------------------------------------- */
/* Code generation helpers                                                */
/* ---------------------------------------------------------------------- */

function emitAdvance(builder, entry, frameRate) {
    const { animation, key, steps, uniformSteps } = entry;
    const count = animation.frames.length;

    // Stopped animations do not advance (the host can restart them later).
    builder.ifBlock(
        (b) => {
            b.pushString(key('active'));
            b.invoke('getContext');
            b.pushNumber(0);
            b.invoke('eq');
            b.invoke('not');
        },
        (b) => {
            if (!uniformSteps) {
                // Store the number of ticks the *current* frame has to be shown for.
                for (let index = 0; index < count; index++) {
                    b.ifBlock(
                        (inner) => {
                            inner.pushString(key('index'));
                            inner.invoke('getContext');
                            inner.pushNumber(index);
                            inner.invoke('eq');
                        },
                        (inner) => {
                            inner.pushNumber(steps[index]);
                            inner.pushString(key('step'));
                            inner.invoke('setContext');
                        },
                    );
                }
            }

            // tick++
            b.pushString(key('tick'));
            b.invoke('getContext');
            b.pushNumber(1);
            b.invoke('+');
            b.pushString(key('tick'));
            b.invoke('setContext');

            const ticksNeeded = (inner) => {
                if (uniformSteps) {
                    inner.pushNumber(steps[0]);
                } else {
                    inner.pushString(key('step'));
                    inner.invoke('getContext');
                }
                inner.pushString(key('tick'));
                inner.invoke('getContext');
                inner.invoke('lt');   // tick < needed
                inner.invoke('not');  // tick >= needed
            };

            b.ifBlock(ticksNeeded, (inner) => {
                inner.pushNumber(0);
                inner.pushString(key('tick'));
                inner.invoke('setContext');
                emitNextFrame(inner, entry, frameRate);
            });
        },
    );
}

function emitNextFrame(builder, entry) {
    const { animation, key } = entry;
    const count = animation.frames.length;

    switch (animation.aniType) {
        case AnimationType.RANDOM:
            builder.pushNumber(count);
            builder.invoke('randInt');
            builder.pushString(key('index'));
            builder.invoke('setContext');
            return;

        case AnimationType.YO_YO: {
            if (count < 2) {
                // Nothing to bounce between.
                return;
            }
            // direction = 1 at the last frame -> go backwards
            builder.ifBlock(
                (b) => {
                    b.pushString(key('yy_direction'));
                    b.invoke('getContext');
                    b.pushNumber(1);
                    b.invoke('eq');
                    b.pushString(key('index'));
                    b.invoke('getContext');
                    b.pushNumber(count - 1);
                    b.invoke('eq');
                    b.invoke('and');
                },
                (b) => {
                    b.pushNumber(-1);
                    b.pushString(key('yy_direction'));
                    b.invoke('setContext');
                },
            );
            // direction = -1 at the first frame -> go forwards
            builder.ifBlock(
                (b) => {
                    b.pushString(key('yy_direction'));
                    b.invoke('getContext');
                    b.pushNumber(-1);
                    b.invoke('eq');
                    b.pushString(key('index'));
                    b.invoke('getContext');
                    b.pushNumber(0);
                    b.invoke('eq');
                    b.invoke('and');
                },
                (b) => {
                    b.pushNumber(1);
                    b.pushString(key('yy_direction'));
                    b.invoke('setContext');
                },
            );
            // index += direction
            builder.pushString(key('yy_direction'));
            builder.invoke('getContext');
            builder.pushString(key('index'));
            builder.invoke('getContext');
            builder.invoke('+');
            builder.pushString(key('index'));
            builder.invoke('setContext');
            return;
        }

        case AnimationType.CIRCULAR:
        case AnimationType.TALK:
        case AnimationType.UNDEFINED:
        default: {
            // index = (index + 1) % count
            builder.pushString(key('index'));
            builder.invoke('getContext');
            builder.pushNumber(1);
            builder.invoke('+');
            builder.pushString(key('index'));
            builder.invoke('setContext');
            builder.ifBlock(
                (b) => {
                    b.pushString(key('index'));
                    b.invoke('getContext');
                    b.pushNumber(count);
                    b.invoke('eq');
                },
                (b) => {
                    b.pushNumber(0);
                    b.pushString(key('index'));
                    b.invoke('setContext');
                },
            );
        }
    }
}

/**
 * Background animations are static layers and are always fully drawn, other
 * animations draw only their current frame. Draw order follows the frame order
 * of the .ani file (so higher frame numbers end up on top), with backgrounds
 * first.
 */
function drawOrder(animations, textureIndexByFrame) {
    const minFrameIndex = (entry) => {
        let min = Number.POSITIVE_INFINITY;
        for (const animationFrame of entry.animation.frames) {
            const textureIndex = textureIndexByFrame.get(animationFrame.frame);
            if (textureIndex !== undefined && textureIndex < min) {
                min = textureIndex;
            }
        }
        return Number.isFinite(min) ? min : Number.POSITIVE_INFINITY;
    };

    return [...animations].sort((a, b) => {
        const aBackground = a.animation.aniType === AnimationType.BACKGROUND ? 0 : 1;
        const bBackground = b.animation.aniType === AnimationType.BACKGROUND ? 0 : 1;
        if (aBackground !== bBackground) {
            return aBackground - bBackground;
        }
        return minFrameIndex(a) - minFrameIndex(b);
    });
}

function emitDraw(builder, entry, textureIndexByFrame) {
    const { animation, key } = entry;
    const frames = animation.frames.filter((animationFrame) => textureIndexByFrame.has(animationFrame.frame));
    if (frames.length === 0) {
        return;
    }

    const isBackground = animation.aniType === AnimationType.BACKGROUND;

    builder.ifBlock(
        (b) => {
            b.pushString(key('active'));
            b.invoke('getContext');
            b.pushNumber(0);
            b.invoke('eq');
            b.invoke('not');
        },
        (b) => {
            if (isBackground) {
                // Every background frame is a static layer: draw them all.
                for (const animationFrame of frames) {
                    b.pushNumber(textureIndexByFrame.get(animationFrame.frame));
                    b.invoke('drawFrame');
                }
                return;
            }
            for (let index = 0; index < animation.frames.length; index++) {
                const animationFrame = animation.frames[index];
                const textureIndex = textureIndexByFrame.get(animationFrame.frame);
                if (textureIndex === undefined) {
                    continue;
                }
                b.ifBlock(
                    (inner) => {
                        inner.pushString(key('index'));
                        inner.invoke('getContext');
                        inner.pushNumber(index);
                        inner.invoke('eq');
                    },
                    (inner) => {
                        inner.pushNumber(textureIndex);
                        inner.invoke('drawFrame');
                    },
                );
            }
        },
    );
}
