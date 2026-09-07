import type { BakedMotion, FieldSettings, FieldRequest, FieldResponse } from './fieldProtocol';
import type { MotionInput, Skeleton } from './retargetCore';

// One worker and one transferable frame buffer for the whole crowd. At most one
// frame is in flight, so a slow device never accumulates a queue of old poses.
export class FieldWorker {
  private worker = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
  private generation = 0;
  private revision = 0;
  private pending = false;
  private refresh = true;
  private active = false;
  private lastFrame = -1;
  private buffer?: ArrayBuffer;
  private nextId = 0;
  private exports = new Map<number, { resolve: (motion: BakedMotion) => void; reject: (error: Error) => void }>();

  constructor(onFrame: (poses: Float32Array, count: number) => void) {
    this.worker.onmessage = ({ data }: MessageEvent<FieldResponse>) => {
      if (data.type === 'frame') {
        this.pending = false;
        this.buffer = data.buffer;
        this.refresh ||= !data.settled || data.revision !== this.revision;
        if (data.generation === this.generation) onFrame(new Float32Array(data.buffer), data.count);
      } else if (data.type === 'bake') {
        this.exports.get(data.id)?.resolve(data.motion);
        this.exports.delete(data.id);
      } else if (data.id !== undefined) {
        this.exports.get(data.id)?.reject(new Error(data.message));
        this.exports.delete(data.id);
      } else {
        this.fail(new Error(data.message));
      }
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message));
  }

  private send(message: FieldRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private fail(error: Error): void {
    console.error('Motion worker failed', error);
    this.active = false;
    this.pending = false;
    for (const request of this.exports.values()) request.reject(error);
    this.exports.clear();
  }

  configure(skeleton: Skeleton, motion: MotionInput | null): void {
    this.active = motion !== null;
    this.refresh = true;
    this.send({ type: 'configure', generation: ++this.generation, skeleton, motion });
  }

  tune(settings: FieldSettings): void {
    this.refresh = true;
    this.send({ type: 'tune', revision: ++this.revision, settings });
  }

  invalidateFrame(): void {
    this.refresh = true;
  }

  requestFrame(frame: number): void {
    const f = Math.floor(frame);
    if (!this.active || this.pending || (!this.refresh && f === this.lastFrame)) return;
    this.pending = true;
    this.refresh = false;
    this.lastFrame = f;
    const buffer = this.buffer;
    this.buffer = undefined;
    this.send({ type: 'frame', frame: f, buffer }, buffer ? [buffer] : []);
  }

  bake(): Promise<BakedMotion> {
    if (!this.active) return Promise.reject(new Error('No dance to export'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.exports.set(id, { resolve, reject });
      this.send({ type: 'bake', id });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.active = false;
    for (const request of this.exports.values()) request.reject(new Error('Character changed'));
    this.exports.clear();
  }
}
