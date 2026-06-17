// Loads the WASM motion core and exposes its exported functions to the rest of
// the frontend. Phase 0 wires only the trivial add() to prove interop; the
// malloc/free and HEAPF32 view helpers for zero-copy bulk arrays come in
// Phase 3 when the real setup/compute_all API lands.
import createCore, { type EntrainCore } from 'entrain-core';

let corePromise: Promise<EntrainCore> | null = null;

// Instantiate once and reuse. The factory returns a promise because the WASM
// binary is fetched and compiled asynchronously.
export function loadCore(): Promise<EntrainCore> {
  if (!corePromise) corePromise = createCore();
  return corePromise;
}

// Phase 0 interop proof: a + b computed in WASM.
export async function add(a: number, b: number): Promise<number> {
  const core = await loadCore();
  return core.ccall('add', 'number', ['number', 'number'], [a, b]) as number;
}
