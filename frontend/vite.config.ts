import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The Emscripten module is generated into src/core/generated/ (gitignored)
      // by `npm run build:wasm`. Import it as "entrain-core" so the rest of the
      // app never references the generated path directly; the glue locates its
      // .wasm relative to this file via import.meta.url, which Vite bundles.
      'entrain-core': fileURLToPath(
        new URL('./src/core/generated/entrain_core.js', import.meta.url),
      ),
    },
  },
})
