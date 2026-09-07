import type { Motion } from '../api';
import type { MotionInput } from './retargetCore';

// Shared by playback, fixtures, tests, and benchmarks.
export function toMotionInput(m: Motion): MotionInput {
  return {
    fps: m.fps,
    numFrames: m.num_frames,
    smplPoses: Float32Array.from(m.smpl_poses.flat()),
    rootTranslation: Float32Array.from(m.root_translation.flat()),
    footContact: m.foot_contact ? Float32Array.from(m.foot_contact.flat()) : new Float32Array(m.num_frames * 4),
  };
}
