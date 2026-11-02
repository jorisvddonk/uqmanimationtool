/*
 * Dev helper: export an .ani file to a TZO animation program and run it on the
 * reference TZO VM, printing what each simulated frame draws.
 *
 * Usage:
 *   node tzo-trace.mjs ../examples/chmmr/chmmr.ani [frames] [prefix]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { VM } from 'tzo/vm';

import { parseAni } from '../web/js/parser.js';
import { generateTzoProgram } from '../web/js/tzo.js';

const file = process.argv[2] || '../examples/chmmr/chmmr.ani';
const frameCount = Number(process.argv[3] || 8);
const prefix = process.argv[4] || '';

const { system, warnings } = parseAni(readFileSync(file, 'utf8'));
if (warnings.length > 0) {
    console.warn(`parse warnings:\n  ${warnings.join('\n  ')}`);
}

const exported = generateTzoProgram(system, { pathPrefix: prefix, fps: 30 });
console.log(`${basename(file)}: ${system.frames.length} frames, ${system.animations.length} animations`);
console.log(`export: ${exported.stats.instructions} instructions, ${exported.stats.textures} textures, `
    + `loop at ${exported.stats.loopStart}, ${JSON.stringify(exported.state).length} bytes of JSON`);
for (const warning of exported.warnings) {
    console.warn(`warning: ${warning}`);
}

let drawFrame = [];
const vm = new VM({}, {
    loadImage: (stack) => {
        const path = stack.pop();
        const hotspotX = stack.pop();
        const hotspotY = stack.pop();
        console.log(`  loadImage(${JSON.stringify(path)}, hotspot=${hotspotX},${hotspotY})`);
    },
    beginDraw: () => {
        drawFrame = [];
    },
    endDraw: () => {},
    drawFrame: (stack) => {
        drawFrame.push(stack.pop());
    },
});

vm.loadVMState(structuredClone(exported.state));
vm.run(); // init: load textures, set state, pause

console.log('\nframe | drawn texture indices          | anim indices');
console.log('------+---------------------------------+---------------------------------');
for (let frame = 0; frame < frameCount; frame++) {
    vm.run();
    const indices = system.animations
        .map((animation, index) => `${index}:${vm.context[`anim_anim_${index}_index`]}`)
        .join(' ');
    console.log(`${String(frame).padStart(5)} | ${drawFrame.join(', ').padEnd(31)} | ${indices}`);
}
