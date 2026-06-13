import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AntigravityProvider} from '../../src/providers/antigravity.js';

const provider = new AntigravityProvider();

test('orders model windows most-constrained first', () => {
    const result = provider._normalizeQuotaResponse({
        models: {
            'models/gemini-flash': {label: 'Flash', quotaInfo: {remainingFraction: 0.8}},
            'models/gemini-pro': {label: 'Pro', quotaInfo: {remainingFraction: 0.1}},
            'models/gemini-lite': {label: 'Lite', quotaInfo: {isExhausted: true}},
        },
    }, 'free');

    // Exhausted (util 1.0) first, then Pro (0.9), then Flash (0.2).
    assert.deepEqual(result.windows.map(w => w.label), ['Lite', 'Pro', 'Flash']);
    assert.equal(result.windows[0].utilization, 1);
    assert.equal(result.windows[0].used, 100);
    assert.equal(result.planName, 'free');
});

test('skips models without quota information', () => {
    const result = provider._normalizeQuotaResponse({
        models: {
            'models/a': {label: 'A'},
            'models/b': {label: 'B', quotaInfo: {remainingFraction: 0.5}},
        },
    }, null);
    assert.deepEqual(result.windows.map(w => w.label), ['B']);
});

test('returns empty windows when no models are present', () => {
    const result = provider._normalizeQuotaResponse({}, 'tier');
    assert.deepEqual(result.windows, []);
    assert.equal(result.planName, 'tier');
});

test('_slugify normalizes model identifiers', () => {
    assert.equal(provider._slugify('models/Gemini-Flash 2.0'), 'gemini_flash_2_0');
    assert.equal(provider._slugify('!!!'), 'model');
});

test('_labelForModel derives readable labels', () => {
    assert.equal(provider._labelForModel('models/gemini-2.0-flash-lite'), 'Lite');
    assert.equal(provider._labelForModel('models/claude-sonnet'), 'Sonnet');
});
