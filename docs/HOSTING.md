# Vercel + bring your own Modal GPU

Vercel serves the static browser app. Each user deploys a private Entrain API and
GPU generator in **their own Modal account**, then enters that API's URL and a
dedicated Entrain token in the browser. Their audio goes directly to their API;
Vercel does not receive the upload or run inference.

This is a private, single-owner deployment, not a shared paid GPU service. Other
providers can implement the same API later, but only Modal is wired up here.

## 1. Set up your Modal account

Run from the repository root. Skip creating the virtual environment if it already
exists. The local tooling needs Python 3.10+; the GPU image uses Python 3.10.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/modal token new
```

Log in to the account that should pay for generation. Keep your Modal account
credentials on your computer—never paste them into the website or chat.

Create the dedicated API secret for the current production website:

```sh
.venv/bin/python backend/configure_generator.py --origin https://entrain-rouge.vercel.app
```

This creates a remote Modal Secret named `entrain-web`, but starts no GPU job.
It prints an **Entrain access token** once. Save it in your password manager. It
also generates a separate server-only job-signing key, which is not printed.
The script refuses to overwrite an existing secret. If you already created it,
skip this step; rotate it explicitly in Modal if necessary.

The secret contains:

- `ENTRAIN_API_TOKEN`: dedicated token entered in the browser.
- `ENTRAIN_JOB_SIGNING_KEY`: different random secret, never given to the browser.
- `ENTRAIN_ALLOWED_ORIGINS`: exact HTTPS origins, comma-separated, no trailing
  slash. Use your own website origin if you fork the frontend.

## 2. Upload the checkpoint and deploy

Obtain the EDGE checkpoint through the upstream project as described in
[SETUP.md](SETUP.md#2-edge-checkpoint). Do not put model weights in the public
frontend or repository. Only load a checkpoint from a trusted source: this
legacy inference environment loads Python pickle data.

From the repository root, run these once if the volume/checkpoint are not already
present in your current Modal environment:

```sh
.venv/bin/modal volume create entrain-assets
.venv/bin/modal volume put entrain-assets backend/checkpoints/checkpoint.pt /checkpoint.pt
```

Skip `volume create` if the volume exists; skip `volume put` if it already holds
the correct checkpoint. The Jukebox cache volume is created automatically.

Deploy the API and GPU definitions:

```sh
cd backend
../.venv/bin/modal deploy modal_app.py
cd ..
```

Save the HTTPS endpoint displayed for **web** (ending in `.modal.run`). This is
the generator URL, not the Modal dashboard URL. First-time image builds can take
a while. Deployment does not submit a dance-generation job.

## 3. Publish the updated frontend

The Vercel project is connected to GitHub: pushing to `main` builds and publishes
production automatically. Keep the project's **Root Directory** at `.` and
**Node.js Version** at `24.x`. Do not change the root to `frontend`, because the
build also needs `cpp/` and `assets/`.

The repository's `vercel.json` supplies the rest of the settings:

- Framework: **Other** (`null` in the config).
- Install command: `npm --prefix frontend ci`.
- Build command: `bash scripts/vercel-build.sh`.
- Output directory: **`frontend/dist`**, never the repository root.

The build script installs CMake if missing and downloads the pinned Emscripten
6.0.0 SDK in a temporary directory. It compiles C++ to WASM, builds the React
frontend, and runs the frontend tests (including WASM/TS parity) before publishing.
The first build takes longer because it downloads the compiler. It does not
deploy Modal, load model weights, or start GPU work.

For a manual source deployment, run from the repository root:

```sh
npx vercel --prod --project entrain
```

Use your existing project, not a new one. `.vercelignore` allows only the build
inputs, excluding backend files, model weights, local music, environment files,
and generated build directories from CLI uploads. To inspect the selected files
without uploading or deploying:

```sh
npx vercel deploy --dry --json --project entrain
```

Do not use the earlier `--cwd frontend/dist` workflow with this repository-linked
project: Vercel can resolve it back to the repository root. The source-build
configuration above now handles both GitHub and CLI deployments consistently.

To verify the build locally with an existing Emscripten 6.0.0 installation:

```sh
npm --prefix frontend ci
EMSDK="$HOME/emsdk" bash scripts/vercel-build.sh
```

No Vercel environment variables are required. In particular, never add API
tokens as `VITE_*` variables: those become public JavaScript. Answer **n** if the
CLI asks to pull development environment variables. The Entrain token belongs
only in your private Modal secret and the browser's generator connection panel.

## 4. Connect and generate

1. Open `https://entrain-rouge.vercel.app` and click **Connect generator**.
2. Enter the Modal **web** URL and your dedicated **Entrain access token**.
3. Click **Connect generator**. This authenticates against the CPU-only health
   endpoint; it does not start the GPU or prove that the checkpoint loads.
4. Upload a decodable audio file between **5 and 120 seconds**, at most **20 MiB**.
   This step starts billable GPU work. Start with a short clip.
5. Wait for the dance. The first job may need model downloads and initialization.

After a successful connection check, the URL and token are saved in this
browser's localStorage for this Entrain website. Reloading or reopening the
browser restores the connection. In generator settings, leave the token field
blank to keep the current token for the same URL, or enter a replacement token.
A different generator URL requires its own token. **Disconnect** removes the
saved connection; clearing this site's browser data also removes it. Private
browsing keeps settings only until the private session ends. If browser storage
is unavailable, the connection still works for the current page session.

The token is stored on this device and is accessible to scripts on this Entrain
website. Enter it only on a trusted frontend and send it only to your own
generator URL. Songs, dances, and running jobs are not saved by this setting.

## Limits, cancellation, and troubleshooting

- **Vercel says the page does not exist:** check that the latest deployment used
  `scripts/vercel-build.sh` and published `frontend/dist`. Serving the repository
  root without building produces a deployment with no root `index.html`.
- **Rejected token:** use the Entrain token, not a Modal account token. After
  changing a Modal Secret, redeploy so containers use the new values.
- **Cannot reach generator:** check the URL and Modal deployment logs. The exact
  website origin must be allowed; Vercel preview URLs are not allowed automatically.
  CORS controls browser access, not authentication; the bearer token protects the API.
- **Upload rejected:** size and decoding/duration checks happen on CPU before GPU
  submission. ffmpeg has a 30-second decoding limit and network protocols disabled.
- **Generation failed:** inspect Modal logs, checkpoint location, and model/image
  compatibility. A working health check does not validate the GPU environment.
- **Cancel generation:** requests remote cancellation and container termination.
  Check Modal if cancellation cannot be confirmed. Closing/reloading the page or
  clicking **Forget job** does not stop remote work or GPU billing.
- **Lost upload response:** do not immediately retry. The job may have started
  even if the browser never received its ID; check/cancel it in Modal first.
- **Spending:** the deployment allows one GPU container at a time, a 30-minute
  execution timeout, and five minutes of warm idle time. These are **not a spending
  cap**. Requests can queue, warm GPUs can cost money, and a leaked token permits
  paid generation. This API has no durable rate limit, user accounts, or quota
  system. Review your provider's billing controls before sharing access.
- **Job lifetime:** signed IDs expire after 24 hours and survive API container
  restarts. Modal may expire results too. Expiration does not cancel work. This
  app deletes its temporary audio files but does not guarantee immediate erasure
  from the cloud provider's input/output retention.
- **Revocation:** rotate `ENTRAIN_API_TOKEN` in the `entrain-web` secret and
  redeploy. Rotate the distinct signing key too if it leaked; doing so invalidates
  existing job IDs without cancelling those jobs.

The local `backend/app.py` server is an unauthenticated development helper with
in-memory jobs. Do **not** expose it publicly; use the Modal `web` API above.

## Local verification (no GPU calls)

Install ffmpeg locally for the audio-decoding tests (`brew install ffmpeg` on macOS).
From the repository root:

```sh
.venv/bin/python -m pip install -r backend/requirements-dev.txt
PYTHONPATH=backend .venv/bin/python -m unittest discover -s backend/tests -v
npm --prefix frontend run test
npm --prefix frontend run lint
npm --prefix frontend run build
```

Backend tests inject fake GPU calls, including the Modal polling adapter. They
cover auth, CORS, streaming upload limits, real ffmpeg normalization, signed job
IDs, restart behavior, and cancellation. Frontend tests cover the HTTP contract
and validate motion before it reaches WASM. These do not replace a real GPU smoke
test in your account.

Provider references: [Modal asynchronous HTTP jobs](https://modal.com/docs/guide/webhook-timeouts),
[Modal FunctionCall](https://modal.com/docs/reference/modal.FunctionCall), and
[Vercel CLI deployment](https://vercel.com/docs/cli/deploy).
