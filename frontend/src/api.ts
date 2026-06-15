// Client for the jobs API (backend/app.py). Upload a song, poll until the
// generation job finishes, get back a section 8 Motion.

const API = 'http://localhost:8000';

export interface Motion {
  fps: number;
  num_frames: number;
  smpl_poses: number[][];
  root_translation: number[][];
  foot_contact: number[][];
  audio: unknown;
}

interface Job {
  status: 'running' | 'done' | 'error';
  motion: Motion | null;
  error: string | null;
}

export async function uploadSong(file: File): Promise<string> {
  const form = new FormData();
  form.append('audio', file);
  const res = await fetch(`${API}/jobs`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { job_id } = await res.json();
  return job_id as string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until the job finishes. The timeout is generous for real generation
// later; the stand-in resolves on the first poll.
export async function pollJob(
  jobId: string,
  intervalMs = 1000,
  timeoutMs = 300_000,
): Promise<Motion> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/jobs/${jobId}`);
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    const job: Job = await res.json();
    if (job.status === 'done' && job.motion) return job.motion;
    if (job.status === 'error') throw new Error(job.error ?? 'generation failed');
    await sleep(intervalMs);
  }
  throw new Error('generation timed out');
}
