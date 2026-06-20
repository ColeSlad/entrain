// Type declaration for the Emscripten-generated module. The actual JS/WASM is
// built into ./generated/ by `npm run build:wasm` and is gitignored, so it has
// no committed types. We import it through the "entrain-core" alias (see
// vite.config.ts) and describe its shape here. Keep this in sync with the
// runtime methods exported in cpp/CMakeLists.txt (EXPORTED_RUNTIME_METHODS).
declare module 'entrain-core' {
  export interface EntrainCore {
    ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
    cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: unknown[]) => unknown;
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
  }
  const createCore: (opts?: Record<string, unknown>) => Promise<EntrainCore>;
  export default createCore;
}
