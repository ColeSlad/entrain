import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, checkGenerator, generatorConnection, pollJob, uploadSong, validateMotion } from '../src/api';
import motion from './fixtures/motion.json';

const connection = generatorConnection('https://generator.example/', 'test-token');
const info = { service: 'entrain', api_version: 1, mode: 'edge', max_upload_bytes: 20 * 1024 * 1024,
  min_duration_seconds: 5, max_duration_seconds: 120 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('private generator client', () => {
  it('requires HTTPS and a dedicated token, allowing localhost only in development', () => {
    expect(connection).toEqual({ url: 'https://generator.example', token: 'test-token' });
    for (const url of ['http://generator.example', 'http://localhost:8000', 'https://user:pass@example.com',
      'https://example.com?token=x', 'https://example.com#token', 'file:///tmp/example']) {
      expect(() => generatorConnection(url, 'token')).toThrow();
    }
    for (const token of ['', 'token\r\nheader', '💃']) {
      expect(() => generatorConnection(connection.url, token)).toThrow();
    }
    expect(generatorConnection('http://localhost:8000/', '', true).url).toBe('http://localhost:8000');
  });

  it('authenticates health without cookies, redirects, or referrer leakage', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(info));
    vi.stubGlobal('fetch', fetcher);
    expect(await checkGenerator(connection)).toEqual(info);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://generator.example/health');
    expect(options.headers.get('Authorization')).toBe('Bearer test-token');
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });

  it('rejects incompatible health and never echoes server errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ...info, api_version: 2 }))
      .mockResolvedValueOnce(response({ detail: 'secret server content' }, 401));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkGenerator(connection)).rejects.toThrow('not a compatible');
    await expect(checkGenerator(connection)).rejects.toThrow('rejected the access token');
  });

  it('uploads once and warns about potentially running jobs when the response is lost', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network failed'));
    vi.stubGlobal('fetch', fetcher);
    const file = new File(['audio'], 'song.wav');
    await expect(uploadSong(connection, file)).rejects.toThrow('may have started');
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(response({ job_id: 'signed-job' }, 202));
    expect(await uploadSong(connection, file)).toBe('signed-job');
    expect(fetcher.mock.calls[1][1].body.get('audio').name).toBe('song.wav');
  });

  it('rejects malformed job IDs and preserves useful upload errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ job_id: 123 }))
      .mockResolvedValueOnce(response({}, 413));
    vi.stubGlobal('fetch', fetcher);
    const file = new File(['audio'], 'song.wav');
    await expect(uploadSong(connection, file)).rejects.toThrow('invalid job ID');
    await expect(uploadSong(connection, file)).rejects.toThrow('too large');
  });

  it('polls pending jobs, validates completed motion, and explicitly cancels', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ status: 'running' }))
      .mockResolvedValueOnce(response({ status: 'done', motion }))
      .mockResolvedValueOnce(response({ status: 'cancelled' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await pollJob(connection, 'signed/job', 0)).toEqual(motion);
    await cancelJob(connection, 'signed/job');
    expect(fetcher.mock.calls[0][0]).toBe('https://generator.example/jobs/signed%2Fjob');
    expect(fetcher.mock.calls[2][1].method).toBe('DELETE');
  });

  it('stops for expiration, failure, invalid status, and cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, 410))
      .mockResolvedValueOnce(response({ status: 'error', error: 'private stack trace' }))
      .mockResolvedValueOnce(response({ status: 'surprise' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(pollJob(connection, 'id')).rejects.toThrow('expired');
    await expect(pollJob(connection, 'id')).rejects.toThrow('Generation failed');
    await expect(pollJob(connection, 'id')).rejects.toThrow('invalid job status');
    await expect(pollJob(connection, 'id', 0, 0)).rejects.toThrow('may still be running');
    const abort = new AbortController();
    abort.abort();
    await expect(pollJob(connection, 'id', 0, 1000, abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('motion boundary before WASM', () => {
  it('accepts the committed fixture without copying it', () => {
    expect(validateMotion(motion)).toBe(motion);
  });

  it('rejects oversized, malformed, nonfinite, and nonbinary data', () => {
    const invalid = [null, { ...motion, num_frames: 36_001 }, { ...motion, fps: 0 },
      { ...motion, smpl_poses: [] }, { ...motion, root_translation: [[NaN, 0, 0]] },
      { ...motion, foot_contact: motion.foot_contact.map(() => [2, 0, 0, 0]) },
      { ...motion, audio: { bpm: 120, beats: [-1], downbeats: [], sections: [] } }];
    for (const value of invalid) expect(() => validateMotion(value)).toThrow();
    const nonfinite = structuredClone(motion);
    nonfinite.smpl_poses[0][0] = Infinity;
    expect(() => validateMotion(nonfinite)).toThrow('malformed motion arrays');
  });
});
