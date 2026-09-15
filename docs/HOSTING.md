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

The previously deployed site needs the new generator settings UI. From the
repository root, using Node 24 and the Emscripten/CMake toolchain from
[SETUP.md](SETUP.md#6-wasm-motion-core-toolchain):

```sh
npm --prefix frontend ci
npm --prefix frontend run build
npx vercel --cwd frontend/dist --prod
```

When prompted, link to your **existing Entrain Vercel project**, so production
continues using `https://entrain-rouge.vercel.app`. For this prebuilt static
deployment, use framework **Other**, no build command, and output directory `.`.
Do not choose a new project. Rebuilding `dist` can remove its local `.vercel`
linking metadata, so be prepared to select the existing project again.

No Vercel environment variables are required. In particular, never add API
tokens as `VITE_*` variables: those become public JavaScript. This workflow builds
WASM locally; automatic Git-based Vercel builds would need their own Emscripten
setup and are not configured by these commands.

## 4. Connect and generate

1. Open `https://entrain-rouge.vercel.app` and expand **Generator**.
2. Enter the Modal **web** URL and your dedicated **Entrain access token**.
3. Click **Connect generator**. This authenticates against the CPU-only health
   endpoint; it does not start the GPU or prove that the checkpoint loads.
4. Upload a decodable audio file between **5 and 120 seconds**, at most **20 MiB**.
   This step starts billable GPU work. Start with a short clip.
5. Wait for the dance. The first job may need model downloads and initialization.

The token is held only in page memory, not localStorage, sessionStorage, or a
cookie. Disconnecting or reloading clears it, so reconnect after a refresh. Enter
it only on a trusted Entrain frontend and send it only to your own generator URL.

## Limits, cancellation, and troubleshooting

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
