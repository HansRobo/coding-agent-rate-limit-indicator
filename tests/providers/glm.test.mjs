import {test} from 'node:test';
import assert from 'node:assert/strict';

import {GlmProvider} from '../../src/providers/glm.js';

const provider = new GlmProvider();

test('identifies and orders five-hour, weekly, and monthly windows', () => {
    const result = provider._normalizeResponse({
        code: 200,
        data: {
            level: 'lite',
            limits: [
                // Deliberately out of display order to exercise the sort.
                {type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 10, usage: 100, currentValue: 10, nextResetTime: 1778503033976},
                {type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, usage: 200, currentValue: 80},
                {type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 25, usage: 500, currentValue: 125},
            ],
        },
    });

    assert.deepEqual(result.windows.map(w => w.id), ['five_hour', 'weekly', 'monthly']);
    assert.equal(result.windows[0].shortLabel, '5h');
    assert.equal(result.windows[0].utilization, 0.4);
    assert.equal(result.planName, 'lite');
});

test('skips unrecognized limit entries', () => {
    const result = provider._normalizeResponse({
        code: 200,
        data: {limits: [{type: 'UNKNOWN', unit: 9, number: 9, percentage: 50}]},
    });
    assert.equal(result.windows.length, 0);
});

test('throws on non-200 API codes', () => {
    assert.throws(() => provider._normalizeResponse({code: 401, msg: 'unauthorized'}));
});

test('_identifyWindow maps the documented type/unit/number combinations', () => {
    assert.equal(provider._identifyWindow({type: 'TOKENS_LIMIT', unit: 3, number: 5}).id, 'five_hour');
    assert.equal(provider._identifyWindow({type: 'TOKENS_LIMIT', unit: 6, number: 1}).id, 'weekly');
    assert.equal(provider._identifyWindow({type: 'TIME_LIMIT', unit: 5, number: 1}).id, 'monthly');
    assert.equal(provider._identifyWindow({type: 'TIME_LIMIT', unit: 1, number: 1}), null);
});
