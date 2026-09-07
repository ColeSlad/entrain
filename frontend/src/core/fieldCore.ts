import type { MotionCore, MotionInput, Params, Skeleton } from './retargetCore';
import type { BakedMotion, FieldSettings } from './fieldProtocol';

function seedFor(i: number): [number, number, number] {
  const h = (x: number) => { const s = Math.sin(x) * 43758.5453; return s - Math.floor(s); };
  return [h(i * 12.9898 + 1), h(i * 78.233 + 1), h(i * 37.719 + 1)];
}

function paramsFor(settings: FieldSettings, i: number): Params {
  const { params, variation } = settings;
  if (variation <= 0) return params;
  const seed = seedFor(i);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return {
    ...params,
    rootUpright: clamp(params.rootUpright + (seed[0] - 0.5) * 2 * variation * 0.6),
    footLock: clamp(params.footLock + (seed[1] - 0.5) * 2 * variation * 0.5),
  };
}

function sameParams(a: Params, b: Params): boolean {
  return a.rootUpright === b.rootUpright && a.footLock === b.footLock &&
    a.recenterWin === b.recenterWin && a.coordFix.every((v, i) => v === b.coordFix[i]);
}

// Lives in the worker. Updating one dancer at a time lets new slider messages
// supersede unfinished work, and lets playback use the already prepared cores.
export class FieldCore {
  private cores: MotionCore[] = [];
  private applied: Params[] = [];
  private skeleton: Skeleton | null = null;
  private motion: MotionInput | null = null;
  private settings: FieldSettings | null = null;
  private next = 0;
  private version = 0;
  private readonly makeCore: () => Promise<MotionCore>;

  constructor(makeCore: () => Promise<MotionCore>) {
    this.makeCore = makeCore;
  }

  configure(skeleton: Skeleton, motion: MotionInput | null): void {
    this.free();
    this.skeleton = skeleton;
    this.motion = motion;
  }

  tune(settings: FieldSettings): void {
    this.settings = settings;
    this.version++;
    this.next = 0;
    for (const core of this.cores.splice(settings.count)) core.free();
    this.applied.length = this.cores.length;
  }

  get pending(): boolean {
    return !!this.skeleton && !!this.motion && !!this.settings && this.next < this.settings.count;
  }

  async updateOne(): Promise<void> {
    const { skeleton, motion, settings, version } = this;
    if (!skeleton || !motion || !settings || !this.pending) return;
    const i = this.next;
    const params = paramsFor(settings, i);
    let core = this.cores[i];
    if (!core) {
      core = await this.makeCore();
      if (version !== this.version) { core.free(); return; }
      try {
        core.setup(skeleton, motion, params);
      } catch (error) {
        core.free();
        throw error;
      }
      this.cores.push(core);
    } else if (!sameParams(this.applied[i], params)) {
      core.setParams(params);
    }
    this.applied[i] = params;
    this.next++;
  }

  frame(frame: number, buffer?: ArrayBuffer): { buffer: ArrayBuffer; count: number } {
    const count = this.cores.length;
    const stride = (this.skeleton?.numBones ?? 0) * 4 + 3;
    const bytes = count * stride * 4;
    const result = buffer && buffer.byteLength >= bytes ? buffer : new ArrayBuffer(bytes);
    const out = new Float32Array(result);
    const variation = this.settings?.variation ?? 0;
    for (let i = 0; i < count; i++) {
      const offset = i * stride;
      // Synchronized dancers with identical applied settings share one pose.
      if (i > 0 && variation === 0 && sameParams(this.applied[0], this.applied[i])) {
        out.copyWithin(offset, 0, stride);
        continue;
      }
      const phase = Math.floor(seedFor(i)[2] * this.motion!.numFrames * variation);
      this.cores[i].computeFrame(Math.floor(frame) + phase,
        out.subarray(offset, offset + stride - 3), out.subarray(offset + stride - 3, offset + stride));
    }
    return { buffer: result, count };
  }

  async bake(): Promise<BakedMotion> {
    const { skeleton, motion, settings } = this;
    if (!skeleton || !motion || !settings) throw new Error('No dance to export');
    // Export the requested settings even if the crowd is still catching up.
    const core = await this.makeCore();
    try {
      core.setup(skeleton, motion, paramsFor(settings, 0));
      return { ...core.computeAll(), fps: motion.fps, numFrames: motion.numFrames, numBones: skeleton.numBones };
    } finally {
      core.free();
    }
  }

  free(): void {
    this.version++;
    for (const core of this.cores) core.free();
    this.cores = [];
    this.applied = [];
    this.skeleton = null;
    this.motion = null;
    this.next = 0;
  }
}
