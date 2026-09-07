import { FieldCore } from './fieldCore';
import type { FieldRequest, FieldResponse } from './fieldProtocol';
import { createTsCore } from './retargetCore';
import { createWasmCore } from './wasm';

let fallback = false;
const field = new FieldCore(async () => {
  if (fallback) return createTsCore();
  try {
    return await createWasmCore();
  } catch (error) {
    console.warn('WASM core load failed; using TS in the motion worker', error);
    fallback = true;
    return createTsCore();
  }
});

let generation = 0;
let revision = 0;
let updating = false;
const send = (message: FieldResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const fail = (error: unknown, id?: number) => send({ type: 'error', message: String(error), id });

async function update() {
  try {
    const start = performance.now();
    while (field.pending && performance.now() - start < 8) await field.updateOne();
    if (field.pending) {
      setTimeout(() => void update(), 0);
    } else {
      updating = false;
    }
  } catch (error) {
    updating = false;
    field.free();
    fail(error);
  }
}

self.onmessage = ({ data }: MessageEvent<FieldRequest>) => {
  try {
    switch (data.type) {
      case 'configure':
        generation = data.generation;
        field.configure(data.skeleton, data.motion);
        break;
      case 'tune':
        revision = data.revision;
        field.tune(data.settings);
        break;
      case 'frame': {
        const result = field.frame(data.frame, data.buffer);
        send({ type: 'frame', generation, revision, settled: !field.pending, ...result }, [result.buffer]);
        return;
      }
      case 'bake':
        void field.bake().then((motion) => {
          send({ type: 'bake', id: data.id, motion }, [motion.localQuat.buffer as ArrayBuffer, motion.rootPos.buffer as ArrayBuffer]);
        }).catch((error: unknown) => fail(error, data.id));
        return;
    }
    if (!updating && field.pending) {
      updating = true;
      setTimeout(() => void update(), 0);
    }
  } catch (error) {
    fail(error);
  }
};
