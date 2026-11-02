/*
 * Writers: .ani serialisation (MainFrame.saveFile()) and SMIL export
 * (SMILExporter.java).
 */

import { AnimationType } from './model.js';

/**
 * Mimic Java's Double.toString() for the values we write into the .ani file,
 * so that e.g. 1 is written as "1.0" and 0.25 stays "0.25".
 */
export function formatDuration(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return String(value);
    }
    if (Number.isInteger(number)) {
        return number.toFixed(1);
    }
    return String(number);
}

/**
 * Serialise the animation system to .ani text, including "#@" extension lines.
 * Port of MainFrame.saveFile().
 */
export function serializeAni(system) {
    const out = [];

    for (const frame of system.frames) {
        out.push(frame.toSource());
        frame.changed = false;
    }

    system.animations.forEach((animation, index) => {
        if (animation.aniType === AnimationType.BACKGROUND) {
            for (const animationFrame of animation.frames) {
                animationFrame.duration = -1;
            }
        }
        out.push(`#@ anidef ${index} ${animation.aniType} [${animation.name}]`);
    });

    system.animations.forEach((animation, index) => {
        for (const animationFrame of animation.frames) {
            out.push(`#@ aniframe ${index} ${formatDuration(animationFrame.duration)} [${animationFrame.frame.toSource()}]`);
        }
    });

    return `${out.join('\n')}\n`;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Generate a SMIL file for the current animation system.
 * Port of SMILExporter.java.
 *
 * Two long-standing bugs of the original exporter are fixed here:
 *  - regions use the real image size instead of the zoomed panel size;
 *  - YO_YO animations actually use the reversed frame list (the original
 *    built the reversed list but then iterated the original one again).
 *
 * @param {import('./model.js').AnimationSystem} system
 * @param {number} multiplier -1 to negate the offsets (communication screens), 1 otherwise.
 */
export function generateSmil(system, multiplier = 1) {
    const parts = [];

    parts.push('<?xml version="1.0"?>\n'
        + '<!DOCTYPE smil PUBLIC "-//W3C//DTD SMIL 3.0//EN"\n'
        + '                      "http://www.w3.org/2008/SMIL30/SMIL30Language.dtd">\n'
        + '<smil xmlns="http://www.w3.org/ns/SMIL">');

    parts.push('  <head>\n'
        + '    <meta name="title" content="UQMAnimationtool Generated File"/>\n'
        + '    <meta name="author" content="UQMAnimationtool"/>\n'
        + '    <layout>\n');

    for (const frame of system.frames) {
        const width = frame.width || 0;
        const height = frame.height || 0;
        parts.push(`<region xml:id="${escapeXml(frame.filename)}" width="${width}" height="${height}" left="${frame.xoff * multiplier}" top="${frame.yoff * multiplier}" z-index="-1"/>\n`);
    }

    parts.push('    </layout>\n'
        + '  </head>\n');

    parts.push('  <body>\n'
        + '  <par>\n');

    const genSeq = (animation) => `<seq begin="0s" repeatCount="indefinite" > <!-- Animation: ${escapeXml(animation.toString())} -->\n`;
    const genPar = (animationFrame) => {
        const dur = animationFrame.duration !== null && animationFrame.duration >= 0
            ? ` dur="${formatDuration(animationFrame.duration)}s"`
            : '';
        return `<par${dur}><img src="${escapeXml(animationFrame.frame.filename)}" region="${escapeXml(animationFrame.frame.filename)}"/></par>`;
    };

    for (const animation of system.animations) {
        if (animation.aniType === AnimationType.BACKGROUND) {
            for (const animationFrame of animation.frames) {
                animationFrame.duration = -1;
                parts.push(`${genPar(animationFrame)}\n`);
            }
        } else if (animation.aniType === AnimationType.CIRCULAR || animation.aniType === AnimationType.TALK) {
            parts.push(genSeq(animation));
            for (const animationFrame of animation.frames) {
                parts.push(`${genPar(animationFrame)}\n`);
            }
            parts.push('</seq>\n');
        } else if (animation.aniType === AnimationType.RANDOM) {
            parts.push(genSeq(animation));
            // Generate a 'random' list of frames large enough to look random to the player.
            for (let i = 0; i < 256; i++) {
                const randomFrame = animation.frames[Math.floor(Math.random() * animation.frames.length)];
                if (randomFrame) {
                    parts.push(`${genPar(randomFrame)}\n`);
                }
            }
            parts.push('</seq>\n');
        } else if (animation.aniType === AnimationType.YO_YO) {
            parts.push(genSeq(animation));
            for (const animationFrame of animation.frames) {
                parts.push(`${genPar(animationFrame)}\n`);
            }
            for (const animationFrame of [...animation.frames].reverse()) {
                parts.push(`${genPar(animationFrame)}\n`);
            }
            parts.push('</seq>\n');
        }
    }

    parts.push('  </par>\n'
        + '  </body>\n');

    parts.push('</smil>\n');

    return parts.join('');
}
