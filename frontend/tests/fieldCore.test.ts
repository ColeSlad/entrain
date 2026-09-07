import { describe, expect, it, vi } from 'vitest';
import { FieldCore } from '../src/core/fieldCore';
import { createTsCore, type MotionCore, type Skeleton } from '../src/core/retargetCore';
import { toMotionInput } from '../src/core/motionInput';
import { defaultParams } from '../src/retarget';
import skeletonJson from './fixtures/skeleton.json';
import motionJson from './fixtures/motion.json';

const skeleton: Skeleton = {
  numBones: skeletonJson.numBones,
  parentIndex: Int32Array.from(skeletonJson.parentIndex),
  restLocalQuat: Float32Array.from(skeletonJson.restLocalQuat),
  restLocalPos: Float32Array.from(skeletonJson.restLocalPos),
  smplToTarget: Int32Array.from(skeletonJson.smplToTarget),
  footBones: Int32Array.from(skeletonJson.footBones),
  lockFeet: Int32Array.from(skeletonJson.lockFeet),
};
const motion = toMotionInput(motionJson);

async function settle(field: FieldCore) {
  for (let steps = 0; field.pending; steps++) {
    if (steps > 20) throw new Error('Field failed to settle');
    await field.updateOne();
  }
}

describe('incremental dancer field', () => {
  it('preserves existing cores on count changes and applies only the latest tuning', async () => {
    const cores: MotionCore[] = [];
    const factory = vi.fn(async () => {
      const core = createTsCore();
      vi.spyOn(core, 'setup');
      vi.spyOn(core, 'free');
      cores.push(core);
      return core;
    });
    const field = new FieldCore(factory);
    const params = defaultParams();
    field.configure(skeleton, motion);
    field.tune({ count: 2, params, variation: 0 });
    expect(field.frame(0).count).toBe(0); // never pose an uninitialized core
    await settle(field);
    field.tune({ count: 4, params, variation: 0 });
    await settle(field);
    expect(factory).toHaveBeenCalledTimes(4);
    expect(cores[0].setup).toHaveBeenCalledTimes(1);
    field.tune({ count: 2, params, variation: 0 });
    expect(cores[2].free).toHaveBeenCalledOnce();
    expect(cores[3].free).toHaveBeenCalledOnce();
    expect(cores[0].free).not.toHaveBeenCalled();

    field.tune({ count: 2, params: { ...params, rootUpright: 0 }, variation: 0.8 });
    await field.updateOne();
    const latest = { ...params, rootUpright: 0.5, footLock: 0.3, recenterWin: 21 };
    field.tune({ count: 2, params: latest, variation: 0 });
    await settle(field);
    const expected = createTsCore();
    expected.setup(skeleton, motion, latest);
    const q = new Float32Array(skeleton.numBones * 4), r = new Float32Array(3);
    expected.computeFrame(37, q, r);
    const result = field.frame(37);
    const packed = new Float32Array(result.buffer);
    for (let i = 0; i < 2; i++) {
      const offset = i * (q.length + 3);
      expect(packed.slice(offset, offset + q.length)).toEqual(q);
      expect(packed.slice(offset + q.length, offset + q.length + 3)).toEqual(r);
    }
    expect(field.frame(38, result.buffer).buffer).toBe(result.buffer);
    expect(cores[0].setup).toHaveBeenCalledTimes(1);
    field.free();
  });

  it('discards a core still loading when the clip changes', async () => {
    let resolve!: (core: MotionCore) => void;
    const field = new FieldCore(() => new Promise((r) => { resolve = r; }));
    const core = createTsCore();
    const setup = vi.spyOn(core, 'setup'), free = vi.spyOn(core, 'free');
    field.configure(skeleton, motion);
    field.tune({ count: 1, params: defaultParams(), variation: 0 });
    const update = field.updateOne();
    field.configure(skeleton, null);
    resolve(core);
    await update;
    expect(setup).not.toHaveBeenCalled();
    expect(free).toHaveBeenCalledOnce();
    expect(field.pending).toBe(false);
    expect(field.frame(0).count).toBe(0);
  });

  it('exports current settings while the crowd update is unfinished', async () => {
    const field = new FieldCore(async () => createTsCore());
    field.configure(skeleton, motion);
    const params = { ...defaultParams(), rootUpright: 0.5, footLock: 0.2 };
    field.tune({ count: 4, params, variation: 0 });
    const actual = await field.bake();
    const expected = createTsCore();
    expected.setup(skeleton, motion, params);
    expect(actual.localQuat).toEqual(expected.computeAll().localQuat);
    expect(actual.rootPos).toEqual(expected.computeAll().rootPos);
    field.free();
  });
});
