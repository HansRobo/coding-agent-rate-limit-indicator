import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ClaudeProvider} from '../../src/providers/claude.js';

const provider = new ClaudeProvider();

test('normalizes five-hour and seven-day windows with percent scaling', () => {
    const result = provider._normalizeResponse({
        five_hour: {utilization: 42.5, resets_at: '2026-04-11T18:00:00Z'},
        seven_day: {utilization: 15.2, resets_at: '2026-04-14T00:00:00Z'},
    });

    assert.equal(result.windows.length, 2);
    const [five, seven] = result.windows;
    assert.equal(five.id, 'five_hour');
    assert.equal(five.shortLabel, '5h');
    assert.ok(Math.abs(five.utilization - 0.425) < 1e-9);
    assert.equal(seven.id, 'seven_day');
    assert.equal(seven.shortLabel, '7d');
    assert.equal(result.planName, null);
});

test('omits windows that are absent from the response', () => {
    const result = provider._normalizeResponse({five_hour: {utilization: 0}});
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].id, 'five_hour');
});
