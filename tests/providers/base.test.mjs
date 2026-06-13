import {test} from 'node:test';
import assert from 'node:assert/strict';

import {BaseProvider} from '../../src/providers/base.js';

const provider = new BaseProvider();

test('_parseResetTimestamp handles ISO, unix seconds, unix ms, and digit strings', () => {
    const iso = provider._parseResetTimestamp('2026-04-11T18:00:00Z');
    assert.ok(iso instanceof Date);
    assert.equal(iso.toISOString(), '2026-04-11T18:00:00.000Z');

    const secs = provider._parseResetTimestamp(1_700_000_000);
    assert.equal(secs.getTime(), 1_700_000_000 * 1000);

    const ms = provider._parseResetTimestamp(1_700_000_000_000);
    assert.equal(ms.getTime(), 1_700_000_000_000);

    const digitString = provider._parseResetTimestamp('1700000000');
    assert.equal(digitString.getTime(), 1_700_000_000 * 1000);
});

test('_parseResetTimestamp returns null for empty or invalid input', () => {
    assert.equal(provider._parseResetTimestamp(null), null);
    assert.equal(provider._parseResetTimestamp(undefined), null);
    assert.equal(provider._parseResetTimestamp('not-a-date'), null);
});

test('_isExpiryTimestampExpired treats falsy expiry as valid', () => {
    assert.equal(provider._isExpiryTimestampExpired(0), false);
    assert.equal(provider._isExpiryTimestampExpired(null), false);
});

test('_isExpiryTimestampExpired flags past and near-future timestamps', () => {
    const past = Date.now() - 60_000;
    assert.equal(provider._isExpiryTimestampExpired(past), true);

    const farFuture = Date.now() + 3_600_000;
    assert.equal(provider._isExpiryTimestampExpired(farFuture, 300), false);

    const withinBuffer = Date.now() + 60_000;
    assert.equal(provider._isExpiryTimestampExpired(withinBuffer, 300), true);
});
