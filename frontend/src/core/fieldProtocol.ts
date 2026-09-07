import type { CoreOutput, MotionInput, Params, Skeleton } from './retargetCore';

export interface FieldSettings {
  count: number;
  params: Params;
  variation: number;
}

export interface BakedMotion extends CoreOutput {
  fps: number;
  numFrames: number;
  numBones: number;
}

export type FieldRequest =
  | { type: 'configure'; generation: number; skeleton: Skeleton; motion: MotionInput | null }
  | { type: 'tune'; revision: number; settings: FieldSettings }
  | { type: 'frame'; frame: number; buffer?: ArrayBuffer }
  | { type: 'bake'; id: number };

export type FieldResponse =
  | { type: 'frame'; generation: number; revision: number; settled: boolean; buffer: ArrayBuffer; count: number }
  | { type: 'bake'; id: number; motion: BakedMotion }
  | { type: 'error'; message: string; id?: number };
