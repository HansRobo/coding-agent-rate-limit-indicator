// Module customization hooks that let provider modules import GNOME platform
// libraries (gi://*) and Shell resources (resource:///*) under plain Node.
//
// The providers only touch these objects inside async fetch methods, never at
// module-evaluation time, so a recursive no-op Proxy is enough to let the
// modules load and expose their pure normalization logic to unit tests.

const STUB_SCHEME = 'gjsstub:';

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('gi://') || specifier.startsWith('resource:///')) {
        return {
            url: STUB_SCHEME + encodeURIComponent(specifier),
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith(STUB_SCHEME)) {
        const source = `
            const make = () => new Proxy(function () {}, {
                get(_target, prop) {
                    // GObject.registerClass is used as a class decorator; it must
                    // return its argument unchanged.
                    if (prop === 'registerClass') return cls => cls;
                    if (prop === Symbol.toPrimitive) return () => '';
                    if (prop === 'then') return undefined; // not a thenable
                    return make();
                },
                apply() { return make(); },
                construct() { return make(); },
            });
            export default make();
        `;
        return {format: 'module', source, shortCircuit: true};
    }
    return nextLoad(url, context);
}
