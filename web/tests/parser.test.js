import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseAni } from '../js/parser.js';
import { AnimationType } from '../js/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const chmmr = readFileSync(join(here, '..', 'examples', 'chmmr', 'chmmr.ani'), 'utf8');

test('parses the bundled chmmr example', () => {
    const { system, warnings } = parseAni(chmmr);

    assert.deepEqual(warnings, []);
    assert.equal(system.frames.length, 85);
    assert.equal(system.animations.length, 8);

    assert.equal(system.frames[0].filename, 'chmmr.0.png');
    assert.equal(system.frames[0].split1, -1);
    assert.equal(system.frames[0].split2, 10);
    assert.equal(system.frames[0].xoff, 0);
    assert.equal(system.frames[0].yoff, 0);

    assert.equal(system.frames[1].xoff, -36);
    assert.equal(system.frames[1].yoff, -54);

    const [background, random, star1] = system.animations;
    assert.equal(background.aniType, AnimationType.BACKGROUND);
    assert.equal(background.name, 'Static background');
    assert.equal(background.frames.length, 1);
    assert.equal(background.frames[0].duration, -1);

    assert.equal(random.aniType, AnimationType.RANDOM);
    assert.equal(random.name, 'Lightning bolts');
    assert.equal(random.frames.length, 11);
    assert.equal(random.frames[0].duration, 0.1);

    assert.equal(star1.aniType, AnimationType.CIRCULAR);
    assert.equal(star1.name, 'Star 1');
    assert.equal(star1.frames.length, 5);

    const total = system.animations.reduce((sum, animation) => sum + animation.frames.length, 0);
    assert.equal(total, 84);
});

test('parses comments, blank lines and mixed line endings', () => {
    const text = [
        '# a plain comment',
        '',
        'foo.0.png -1 10 0 0',
        '   ',
        '#@ anidef 0 yo_yo [Yo]',
        'foo.1.png -1 10 -4 5',
        '#@ aniframe 0 0.25 [foo.0.png -1 10 0 0]',
        '#@ aniframe 0 1.5 [foo.1.png -1 10 -4 5]',
    ].join('\r\n');

    const { system, warnings } = parseAni(text);
    assert.deepEqual(warnings, []);
    assert.equal(system.frames.length, 2);
    assert.equal(system.animations.length, 1);
    assert.equal(system.animations[0].aniType, AnimationType.YO_YO);
    assert.equal(system.animations[0].name, 'Yo');
    assert.equal(system.animations[0].frames.length, 2);
    assert.equal(system.animations[0].frames[1].duration, 1.5);
});

test('animation names keep their original casing but keywords are case insensitive', () => {
    const text = 'a.png -1 10 0 0\n#@ ANIDEF 0 Circular [MixedCase Name]\n';
    const { system } = parseAni(text);
    assert.equal(system.animations[0].aniType, AnimationType.CIRCULAR);
    assert.equal(system.animations[0].name, 'MixedCase Name');
});

test('reports unknown frames referenced by aniframe', () => {
    const text = 'a.png -1 10 0 0\n#@ anidef 0 CIRCULAR [x]\n#@ aniframe 0 0.1 [missing.png -1 10 0 0]\n';
    const { system, warnings } = parseAni(text);
    assert.equal(system.animations[0].frames.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Nothing found for missing\.png/);
});

test('reports aniframe lines for undeclared animations', () => {
    const text = 'a.png -1 10 0 0\n#@ aniframe 3 0.1 [a.png -1 10 0 0]\n';
    const { system, warnings } = parseAni(text);
    assert.equal(system.animations.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Animation with index 3 not found/);
});

test('reports malformed frame lines instead of throwing', () => {
    const text = 'this is not a frame\nbroken.png -1 10 nope 0\ngood.png -1 10 1 2\n';
    const { system, warnings } = parseAni(text);
    assert.equal(system.frames.length, 1);
    assert.equal(system.frames[0].filename, 'good.png');
    assert.equal(warnings.length, 2);
});

test('ignores anidef lines with too few arguments', () => {
    const { system, warnings } = parseAni('a.png -1 10 0 0\n#@ anidef 0\n');
    assert.equal(system.animations.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Too few arguments to anidef/);
});
