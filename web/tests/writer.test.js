import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseAni } from '../js/parser.js';
import { formatDuration, generateSmil, serializeAni } from '../js/writer.js';
import { AnimationType } from '../js/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const chmmr = readFileSync(join(here, '..', 'examples', 'chmmr', 'chmmr.ani'), 'utf8');

test('formatDuration mimics Java Double.toString for common values', () => {
    assert.equal(formatDuration(1), '1.0');
    assert.equal(formatDuration(0.1), '0.1');
    assert.equal(formatDuration(0.25), '0.25');
    assert.equal(formatDuration(-1), '-1.0');
});

test('serializes frames first, then anidef lines, then aniframe lines', () => {
    const text = [
        'a.png -1 10 0 0',
        'b.png -1 10 -3 4',
        '#@ anidef 0 CIRCULAR [First]',
        '#@ aniframe 0 0.5 [a.png -1 10 0 0]',
    ].join('\n');

    const { system } = parseAni(text);
    const out = serializeAni(system).trimEnd().split('\n');

    assert.deepEqual(out, [
        'a.png -1 10 0 0',
        'b.png -1 10 -3 4',
        '#@ anidef 0 CIRCULAR [First]',
        '#@ aniframe 0 0.5 [a.png -1 10 0 0]',
    ]);
});

test('background durations are written as -1', () => {
    const text = 'a.png -1 10 0 0\n#@ anidef 0 BACKGROUND [bg]\n#@ aniframe 0 0.4 [a.png -1 10 0 0]\n';
    const { system } = parseAni(text);
    const out = serializeAni(system);
    assert.match(out, /#@ aniframe 0 -1\.0 \[a\.png -1 10 0 0\]/);
    assert.equal(system.animations[0].frames[0].duration, -1);
});

test('the chmmr example survives a parse -> serialize -> parse round trip', () => {
    const first = parseAni(chmmr);
    const serialized = serializeAni(first.system);
    const second = parseAni(serialized);

    assert.deepEqual(second.warnings, []);
    assert.equal(second.system.frames.length, first.system.frames.length);
    assert.equal(second.system.animations.length, first.system.animations.length);

    first.system.animations.forEach((animation, index) => {
        const other = second.system.animations[index];
        assert.equal(other.name, animation.name);
        assert.equal(other.aniType, animation.aniType);
        assert.equal(other.frames.length, animation.frames.length);
        other.frames.forEach((animationFrame, frameIndex) => {
            assert.equal(animationFrame.frame.toSource(), animation.frames[frameIndex].frame.toSource());
            assert.equal(animationFrame.duration, animation.frames[frameIndex].duration);
        });
    });

    // Serialising again must be byte-for-byte identical (stable output).
    assert.equal(serializeAni(second.system), serialized);
});

test('SMIL export contains regions, sequences and image references', () => {
    const text = [
        'a.png -1 10 0 0',
        'b.png -1 10 -5 6',
        '#@ anidef 0 BACKGROUND [bg]',
        '#@ aniframe 0 -1 [a.png -1 10 0 0]',
        '#@ anidef 1 YO_YO [yo]',
        '#@ aniframe 1 0.2 [b.png -1 10 -5 6]',
    ].join('\n');
    const { system } = parseAni(text);
    system.frames[0].width = 640;
    system.frames[0].height = 480;
    system.frames[1].width = 10;
    system.frames[1].height = 20;

    const smil = generateSmil(system, 1);
    assert.match(smil, /<smil xmlns="http:\/\/www.w3.org\/ns\/SMIL">/);
    assert.match(smil, /<region xml:id="a\.png" width="640" height="480" left="0" top="0" z-index="-1"\/>/);
    assert.match(smil, /<region xml:id="b\.png" width="10" height="20" left="-5" top="6" z-index="-1"\/>/);
    assert.match(smil, /<seq begin="0s" repeatCount="indefinite" > <!-- Animation: yo \(1\) -->/);
    assert.match(smil, /<par dur="0\.2s"><img src="b\.png" region="b\.png"\/><\/par>/);
    assert.match(smil, /<\/smil>/);

    const negated = generateSmil(system, -1);
    assert.match(negated, /left="5" top="-6"/);
});

test('yo-yo SMIL export plays the frames forwards and backwards', () => {
    const text = [
        'a.png -1 10 0 0',
        'b.png -1 10 0 0',
        'c.png -1 10 0 0',
        '#@ anidef 0 YO_YO [yo]',
        '#@ aniframe 0 0.1 [a.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [b.png -1 10 0 0]',
        '#@ aniframe 0 0.1 [c.png -1 10 0 0]',
    ].join('\n');
    const { system } = parseAni(text);
    const smil = generateSmil(system, 1);
    const sequence = [...smil.matchAll(/<img src="([abc])\.png"/g)].map((match) => match[1]);
    assert.deepEqual(sequence, ['a', 'b', 'c', 'c', 'b', 'a']);
});

test('SMIL export handles a random animation without frames', () => {
    const { system } = parseAni('a.png -1 10 0 0\n#@ anidef 0 RANDOM [r]\n');
    assert.equal(system.animations[0].aniType, AnimationType.RANDOM);
    const smil = generateSmil(system, 1);
    assert.match(smil, /<!-- Animation: r \(0\) -->/);
    assert.doesNotMatch(smil, /<img /);
});
