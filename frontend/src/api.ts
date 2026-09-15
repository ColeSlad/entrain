// Each request carries a connection snapshot. Never persist the access token or
// retry job creation automatically: a duplicate POST can incur another GPU bill.
export interface GeneratorConnection {
  url: string;
  token: string;
}

export interface GeneratorInfo {
  service: 'entrain';
  api_version: 1;
  mode: 'edge' | 'fixture';
  max_upload_bytes: number;
  min_duration_seconds: number;
  max_duration_seconds: number;
}

export function generatorConnection(url: string, token: string, allowLocal = false): GeneratorConnection {
  const parsed = new URL(url.trim());
  const local = allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('Use an HTTPS generator URL. HTTP is only allowed for local development.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Enter the generator base URL without credentials, query parameters, or a fragment.');
  }
  const secret = token.trim();
  if (!local && (!secret || /[^\x21-\x7e]/.test(secret))) {
    throw new Error('Enter the dedicated Entrain access token.');
  }
  return { url: parsed.href.replace(/\/+$/, ''), token: secret };
}

export interface AudioInfo {
  bpm: number | null;
  beats: number[];      // seconds
  downbeats: number[];  // seconds
  sections: { label: string; start: number; end: number }[];
}

export interface Motion {
  fps: number;
  num_frames: number;
  smpl_poses: number[][];
  root_translation: number[][];
  foot_contact: number[][];
  audio: AudioInfo | null;
}

interface Job {
  status: 'running' | 'done' | 'error';
  motion: Motion | null;
  error: string | null;
}

async function request(connection: GeneratorConnection, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (connection.token) headers.set('Authorization', `Bearer ${connection.token}`);
  let res: Response;
  try {
    res = await fetch(connection.url + path, {
      ...init, headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (init.method === 'POST') {
      throw new Error('Upload response was lost. A GPU job may have started; check your Modal dashboard before trying again.', { cause: error });
    }
    throw new Error('Could not reach the generator. Check its HTTPS URL, deployment, and allowed website origin.', { cause: error });
  }
  if (res.status === 401 || res.status === 403) throw new Error('Generator rejected the access token.');
  if (res.status === 410) throw new Error('This job has expired. Upload the song again to generate a new dance.');
  if (!res.ok) {
    // Do not echo arbitrary server content (which might contain credentials).
    const message = res.status === 413 ? 'Audio upload is too large.'
      : res.status === 422 ? 'Audio must be decodable and within the generator’s duration limits.'
      : res.status === 429 ? 'Generator is busy. Try again later.'
      : `Generator request failed (${res.status}).`;
    throw new Error(message);
  }
  return res.json();
}

export async function checkGenerator(connection: GeneratorConnection): Promise<GeneratorInfo> {
  const info = await request(connection, '/health') as GeneratorInfo;
  if (!info || info.service !== 'entrain' || info.api_version !== 1 ||
    !['edge', 'fixture'].includes(info.mode) ||
    !Number.isSafeInteger(info.max_upload_bytes) || info.max_upload_bytes <= 0 ||
    !Number.isFinite(info.min_duration_seconds) || info.min_duration_seconds < 0 ||
    !Number.isFinite(info.max_duration_seconds) || info.max_duration_seconds <= info.min_duration_seconds) {
    throw new Error('This endpoint is not a compatible Entrain generator.');
  }
  return info;
}

export async function uploadSong(connection: GeneratorConnection, file: File): Promise<string> {
  const form = new FormData();
  form.append('audio', file);
  const data = await request(connection, '/jobs', { method: 'POST', body: form }) as { job_id?: unknown };
  if (!data || typeof data.job_id !== 'string' || !data.job_id || data.job_id.length > 512) {
    throw new Error('Generator returned an invalid job ID.');
  }
  return data.job_id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Keep the polling budget above the GPU's 30-minute execution limit. A timeout
// or a closed tab does not cancel remote work; cancellation is an explicit API.
export async function pollJob(
  connection: GeneratorConnection,
  jobId: string,
  intervalMs = 1000,
  timeoutMs = 2_100_000,
  signal?: AbortSignal,
): Promise<Motion> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : undefined;
    const job = await request(connection, `/jobs/${encodeURIComponent(jobId)}`, { signal: requestSignal }) as Job;
    if (job?.status === 'done') return validateMotion(job.motion);
    if (job?.status === 'error') throw new Error('Generation failed. Check the generator’s Modal logs.');
    if (job?.status !== 'running') throw new Error('Generator returned an invalid job status.');
    await sleep(intervalMs);
  }
  throw new Error('Stopped waiting for generation. The remote job may still be running; cancel it before submitting again.');
}

export async function cancelJob(connection: GeneratorConnection, jobId: string): Promise<void> {
  await request(connection, `/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

// External endpoints are not trusted to provide well-shaped numeric buffers.
// Reject malformed/oversized motion before it reaches native WASM indexing.
export function validateMotion(value: unknown): Motion {
  const m = value as Motion | null;
  if (!m || !Number.isInteger(m.fps) || m.fps < 1 || m.fps > 120 ||
    !Number.isInteger(m.num_frames) || m.num_frames < 1 || m.num_frames > 36_000) {
    throw new Error('Generator returned invalid motion dimensions.');
  }
  for (const [rows, width] of [[m.smpl_poses, 72], [m.root_translation, 3], [m.foot_contact, 4]] as const) {
    if (!Array.isArray(rows) || rows.length !== m.num_frames || rows.some((row) =>
      !Array.isArray(row) || row.length !== width || row.some((v) => typeof v !== 'number' || !Number.isFinite(v)))) {
      throw new Error('Generator returned malformed motion arrays.');
    }
  }
  if (m.foot_contact.some((row) => row.some((v) => v !== 0 && v !== 1))) {
    throw new Error('Generator returned invalid foot contacts.');
  }
  if (m.audio !== null) {
    const a = m.audio;
    // librosa can report zero BPM when no beat is detected.
    if (!a || (a.bpm !== null && (typeof a.bpm !== 'number' || !Number.isFinite(a.bpm) || a.bpm < 0)) ||
      ![a.beats, a.downbeats].every((times) => Array.isArray(times) && times.length <= 36_000 &&
        times.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)) ||
      !Array.isArray(a.sections) || a.sections.length > 36_000 || a.sections.some((s) => !s || typeof s.label !== 'string' ||
        !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start)) {
      throw new Error('Generator returned invalid audio metadata.');
    }
  }
  return m;
}
