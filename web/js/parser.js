/*
 * Parser for UQM .ani files, including the "#@" UQMAnimationTool extension
 * lines. Direct port of MainFrame.parseFile() / parseLine() / parseExtline().
 */

import { Animation, AnimationSystem, AnimationType, Frame } from './model.js';

const TYPE_BY_KEYWORD = {
    talk: AnimationType.TALK,
    circular: AnimationType.CIRCULAR,
    random: AnimationType.RANDOM,
    yo_yo: AnimationType.YO_YO,
    background: AnimationType.BACKGROUND,
};

/**
 * Parse the text of a .ani file.
 *
 * @param {string} text
 * @returns {{system: AnimationSystem, warnings: string[]}}
 */
export function parseAni(text) {
    const system = new AnimationSystem();
    const warnings = [];
    const extLines = [];

    const lines = String(text).split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) {
            continue;
        }
        if (line.startsWith('#')) {
            if (line.startsWith('#@')) {
                // UQMAnimationTool extension line: parsed after all frames are known.
                extLines.push(line);
            }
            continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length < 5) {
            warnings.push(`Line ${i + 1}: expected "name split1 split2 xoff yoff", got [${line}]`);
            continue;
        }
        const numbers = parts.slice(1, 5).map((value) => Number(value));
        if (numbers.some((value) => !Number.isInteger(value))) {
            warnings.push(`Line ${i + 1}: not all coordinates are integers in [${line}]`);
            continue;
        }
        system.addElement(new Frame({
            filename: parts[0],
            split1: numbers[0],
            split2: numbers[1],
            xoff: numbers[2],
            yoff: numbers[3],
            path: parts[0],
        }));
    }

    for (const extLine of extLines) {
        try {
            parseExtline(extLine, system, warnings);
        } catch (error) {
            warnings.push(`Ignoring this line: [${extLine}] Message: [${error.message}]`);
        }
    }

    return { system, warnings };
}

/**
 * Parse a single "#@ ..." line. The original lowercases the whole line before
 * splitting (so keywords/types are case insensitive) but reads the animation
 * name from the original, non-lowercased line. That behaviour is preserved.
 */
function parseExtline(extLine, system, warnings) {
    const body = extLine.substring(2).trim();
    const parts = body.toLowerCase().split(/\s+/);
    const command = parts[0];

    if (command === 'anidef') {
        // #@ anidef $animationID $animationTYPE [$animationNAME]
        if (parts.length < 3) {
            warnings.push(`Too few arguments to anidef at ${body}`);
            return;
        }
        const aniID = Number.parseInt(parts[1], 10);
        if (!Number.isInteger(aniID) || aniID < 0) {
            warnings.push(`Invalid animation id in [${body}]`);
            return;
        }
        while (system.animations.length <= aniID) {
            system.addAnimation(new Animation());
        }
        const animation = system.animations[aniID];
        const type = TYPE_BY_KEYWORD[parts[2]];
        if (type) {
            animation.aniType = type;
        }

        const match = body.match(/\[.*\]/);
        if (match) {
            animation.setName(match[0].substring(1, match[0].length - 1));
        }
        return;
    }

    if (command === 'aniframe') {
        // #@ aniframe $animationID $frameDuration [$frame]
        if (parts.length < 4) {
            warnings.push(`Too few arguments to aniframe at ${body}`);
            return;
        }
        const aniID = Number.parseInt(parts[1], 10);
        if (!Number.isInteger(aniID) || system.animations.length <= aniID) {
            warnings.push(`Animation with index ${parts[1]} not found. Has it been declared previously?`);
            return;
        }
        const animation = system.animations[aniID];

        let duration = -1; // Default for BACKGROUND animations.
        if (animation.aniType !== AnimationType.BACKGROUND) {
            duration = Number(parts[2]);
            if (!Number.isFinite(duration)) {
                warnings.push(`Invalid duration "${parts[2]}" in [${body}]`);
                return;
            }
        }

        const match = body.match(/\[.*\]/);
        if (!match) {
            warnings.push('Invalid aniframe extension line');
            return;
        }
        const source = match[0].substring(1, match[0].length - 1);
        const frame = system.frames.find((candidate) => candidate.toSource() === source);
        if (!frame) {
            // Assigned to an animation, but not declared as a frame for UQM.
            warnings.push(`Nothing found for ${source}`);
            return;
        }
        animation.addFrame(frame, duration);
    }
}
