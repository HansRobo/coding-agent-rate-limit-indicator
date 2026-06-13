// Registers the gi:// / resource:/// module hooks before the test files load.
// Wired into the test runner via `node --import ./tests/gjs-stub.mjs`.

import {register} from 'node:module';

register('./gjs-hooks.mjs', import.meta.url);
