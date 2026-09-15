import { useState } from 'react';
import Icon from './Icon';

const docs = 'https://github.com/ColeSlad/entrain/blob/main/docs';
const signInCommands = `git clone https://github.com/ColeSlad/entrain.git
cd entrain
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/modal token new`;
const deployCommands = `.venv/bin/modal volume create entrain-assets
.venv/bin/modal volume put entrain-assets backend/checkpoints/checkpoint.pt /checkpoint.pt
cd backend
../.venv/bin/modal deploy modal_app.py
cd ..`;

export default function GeneratorSetup() {
  const origin = window.location.protocol === 'https:' ? window.location.origin : 'https://entrain-rouge.vercel.app';
  // Quote the website origin for the macOS/Linux shell commands shown below.
  const quotedOrigin = `'${origin.replaceAll("'", "'\\''")}'`;
  const tokenCommand = `.venv/bin/python backend/configure_generator.py --origin ${quotedOrigin}`;

  return <details className="generator-setup">
    <summary><span>Set up with Modal</span><Icon name="chevron" /></summary>
    <div className="setup-guide">
      <p>Run the dance generator in your own Modal account. This is a one-time setup on your computer.</p>
      <p>You'll need Git and Python 3.10+. The commands below work in a macOS or Linux terminal, or WSL on Windows.</p>
      <ol className="setup-steps">
        <li>
          <h3>Get Entrain and sign in to Modal</h3>
          <p><a href="https://modal.com" target="_blank" rel="noreferrer">Create a Modal account</a> and set up billing for GPU access. Run these commands, then finish signing in when your browser opens.</p>
          <SetupCommands label="sign-in commands" commands={signInCommands} />
          <p className="setup-aside">Already have the repo? Open its folder and skip the first two lines.</p>
        </li>
        <li>
          <h3>Create your Entrain access token</h3>
          <p>From the Entrain folder, run this to allow connections from <code>{origin}</code>.</p>
          <SetupCommands label="token command" commands={tokenCommand} />
          <p>It creates the <code>entrain-web</code> secret in Modal and prints your <strong>Entrain access token</strong> once. Save that token in a password manager; it's the one to paste below, not your Modal account credentials.</p>
          <p className="setup-aside">If the secret already exists, reuse your saved token. See the full guide below if you need to reset it.</p>
        </li>
        <li>
          <h3>Add the dance model and deploy</h3>
          <p>Follow the <a href={`${docs}/SETUP.md#2-edge-checkpoint`} target="_blank" rel="noreferrer">EDGE model download instructions</a> and save the file as <code>backend/checkpoints/checkpoint.pt</code>. Then run:</p>
          <SetupCommands label="deployment commands" commands={deployCommands} />
          <p className="setup-aside">Skip volume creation or upload if already done. The first deployment can take a while.</p>
        </li>
        <li>
          <h3>Connect to Entrain</h3>
          <p>Copy the HTTPS URL shown for <code>web</code> after deployment (ending in <code>.modal.run</code>) into <strong>Generator URL</strong> below. Paste the token from step 2 into <strong>Entrain access token</strong>, then connect.</p>
          <p>Connecting only checks the service. Uploading a song starts paid GPU generation in your Modal account.</p>
        </li>
      </ol>
      <a className="setup-guide-link" href={`${docs}/HOSTING.md`} target="_blank" rel="noreferrer">Full setup guide & troubleshooting</a>
    </div>
  </details>;
}

function SetupCommands({ label, commands }: { label: string; commands: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(commands);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  }

  return <div className="setup-commands">
    <div className="setup-command-heading">
      <span>Terminal</span>
      <button type="button" className="button button-quiet" aria-label={`Copy ${label}`} onClick={() => void copy()}>
        {status === 'copied' && <Icon name="check" />}<span aria-live="polite">{status === 'copied' ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
    <pre><code>{commands}</code></pre>
    {status === 'error' && <p className="setup-copy-error" role="status">Couldn't copy. Select the commands and copy them manually.</p>}
  </div>;
}
