// Loads the WASM motion core and exposes it through the same MotionCore
// interface as the TS oracle, so the two are swappable (WASM as the fast path,
// the oracle as the fallback). Inputs are uploaded once and shared by dancers
// using the same skeleton/motion. Outputs are copied into caller-owned buffers.
import createCore, { type EntrainCore } from 'entrain-core';
import type { MotionCore } from './retargetCore';
import { createWasmCoreFromModule } from './wasmCore';

let corePromise: Promise<EntrainCore> | null = null;

// Instantiate the module. Memoized for the no-options (browser) path; when
// options are passed (e.g. wasmBinary under Node tests) a fresh instance is
// returned so callers control its lifetime.
export function loadCore(opts?: Record<string, unknown>): Promise<EntrainCore> {
  if (opts) return createCore(opts);
  if (!corePromise) corePromise = createCore();
  return corePromise;
}

// A MotionCore backed by the WASM module. Resolve the returned promise once the
// module is ready; the methods are then synchronous like the oracle's.
export async function createWasmCore(opts?: Record<string, unknown>): Promise<MotionCore> {
  return createWasmCoreFromModule(await loadCore(opts));
}
