import {test} from 'node:test';
import assert from 'node:assert/strict';

import {CodexProvider} from '../../src/providers/codex.js';

const provider = new CodexProvider();

test('normalizes structured primary and weekly windows', () => {
    const result = provider._normalizeResponse({
        rate_limit: {
            primary_window: {used_percent: 50, resets_at: '2026-04-11T18:00:00Z'},
            secondary_window: {used_percent: 20},
        },
        plan_type: 'pro',
    });

    assert.equal(result.windows.length, 2);
    const [primary, weekly] = result.windows;
    assert.equal(primary.id, 'primary');
    assert.equal(primary.shortLabel, '5h');
    assert.equal(primary.utilization, 0.5);
    assert.ok(primary.resetsAt instanceof Date);
    assert.equal(weekly.id, 'weekly');
    assert.equal(weekly.shortLabel, '7d');
    assert.equal(result.planName, 'pro');
});

test('extracts plan name from tier when plan_type is absent', () => {
    const result = provider._normalizeResponse({
        rate_limit: {primary_window: {used_percent: 10}},
        tier: 'plus',
    });
    assert.equal(result.planName, 'plus');
});

test('does not mistake a generic "type" field for a plan name', () => {
    // Regression: _findDeep(data, 'type') used to surface 'TOKENS_LIMIT'.
    const result = provider._normalizeResponse({
        rate_limit: {primary_window: {type: 'TOKENS_LIMIT', used_percent: 30}},
    });
    assert.equal(result.planName, null);
});

test('flat fallback window carries a shortLabel', () => {
    // Regression: the flat window used to omit shortLabel, yielding a '??' panel.
    const result = provider._normalizeResponse({used: 100, limit: 200});
    assert.equal(result.windows.length, 1);
    const [win] = result.windows;
    assert.equal(win.id, 'primary');
    assert.equal(win.utilization, 0.5);
    assert.equal(typeof win.shortLabel, 'string');
    assert.ok(win.shortLabel.length > 0);
});

test('_findFirstNumeric returns the first numeric candidate', () => {
    assert.equal(provider._findFirstNumeric({a: 'x', b: 5, c: 9}, ['a', 'b', 'c']), 5);
    assert.equal(provider._findFirstNumeric({}, ['a']), null);
});

test('_findDeep finds a nested key', () => {
    assert.equal(provider._findDeep({x: {y: {z: 7}}}, 'z'), 7);
    assert.equal(provider._findDeep({a: 1}, 'missing'), null);
});
