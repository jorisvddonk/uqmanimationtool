/*
 * Tests for the TZO animation exporter.
 *
 * Every exported program is executed on the *reference* TZO virtual machine
 * (the `tzo` npm package, the TypeScript implementation of the format) with the
 * same foreign functions that tzo-c's anim.c registers. That way the tests
 * verify the bytecode, not just the shape of the JSON.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { VM } from 'tzo/vm';

import { parseAni } from '../web/js/parser.js';
import { generateTzoProgram, TZO_MAX_TEXTURES } from '../web/js/tzo.js';
import { AnimationType } from '../web/js/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const chmmrAni = readFileSync(join(here, '..', 'examples', 'chmmr', 'chmmr.ani'), 'utf8');

/** Opcodes implemented by tzo-c (tzo.c) — the exporter must not use others. */
const TZO_C_OPCODES = new Set([
    'nop', 'pop', 'stdout', 'concat', 'rconcat', 'charCode', 'randInt',
    '+', 'plus', '-', 'min', '*', 'mul', 'eq', 'and', 'dup', 'gt', 'lt',
    'not', 'or', 'ppc', 'stacksize', 'jz', 'jgz', '{', '}', 'pause', 'exit',
    'goto', 'setContext', 'getContext', 'hasContext', 'delContext',
    // Foreign functions registered by anim.c.
    'loadImage', 'beginDraw', 'endDraw', 'drawFrame',
]);

/**
 * Boot a TZO VM with the foreign functions anim.c provides, recording every
 * call the program makes.
 */
function createHost() {
    const calls = {
        loads: [],
        frames: [],
        beginDraw: 0,
        endDraw: 0,
    };

    const vm = new VM({}, {
        loadImage: (stack) => {
            const path = stack.pop();
            const hotspotX = stack.pop();
            const hotspotY = stack.pop();
            calls.loads.push({ path, hotspotX, hotspotY });
        },
        beginDraw: () => {
            calls.beginDraw++;
        },
        endDraw: () => {
            calls.endDraw++;
        },
        drawFrame: (stack) => {
            calls.frames.push(stack.pop());
        },
    });

    return { vm, calls };
}

/**
 * Load an exported program into a fresh host. The first run() call executes the
 * init phase (loadImage + state) and stops at its `pause`.
 */
function boot(exported) {
    const host = createHost();
    host.vm.loadVMState(structuredClone(exported.state));
    host.vm.run();
    return host;
}

/** Run `count` animation frames and return the drawFrame calls per frame. */
function runFrames(host, count) {
    const frames = [];
    for (let i = 0; i < count; i++) {
        const start = host.calls.frames.length;
        host.vm.run();
        frames.push(host.calls.frames.slice(start));
    }
    return frames;
}

function systemFrom(text) {
    const { system, warnings } = parseAni(Array.isArray(text) ? text.join('\n') : text);
    assert.deepEqual(warnings, []);
    return system;
}

/** Two-frame circular animation with a background layer, 10 fps. */
function simpleSystem() {
    return systemFrom([
        'bg.png -1 10 0 0',
        'a.png -1 10 -64 -32',
        'b.png -1 10 -64 -32',
        'c.png -1 10 -64 -32',
        '#@ anidef 0 BACKGROUND [Background]',
        '#@ aniframe 0 -1 [bg.png -1 10 0 0]',
        '#@ anidef 1 CIRCULAR [Walk]',
        '#@ aniframe 1 0.1 [a.png -1 10 -64 -32]',
        '#@ aniframe 1 0.1 [b.png -1 10 -64 -32]',
        '#@ aniframe 1 0.1 [c.png -1 10 -64 -32]',
    ].join('\n'));
}

test('exports the tzo-c program structure', () => {
    const exported = generateTzoProgram(simpleSystem(), { fps: 10, pathPrefix: 'base/comm/test' });
    const { state } = exported;

    assert.deepEqual(Object.keys(state).sort(), [
        'context', 'exit', 'labelMap', 'pause', 'programCounter', 'programList', 'stack',
    ]);
    assert.deepEqual(state.context, {});
    assert.equal(state.exit, false);
    assert.equal(state.pause, false);
    assert.equal(state.programCounter, 0);
    assert.deepEqual(state.stack, []);

    const loopStart = state.labelMap.mainAnimationLoop;
    assert.equal(typeof loopStart, 'number');
    assert.equal(state.programList[loopStart].functionName, 'nop');

    // Every instruction must be one of the three standard representation types.
    for (const instruction of state.programList) {
        assert.ok(['push-number-instruction', 'push-string-instruction', 'invoke-function-instruction'].includes(instruction.type));
    }

    // And only opcodes that tzo-c implements may be used.
    const used = new Set(
        state.programList
            .filter((instruction) => instruction.type === 'invoke-function-instruction')
            .map((instruction) => instruction.functionName),
    );
    for (const functionName of used) {
        assert.ok(TZO_C_OPCODES.has(functionName), `opcode ${functionName} is not implemented by tzo-c`);
    }

    assert.equal(exported.stats.instructions, state.programList.length);
    assert.equal(exported.stats.textures, 4);
});

test('emits one loadImage call per unique frame, in .ani order, with hotspot offsets', () => {
    const exported = generateTzoProgram(simpleSystem(), { pathPrefix: 'base/comm/test/' });
    const { calls } = boot(exported);

    assert.deepEqual(calls.loads, [
        { path: 'base/comm/test/bg.png', hotspotX: 0, hotspotY: 0 },
        { path: 'base/comm/test/a.png', hotspotX: -64, hotspotY: -32 },
        { path: 'base/comm/test/b.png', hotspotX: -64, hotspotY: -32 },
        { path: 'base/comm/test/c.png', hotspotX: -64, hotspotY: -32 },
    ]);
    // The init phase must not draw anything yet.
    assert.deepEqual(calls.frames, []);
    assert.equal(calls.beginDraw, 0);
});

test('initialises the anim_anim_<i>_* context keys', () => {
    const exported = generateTzoProgram(simpleSystem(), { fps: 10 });
    const host = boot(exported);
    const { context } = host.vm;

    assert.equal(context.anim_anim_0_index, 0);
    assert.equal(context.anim_anim_0_active, 1);
    assert.equal(context.anim_anim_1_index, 0);
    assert.equal(context.anim_anim_1_active, 1);
    assert.equal(context.anim_anim_1_yy_direction, 1);
    assert.equal(context.anim_anim_1_tick, 0);
    assert.equal(context.mainAnimationLoop, undefined);
});

test('startPlaying=false leaves non-background animations stopped', () => {
    const exported = generateTzoProgram(simpleSystem(), { fps: 10, startPlaying: false });
    const host = boot(exported);
    assert.equal(host.vm.context.anim_anim_0_active, 1, 'backgrounds are always active');
    assert.equal(host.vm.context.anim_anim_1_active, 0);

    const frames = runFrames(host, 3);
    for (const drawn of frames) {
        assert.deepEqual(drawn, [0], 'only the background is drawn');
    }
});

test('circular animation draws every frame in order and loops', () => {
    const exported = generateTzoProgram(simpleSystem(), { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 7);

    // Each run draws: background (texture 0) + the current frame of animation 1.
    assert.deepEqual(frames, [
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 1],
    ]);
    assert.equal(host.calls.beginDraw, 7);
    assert.equal(host.calls.endDraw, 7);
});

test('frame durations are honoured via the tick counter', () => {
    // 0.2s per frame at 10 iterations/second = advance every 2 iterations.
    const system = systemFrom([
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        '#@ anidef 0 CIRCULAR [Slow]',
        '#@ aniframe 0 0.2 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.2 [b.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 6);

    assert.deepEqual(frames, [[0], [0], [1], [1], [0], [0]]);
});

test('per-frame durations are honoured when they differ', () => {
    const system = systemFrom([
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        '#@ anidef 0 CIRCULAR [Mixed]',
        '#@ aniframe 0 0.1 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.3 [b.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);

    assert.equal(host.vm.context.anim_anim_0_step, 1);
    const frames = runFrames(host, 8);
    assert.deepEqual(frames, [[0], [1], [1], [1], [0], [1], [1], [1]]);
    // The step value follows the current frame.
    assert.equal(host.vm.context.anim_anim_0_step, 3);
});

test('yo-yo animation bounces at both ends', () => {
    const system = systemFrom([
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        'c.png -1 10 0 0',
        '#@ anidef 0 YO_YO [Bounce]',
        '#@ aniframe 0 0.1 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [b.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [c.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 9).map((drawn) => drawn[0]);

    assert.deepEqual(frames, [0, 1, 2, 1, 0, 1, 2, 1, 0]);
    assert.equal(host.vm.context.anim_anim_0_index, 1);
});

test('random animation always draws a frame within range', () => {
    const system = systemFrom([
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        'c.png -1 10 0 0',
        '#@ anidef 0 RANDOM [Flicker]',
        '#@ aniframe 0 0.1 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [b.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [c.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 40).map((drawn) => drawn[0]);

    for (const index of frames) {
        assert.ok(index >= 0 && index <= 2, `frame ${index} out of range`);
    }
    // Over 40 frames all three frames should have been picked at least once.
    assert.deepEqual([...new Set(frames)].sort(), [0, 1, 2]);
});

test('talk animations behave like circular animations', () => {
    const system = systemFrom([
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        '#@ anidef 0 TALK [Talk]',
        '#@ aniframe 0 0.1 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [b.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 5).map((drawn) => drawn[0]);
    assert.deepEqual(frames, [0, 1, 0, 1, 0]);
});

test('background animations draw all of their frames every iteration', () => {
    const system = systemFrom([
        'bg1.png -1 10 0 0',
        'bg2.png -1 10 -10 -10',
        'a.png -1 10 0 0',
        '#@ anidef 0 BACKGROUND [Layers]',
        '#@ aniframe 0 -1 [bg1.png -1 10 0 0]',
        '#@ aniframe 0 -1 [bg2.png -1 10 -10 -10]',
        '#@ anidef 1 CIRCULAR [Anim]',
        '#@ aniframe 1 0.1 [a.png -1 10 0 0]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    const host = boot(exported);
    const frames = runFrames(host, 3);

    assert.deepEqual(frames, [[0, 1, 2], [0, 1, 2], [0, 1, 2]]);
    // Backgrounds are never advanced.
    assert.equal(host.vm.context.anim_anim_0_index, 0);
});

test('identical frames are deduplicated into one texture', () => {
    const system = systemFrom([
        'a.png -1 10 -5 -5',
        'a.png -1 10 -5 -5',
        'b.png -1 10 -5 -5',
        '#@ anidef 0 CIRCULAR [Dupes]',
        '#@ aniframe 0 0.1 [a.png -1 10 -5 -5]',
        '#@ aniframe 0 0.1 [a.png -1 10 -5 -5]',
        '#@ aniframe 0 0.1 [b.png -1 10 -5 -5]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10 });
    assert.equal(exported.textures.length, 2);

    const host = boot(exported);
    assert.deepEqual(host.calls.loads.map((load) => load.path), ['a.png', 'b.png']);
    // Both duplicate animation entries refer to texture 0.
    const frames = runFrames(host, 3).map((drawn) => drawn[0]);
    assert.deepEqual(frames, [0, 0, 1]);
});

test('dedupe can be turned off', () => {
    const system = systemFrom([
        'a.png -1 10 -5 -5',
        'a.png -1 10 -5 -5',
        '#@ anidef 0 CIRCULAR [Dupes]',
        '#@ aniframe 0 0.1 [a.png -1 10 -5 -5]',
    ]);
    const exported = generateTzoProgram(system, { fps: 10, dedupe: false });
    assert.equal(exported.textures.length, 2);
});

test('active=-1 draws one more frame and then stops (host control)', () => {
    const exported = generateTzoProgram(simpleSystem(), { fps: 10 });
    const host = boot(exported);

    // Stop animation 1 after the next draw.
    host.vm.context.anim_anim_1_active = -1;
    const frames = runFrames(host, 3);

    assert.deepEqual(frames[0], [0, 1], 'the current frame is drawn once more');
    assert.deepEqual(frames[1], [0], 'after that the animation is stopped');
    assert.deepEqual(frames[2], [0]);
    assert.equal(host.vm.context.anim_anim_1_active, 0);
});

test('the chmmr example exports and plays on the reference VM', () => {
    const { system } = parseAni(chmmrAni);
    const exported = generateTzoProgram(system, {
        fps: 30,
        pathPrefix: 'base/comm/chmmr/',
    });

    assert.equal(exported.textures.length, 85);
    assert.equal(exported.state.labelMap.mainAnimationLoop > 0, true);
    assert.deepEqual(exported.warnings, []);

    const host = boot(exported);
    assert.equal(host.calls.loads.length, 85);
    assert.equal(host.calls.loads[0].path, 'base/comm/chmmr/chmmr.0.png');
    assert.deepEqual(
        { x: host.calls.loads[1].hotspotX, y: host.calls.loads[1].hotspotY },
        { x: -36, y: -54 },
    );

    const frames = runFrames(host, 10);
    // 8 animations (1 background + 7 playing), so 8 frames drawn per iteration.
    for (const drawn of frames) {
        assert.equal(drawn.length, 8, `expected 8 drawn frames, got ${JSON.stringify(drawn)}`);
        assert.equal(drawn[0], 0, 'the background is drawn first');
    }

    // The background (animation 0) is a single frame; animations 1..7 advance.
    const indices = host.vm.context;
    assert.equal(indices.anim_anim_0_index, 0);
    for (let i = 1; i <= 7; i++) {
        assert.ok(indices[`anim_anim_${i}_index`] >= 0);
        assert.ok(indices[`anim_anim_${i}_index`] < system.animations[i].frames.length);
    }
});

test('warns when the texture limit of tzo-c is exceeded', () => {
    const lines = [];
    for (let i = 0; i < TZO_MAX_TEXTURES + 2; i++) {
        lines.push(`frame${i}.png -1 10 ${i} 0`);
    }
    const system = systemFrom(lines.join('\n'));
    const exported = generateTzoProgram(system, { fps: 30 });
    assert.equal(exported.warnings.length, 1);
    assert.match(exported.warnings[0], /MAX_TEXTURES/);
});

test('handles an empty project and animations without frames', () => {
    const empty = generateTzoProgram({ frames: [], animations: [] }, {});
    assert.equal(empty.state.programList.length > 0, true);
    const host = boot(empty);
    assert.deepEqual(host.calls.loads, []);
    assert.deepEqual(runFrames(host, 2), [[], []]);

    const system = systemFrom('a.png -1 10 0 0\n#@ anidef 0 CIRCULAR [Empty]\n');
    const exported = generateTzoProgram(system, { fps: 30 });
    const withEmpty = boot(exported);
    assert.deepEqual(runFrames(withEmpty, 2), [[], []]);
});

test('undefined animation types fall back to circular with a warning', async () => {
    const { system } = parseAni('a.png -1 10 0 0\nb.png -1 10 0 0\n');
    const { Animation } = await import('../web/js/model.js');
    const animation = new Animation(); // UNDEFINED by default
    animation.addFrame(system.frames[0], 0.1);
    animation.addFrame(system.frames[1], 0.1);
    system.animations.push(animation);

    const exported = generateTzoProgram(system, { fps: 10 });
    assert.equal(animation.aniType, AnimationType.UNDEFINED);
    assert.equal(exported.warnings.length, 1);
    assert.match(exported.warnings[0], /no type/);

    const host = boot(exported);
    assert.deepEqual(runFrames(host, 4).map((drawn) => drawn[0]), [0, 1, 0, 1]);
});
