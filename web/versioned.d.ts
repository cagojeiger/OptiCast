// Types for the `?v=__V__` imports (see main.js): tsc does not resolve a module
// specifier with a query string, so each one is mapped to its file here.

declare module '*/metrics.js?v=__V__' {
  const m: typeof import('./metrics.js')
  export = m
}

declare module '*/store.js?v=__V__' {
  const m: typeof import('./store.js')
  export = m
}

declare module '*/wasm.js?v=__V__' {
  const m: typeof import('./wasm.js')
  export = m
}
