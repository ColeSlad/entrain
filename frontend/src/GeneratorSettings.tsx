import { useEffect, useRef, useState, type FormEvent } from 'react';
import { checkGenerator, generatorConnection, type GeneratorConnection, type GeneratorInfo } from './api';
import Icon from './Icon';

export default function GeneratorSettings({ connection, disabled, open, onClose, onConnect }: {
  connection: GeneratorConnection | null;
  disabled: boolean;
  open: boolean;
  onClose: () => void;
  onConnect: (connection: GeneratorConnection | null, info: GeneratorInfo | null) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(import.meta.env.DEV ? 'http://localhost:8000' : '');
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError(false);
    setMessage('Checking connection…');
    try {
      const next = generatorConnection(url, token, import.meta.env.DEV);
      const info = await checkGenerator(next);
      onConnect(next, info);
      setToken('');
      setMessage(`${info.mode === 'edge' ? 'Ready to generate' : 'Sample generator connected'} · ${info.min_duration_seconds}–${info.max_duration_seconds} seconds · up to ${Math.floor(info.max_upload_bytes / 1024 / 1024)} MB`);
    } catch (error) {
      setError(true);
      setMessage(error instanceof Error ? error.message : 'Connection failed.');
    } finally {
      setChecking(false);
    }
  }

  return <dialog ref={dialogRef} className="generator-dialog" aria-labelledby="generator-title" onClose={onClose}>
    <div className="dialog-heading">
      <span className="dialog-icon"><Icon name="connection" /></span>
      <button type="button" className="icon-button" aria-label="Close generator settings" onClick={onClose}><Icon name="close" /></button>
    </div>
    <h2 id="generator-title">{connection ? 'Generator settings' : 'Connect your generator'}</h2>
    {connection && <div className="connected-host"><Icon name="check" /><span>Connected to <strong>{new URL(connection.url).hostname}</strong></span></div>}
    <form onSubmit={(event) => void connect(event)}>
      <label className="form-field">
        Generator URL
        <input type="url" required value={url} placeholder="https://your-generator.modal.run" autoComplete="url"
          onChange={(event) => setUrl(event.target.value)} disabled={disabled || checking} spellCheck={false} />
      </label>
      <label className="form-field">
        Entrain access token
        <input type="password" value={token} autoComplete="off" spellCheck={false} placeholder="Your dedicated Entrain token"
          onChange={(event) => setToken(event.target.value)} disabled={disabled || checking} aria-describedby="token-hint" />
      </label>
      <p id="token-hint" className="form-hint">Use your dedicated Entrain token, not your Modal account credentials. It stays in memory until you disconnect or reload.</p>
      <div className="connection-note">Audio and your token go directly to this URL. Generating a dance uses your cloud account’s GPU budget.</div>
      {message && <p role="status" className={`form-message ${error ? 'is-error' : ''}`}>{message}</p>}
      <div className="dialog-actions">
        {connection && <button type="button" className="button button-quiet" disabled={disabled || checking} onClick={() => {
          onConnect(null, null); setToken(''); setMessage('Disconnected.'); setError(false);
        }}>Disconnect</button>}
        <div className="dialog-primary-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>{connection ? 'Done' : 'Cancel'}</button>
          <button type="submit" className="button button-primary" disabled={disabled || checking}>
            {checking && <span className="spinner" />}{checking ? 'Connecting…' : connection ? 'Update connection' : 'Connect generator'}
          </button>
        </div>
      </div>
    </form>
  </dialog>;
}
