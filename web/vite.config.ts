/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Default to `node` for the bulk of unit tests (reducer, persist,
    // payload derivation). Component / hook tests that need a DOM opt
    // in via the `// @vitest-environment jsdom` pragma at the top of
    // each file. See web/src/useDeliveredPolling.test.ts and the
    // *.test.tsx files under web/src/components/ for examples.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  // The @php-wasm/web-* packages import their .wasm binaries as default
  // imports rather than ?url. Treat .wasm as a static asset so Vite emits a
  // file and resolves the import to its URL — Emscripten's loader fetches it
  // at runtime.
  assetsInclude: ['**/*.wasm', '**/*.dat'],
  optimizeDeps: {
    // Only exclude the version-specific package that imports raw .wasm —
    // pre-bundling it breaks Vite's wasm-fallback. `@php-wasm/universal`
    // must stay in optimizeDeps so its CJS deps (e.g. `ini`) get the proper
    // ESM interop shim.
    exclude: ['@php-wasm/web-8-3'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        gallery: resolve(__dirname, 'gallery.html'),
        demo: resolve(__dirname, 'demo.html'),
        featureDocs: resolve(__dirname, 'feature-docs.html'),
        detached: resolve(__dirname, 'detached.html'),
      },
    },
  },
})
