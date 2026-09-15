import { useState, type CSSProperties, type FormEvent } from 'react';
import { checkGenerator, generatorConnection, type GeneratorConnection, type GeneratorInfo } from './api';

export default function GeneratorSettings({ connection, disabled, onConnect }: {
  connection: GeneratorConnection | null;
  disabled: boolean;
  onConnect: (connection: GeneratorConnection | null, info: GeneratorInfo | null) => void;
}) {
  const [url, setUrl] = useState(import.meta.env.DEV ? 'http://localhost:8000' : '');
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  async function connect(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setMessage('Checking connection…');
    try {
      const next = generatorConnection(url, token, import.meta.env.DEV);
      const info = await checkGenerator(next);
      onConnect(next, info);
      setToken('');
      setMessage(`${info.mode === 'edge' ? 'EDGE connected' : 'Sample fixture only'} · ${info.min_duration_seconds}–${info.max_duration_seconds}s · up to ${Math.floor(info.max_upload_bytes / 1024 / 1024)} MB`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection failed.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <details style={box} open={!connection}>
      <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>
        Generator: {connection ? new URL(connection.url).hostname : 'not connected'}
      </summary>
      <form onSubmit={(event) => void connect(event)} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        <label>
          Generator URL
          <input aria-label="Generator URL" type="url" required value={url} placeholder="https://your-generator.modal.run"
            onChange={(event) => setUrl(event.target.value)} disabled={disabled || checking} style={input} />
        </label>
        <label>
          Entrain access token
          <input aria-label="Entrain access token" type="password" value={token} autoComplete="off" spellCheck={false}
            onChange={(event) => setToken(event.target.value)} disabled={disabled || checking} style={input} />
        </label>
        <span style={{ fontSize: 12, color: '#bbc1c9' }}>
          Use your dedicated Entrain token, not your Modal account credentials. Audio and the token go directly to this URL.
          The token stays in memory until disconnect or reload. Generation uses your cloud account’s GPU budget.
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={disabled || checking}>{checking ? 'Checking…' : 'Connect generator'}</button>
          {connection && <button type="button" disabled={disabled || checking} onClick={() => {
            onConnect(null, null); setToken(''); setMessage('Disconnected.');
          }}>Disconnect</button>}
        </div>
        <span role="status" style={{ fontSize: 12 }}>{message}</span>
      </form>
    </details>
  );
}

const box: CSSProperties = {
  position: 'fixed', left: 12, top: 60, width: 300, maxWidth: 'calc(100vw - 48px)',
  padding: 12, borderRadius: 8, background: 'rgba(20,24,28,0.94)', color: '#cfd2d6',
  fontFamily: 'system-ui, sans-serif', fontSize: 13,
};
const input: CSSProperties = { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 4, padding: 6 };
