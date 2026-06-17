// Loads the WASM motion core and exposes it through the same MotionCore
// interface as the TS oracle, so the two are swappable (WASM as the fast path,
// the oracle as the fallback). Bulk arrays cross the boundary zero-copy: JS
// mallocs heap regions, writes inputs through HEAP views, and reads outputs back
// at the pointers the getters return.
import createCore, { type EntrainCore } from 'entrain-core';
import type { CoreOutput, MotionCore, MotionInput, Params, Skeleton } from './retargetCore';

let corePromise: Promise<EntrainCore> | null = null;

// Instantiate the module. Memoized for the no-options (browser) path; when
// options are passed (e.g. wasmBinary under Node tests) a fresh instance is
// returned so callers control its lifetime.
export function loadCore(opts?: Record<string, unknown>): Promise<EntrainCore> {
  if (opts) return createCore(opts);
  if (!corePromise) corePromise = createCore();
  return corePromise;
}

// Phase 0 interop proof: a + b computed in WASM. Kept until the core is the
// app's default path.
export async function add(a: number, b: number): Promise<number> {
  const core = await loadCore();
  return core.ccall('add', 'number', ['number', 'number'], [a, b]) as number;
}

// A MotionCore backed by the WASM module. Resolve the returned promise once the
// module is ready; the methods are then synchronous like the oracle's.
export async function createWasmCore(opts?: Record<string, unknown>): Promise<MotionCore> {
  const mod = await loadCore(opts);
  const cwrap = (name: string, ret: string | null, args: number) =>
    mod.cwrap(name, ret, Array.from({ length: args }, () => 'number'));
  const _setup = cwrap('setup', null, 14);
  const _setParams = cwrap('set_params', null, 7);
  const _computeAll = cwrap('compute_all', null, 0);
  const _computeFrame = cwrap('compute_frame', null, 1);
  const _getOutLocal = cwrap('get_out_local_quat', 'number', 0);
  const _getOutRoot = cwrap('get_out_root_pos', 'number', 0);
  const _getFrameLocal = cwrap('get_frame_local_quat', 'number', 0);
  const _getFrameRoot = cwrap('get_frame_root_pos', 'number', 0);
  const _coreFree = cwrap('core_free', null, 0);

  let inputPtrs: number[] = [];
  let numBones = 0;
  let numFrames = 0;

  // ALLOW_MEMORY_GROWTH can replace the heap buffer, so fetch the HEAP view
  // fresh on every access (after any malloc) rather than caching it.
  const writeF32 = (a: Float32Array): number => {
    const ptr = mod._malloc(Math.max(4, a.length * 4));
    mod.HEAPF32.set(a, ptr >> 2);
    inputPtrs.push(ptr);
    return ptr;
  };
  const writeI32 = (a: Int32Array): number => {
    const ptr = mod._malloc(Math.max(4, a.length * 4));
    mod.HEAP32.set(a, ptr >> 2);
    inputPtrs.push(ptr);
    return ptr;
  };
  const freeInputs = () => {
    for (const p of inputPtrs) mod._free(p);
    inputPtrs = [];
  };

  const core: MotionCore = {
    setup(skeleton: Skeleton, motion: MotionInput, params: Params): void {
      freeInputs();
      numBones = skeleton.numBones;
      numFrames = motion.numFrames;
      const pParent = writeI32(skeleton.parentIndex);
      const pRestQ = writeF32(skeleton.restLocalQuat);
      const pRestP = writeF32(skeleton.restLocalPos);
      const pS2T = writeI32(skeleton.smplToTarget);
      const pFoot = writeI32(skeleton.footBones);
      const pPoses = writeF32(motion.smplPoses);
      const pTrans = writeF32(motion.rootTranslation);
      const pContact = writeF32(motion.footContact);
      _setup(
        numBones, pParent, pRestQ, pRestP, pS2T, pFoot, skeleton.footBones.length,
        skeleton.lockFeet[0], skeleton.lockFeet[1],
        numFrames, motion.fps, pPoses, pTrans, pContact,
      );
      core.setParams(params);
    },
    setParams(params: Params): void {
      const cf = params.coordFix;
      _setParams(params.rootUpright, params.footLock, params.recenterWin, cf[0], cf[1], cf[2], cf[3]);
    },
    computeAll(): CoreOutput {
      _computeAll();
      const q = (_getOutLocal() as number) >> 2;
      const r = (_getOutRoot() as number) >> 2;
      // slice() copies out of the heap so the result survives later growth.
      return {
        localQuat: mod.HEAPF32.slice(q, q + numFrames * numBones * 4),
        rootPos: mod.HEAPF32.slice(r, r + numFrames * 3),
      };
    },
    computeFrame(frame: number, outLocalQuat: Float32Array, outRootPos: Float32Array): void {
      _computeFrame(frame);
      const q = (_getFrameLocal() as number) >> 2;
      const r = (_getFrameRoot() as number) >> 2;
      outLocalQuat.set(mod.HEAPF32.subarray(q, q + numBones * 4));
      outRootPos.set(mod.HEAPF32.subarray(r, r + 3));
    },
    free(): void {
      _coreFree();
      freeInputs();
    },
  };
  return core;
}
