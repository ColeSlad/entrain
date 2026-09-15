import { useCallback, useEffect, useState } from 'react';
import { validateMotion, type Motion } from './api';
import audioUrl from '../../assets/demo/chopin.mp3?url';
import motionUrl from '../../assets/demo/chopin-motion.json?url';

export const DEMO_TITLE = 'Chopin · Prelude in A major, Op. 28, No. 7';
export const DEMO_AUDIO_URL = audioUrl;

type DemoState =
  | { status: 'loading' | 'error'; motion: null }
  | { status: 'ready'; motion: Motion };

// Static, content-hashed build assets only. This path never uses a generator,
// saved credentials, or a fallback API, even when the request fails.
export async function loadDemo(signal: AbortSignal): Promise<Motion> {
  const response = await fetch(motionUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) throw new Error('Could not load the saved demo.');
  return validateMotion(await response.json());
}

export function useDemo() {
  const [demo, setDemo] = useState<DemoState>({ status: 'loading', motion: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    loadDemo(abort.signal).then(
      (motion) => { if (!abort.signal.aborted) setDemo({ status: 'ready', motion }); },
      () => { if (!abort.signal.aborted) setDemo({ status: 'error', motion: null }); },
    );
    return () => abort.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setDemo({ status: 'loading', motion: null });
    setAttempt((previous) => previous + 1);
  }, []);
  const audioFailed = useCallback(() => setDemo({ status: 'error', motion: null }), []);
  return { ...demo, retry, audioFailed };
}
