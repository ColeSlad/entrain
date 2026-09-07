// Wrap an existing module so the browser, tests, and Node benchmark use the same
// handle ownership, shared input allocations, and output copies.
import type { EntrainCore } from 'entrain-core';
import type { CoreOutput, MotionCore, MotionInput, Params, Skeleton } from './retargetCore';

interface HeapInput { pointers: number[]; references: number }
const inputCaches = new WeakMap<EntrainCore, WeakMap<object, HeapInput>>();

export function createWasmCoreFromModule(mod: EntrainCore): MotionCore {
  const cwrap = (name: string, ret: string | null, args: number) =>
    mod.cwrap(name, ret, Array.from({ length: args }, () => 'number'));
  // The module holds many cores; this wrapper owns one handle. Every call
  // takes the handle first, so independent instances never collide.
  const _coreCreate = cwrap('core_create', 'number', 0);
  const _setup = cwrap('setup', null, 15);
  const _setParams = cwrap('set_params', null, 8);
  const _computeAll = cwrap('compute_all', null, 1);
  const _computeFrame = cwrap('compute_frame', null, 2);
  const _getOutLocal = cwrap('get_out_local_quat', 'number', 1);
  const _getOutRoot = cwrap('get_out_root_pos', 'number', 1);
  const _getFrameLocal = cwrap('get_frame_local_quat', 'number', 1);
  const _getFrameRoot = cwrap('get_frame_root_pos', 'number', 1);
  const _coreFree = cwrap('core_free', null, 1);

  const h = _coreCreate() as number;
  let releases: (() => void)[] = [];
  let freed = false;
  let numBones = 0;
  let numFrames = 0;
  let cache = inputCaches.get(mod);
  if (!cache) { cache = new WeakMap(); inputCaches.set(mod, cache); }

  // ALLOW_MEMORY_GROWTH can replace the heap buffer, so fetch the HEAP view
  // fresh on every access (after any malloc) rather than caching it.
  const acquire = (key: object, arrays: (Float32Array | Int32Array)[]): number[] => {
    let entry = cache.get(key);
    if (!entry) {
      const pointers: number[] = [];
      try {
        for (const a of arrays) {
          const ptr = mod._malloc(Math.max(4, a.byteLength));
          if (!ptr) throw new Error('Could not allocate motion input');
          pointers.push(ptr);
          if (a instanceof Int32Array) mod.HEAP32.set(a, ptr >> 2);
          else mod.HEAPF32.set(a, ptr >> 2);
        }
      } catch (error) {
        for (const ptr of pointers) mod._free(ptr);
        throw error;
      }
      entry = { pointers, references: 0 };
      cache.set(key, entry);
    }
    const shared = entry;
    shared.references++;
    releases.push(() => {
      if (--shared.references === 0) {
        cache.delete(key);
        for (const ptr of shared.pointers) mod._free(ptr);
      }
    });
    return shared.pointers;
  };
  const freeInputs = () => {
    for (const release of releases) release();
    releases = [];
  };

  const core: MotionCore = {
    setup(skeleton: Skeleton, motion: MotionInput, params: Params): void {
      freeInputs();
      numBones = skeleton.numBones;
      numFrames = motion.numFrames;
      // Skeleton and motion arrays are immutable between setup calls.
      const [pParent, pRestQ, pRestP, pS2T, pFoot] = acquire(skeleton,
        [skeleton.parentIndex, skeleton.restLocalQuat, skeleton.restLocalPos, skeleton.smplToTarget, skeleton.footBones]);
      const [pPoses, pTrans, pContact] = acquire(motion,
        [motion.smplPoses, motion.rootTranslation, motion.footContact]);
      _setup(
        h, numBones, pParent, pRestQ, pRestP, pS2T, pFoot, skeleton.footBones.length,
        skeleton.lockFeet[0], skeleton.lockFeet[1],
        numFrames, motion.fps, pPoses, pTrans, pContact,
      );
      core.setParams(params);
    },
    setParams(params: Params): void {
      const cf = params.coordFix;
      _setParams(h, params.rootUpright, params.footLock, params.recenterWin, cf[0], cf[1], cf[2], cf[3]);
    },
    computeAll(): CoreOutput {
      _computeAll(h);
      const q = (_getOutLocal(h) as number) >> 2;
      const r = (_getOutRoot(h) as number) >> 2;
      // slice() copies out of the heap so the result survives later growth.
      return {
        localQuat: mod.HEAPF32.slice(q, q + numFrames * numBones * 4),
        rootPos: mod.HEAPF32.slice(r, r + numFrames * 3),
      };
    },
    computeFrame(frame: number, outLocalQuat: Float32Array, outRootPos: Float32Array): void {
      _computeFrame(h, frame);
      const q = (_getFrameLocal(h) as number) >> 2;
      const r = (_getFrameRoot(h) as number) >> 2;
      outLocalQuat.set(mod.HEAPF32.subarray(q, q + numBones * 4));
      outRootPos.set(mod.HEAPF32.subarray(r, r + 3));
    },
    free(): void {
      if (freed) return;
      freed = true;
      _coreFree(h);
      freeInputs();
    },
  };
  return core;
}
