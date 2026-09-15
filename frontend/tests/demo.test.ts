import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_AUDIO_URL, loadDemo } from '../src/useDemo';
import { validateMotion } from '../src/api';

const motion = JSON.parse(readFileSync(new URL('../../assets/demo/chopin-motion.json', import.meta.url), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

describe('saved Chopin demo', () => {
  it('ships real full-length motion, not the short development fixture', () => {
    expect(validateMotion(motion)).toBe(motion);
    expect(motion.fps).toBe(30);
    expect(motion.num_frames).toBe(1275);
    expect(motion.num_frames / motion.fps).toBe(42.5);
    expect(motion.audio.beats.length).toBeGreaterThan(0);
    expect(motion.smpl_poses[0]).not.toEqual(motion.smpl_poses[100]);
  });

  it('loads a static asset without credentials or generator requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(motion)));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadDemo(new AbortController().signal)).toEqual(motion);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toContain('chopin-motion');
    expect(url).not.toMatch(/modal|\/jobs/);
    expect(DEMO_AUDIO_URL).toContain('.mp3');
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(options.headers).toBeUndefined();
    expect(options.method).toBeUndefined();
  });

  it.each([
    () => Promise.resolve(new Response('', { status: 404 })),
    () => Promise.resolve(new Response('<html>not JSON</html>')),
    () => Promise.resolve(new Response(JSON.stringify({ ...motion, smpl_poses: [] }))),
    () => Promise.reject(new TypeError('offline')),
  ])('fails safely without retrying or falling back to paid generation', async (response) => {
    const fetcher = vi.fn(response);
    vi.stubGlobal('fetch', fetcher);
    await expect(loadDemo(new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('passes cancellation through to the static fetch', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      abort.abort();
      options.signal.throwIfAborted();
    }));
    await expect(loadDemo(abort.signal)).rejects.toThrow();
  });
});
