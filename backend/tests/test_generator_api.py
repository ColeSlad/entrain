"""No cloud calls: exercise HTTP boundaries and the Modal adapter with fakes."""

import hashlib
import hmac
import io
import time
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import generator_api as api

TOKEN = "test-client-token-" * 3
SIGNING_KEY = "test-server-only-key-" * 3
ORIGIN = "https://entrain-rouge.vercel.app"
AUTH = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN}


class GeneratorApiTests(unittest.TestCase):
    def setUp(self):
        self.submit = AsyncMock(return_value="fc-test-call")
        self.poll = AsyncMock(return_value={"status": "running", "motion": None, "error": None})
        self.cancel = AsyncMock()
        self.normalize = Mock(return_value=b"normalized-wav")
        self.settings = dict(token=TOKEN, signing_key=SIGNING_KEY, allowed_origins=[ORIGIN],
                             submit=self.submit, poll=self.poll, cancel=self.cancel, normalize=self.normalize)
        self.client = TestClient(api.create_generator_api(**self.settings))

    def upload(self, data=b"test audio", **kwargs):
        return self.client.post("/jobs", files={"audio": ("song.wav", data, "audio/wav")},
                                headers=AUTH, **kwargs)

    def test_configuration_fails_closed(self):
        for changes in [dict(token=""), dict(signing_key=TOKEN), dict(allowed_origins=[]),
                        dict(allowed_origins=["*"]), dict(allowed_origins=[ORIGIN + "/"]),
                        dict(allowed_origins=["http://example.com"])]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                api.create_generator_api(**(self.settings | changes))

    def test_auth_precedes_body_parsing_and_all_job_operations(self):
        for method, path in [("GET", "/health"), ("POST", "/jobs"),
                             ("GET", "/jobs/fake"), ("DELETE", "/jobs/fake")]:
            for headers in [{}, {"Authorization": "Bearer wrong"}]:
                response = self.client.request(method, path, headers=headers, content=b"invalid body")
                self.assertEqual(response.status_code, 401)
        self.normalize.assert_not_called()
        self.submit.assert_not_awaited()
        self.poll.assert_not_awaited()
        self.cancel.assert_not_awaited()

    def test_health_checks_no_gpu_and_private_headers(self):
        response = self.client.get("/health", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["api_version"], 1)
        self.assertEqual(response.json()["max_upload_bytes"], api.MAX_UPLOAD_BYTES)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)
        self.submit.assert_not_awaited()
        self.normalize.assert_not_called()

    def test_cors_allows_exact_site_and_preflight_without_token(self):
        headers = {"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "Authorization,Content-Type"}
        self.assertEqual(self.client.options("/jobs", headers=headers).status_code, 200)
        response = self.client.options("/jobs", headers=headers | {"Origin": "https://untrusted.example"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("access-control-allow-origin", response.headers)
        response = self.client.get("/health", headers={"Origin": ORIGIN})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)

    def test_upload_poll_cancel_and_restart(self):
        response = self.upload()
        self.assertEqual(response.status_code, 202)
        identifier = response.json()["job_id"]
        self.normalize.assert_called_once_with(b"test audio")
        self.submit.assert_awaited_once_with(b"normalized-wav")
        # No process-local job dictionary: another API instance accepts this ID.
        restarted = TestClient(api.create_generator_api(**self.settings))
        self.assertEqual(restarted.get(f"/jobs/{identifier}", headers=AUTH).json()["status"], "running")
        self.poll.assert_awaited_once_with("fc-test-call")
        self.assertEqual(restarted.delete(f"/jobs/{identifier}", headers=AUTH).json()["status"], "cancelled")
        self.cancel.assert_awaited_once_with("fc-test-call")

    def test_missing_empty_extra_and_oversized_uploads_never_submit(self):
        self.assertEqual(self.client.post("/jobs", headers=AUTH).status_code, 422)
        self.assertEqual(self.upload(b"").status_code, 422)
        self.assertEqual(self.client.post("/jobs", headers=AUTH, files={"wrong": ("x", b"x")}).status_code, 422)
        self.assertEqual(self.client.post("/jobs", headers=AUTH, files={"audio": ("x", b"x")},
                                         data={"extra": "field"}).status_code, 400)
        with patch.object(api, "MAX_UPLOAD_BYTES", 1024):
            self.assertEqual(self.upload(b"x" * 1025).status_code, 413)
            # A streamed multipart request without Content-Length still has a limit.
            body = (b'--boundary\r\nContent-Disposition: form-data; name="audio"; filename="x.wav"\r\n'
                    b'Content-Type: audio/wav\r\n\r\n' + b"x" * 70000 + b'\r\n--boundary--\r\n')
            response = self.client.post("/jobs", headers=AUTH | {"Content-Type": "multipart/form-data; boundary=boundary"},
                                        content=iter([body[:4096], body[4096:]]))
            self.assertEqual(response.status_code, 413)
        self.submit.assert_not_awaited()
        self.normalize.assert_not_called()

    def test_decode_failure_prevents_gpu_and_submission_failure_is_generic(self):
        self.normalize.side_effect = HTTPException(422, "bad audio")
        self.assertEqual(self.upload().status_code, 422)
        self.submit.assert_not_awaited()
        self.normalize.side_effect = None
        self.submit.side_effect = RuntimeError("private provider details")
        with self.assertLogs("generator_api", level="ERROR"):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private provider details", response.text)

    def test_tampered_unicode_expired_and_client_forged_ids(self):
        identifier = self.upload().json()["job_id"]
        payload = identifier.rpartition(".")[0]
        forged = payload + "." + hmac.new(TOKEN.encode(), payload.encode(), hashlib.sha256).hexdigest()
        for invalid in [identifier + "x", "fc-test.123.é", "x" * 513, forged]:
            for method in ["GET", "DELETE"]:
                self.assertEqual(self.client.request(method, f"/jobs/{invalid}", headers=AUTH).status_code, 404)
        with patch.object(api.time, "time", return_value=time.time() + api.JOB_TTL_SECONDS + 1):
            self.assertEqual(self.client.get(f"/jobs/{identifier}", headers=AUTH).status_code, 410)
        self.poll.assert_not_awaited()
        self.cancel.assert_not_awaited()


def wav_bytes(seconds, channels=1, rate=8000):
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * rate * seconds * channels)
    return data.getvalue()


class AudioNormalizationTests(unittest.TestCase):
    def test_real_ffmpeg_normalizes_stereo_and_sample_rate(self):
        result = api.normalize_audio(wav_bytes(6, channels=2))
        with wave.open(io.BytesIO(result), "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getframerate(), 22050)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertEqual(audio.getnframes() / audio.getframerate(), 6)

    def test_short_long_and_undecodable_audio_rejected(self):
        with patch.object(api, "MAX_DURATION_SECONDS", 6):
            for data in [wav_bytes(4), wav_bytes(8), b"not audio"]:
                with self.subTest(length=len(data)), self.assertRaises(HTTPException) as raised:
                    api.normalize_audio(data)
                self.assertEqual(raised.exception.status_code, 422)


class ModalAdapterTests(unittest.TestCase):
    def test_pending_complete_expired_failed_and_cancel_without_cloud(self):
        import modal
        import modal_app

        fake = SimpleNamespace(get=SimpleNamespace(aio=AsyncMock()), cancel=SimpleNamespace(aio=AsyncMock()))
        env = {"ENTRAIN_API_TOKEN": TOKEN, "ENTRAIN_JOB_SIGNING_KEY": SIGNING_KEY,
               "ENTRAIN_ALLOWED_ORIGINS": ORIGIN}
        with patch.dict("os.environ", env), patch.object(modal.FunctionCall, "from_id", return_value=fake):
            client = TestClient(modal_app.web.get_raw_f()())
            payload = f"fc-fake.{int(time.time()) + 100}"
            identifier = payload + "." + hmac.new(SIGNING_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
            path = f"/jobs/{identifier}"
            fake.get.aio.side_effect = TimeoutError()  # SDK get(timeout=0) uses the builtin.
            self.assertEqual(client.get(path, headers=AUTH).json()["status"], "running")
            fake.get.aio.assert_awaited_with(timeout=0)
            fake.get.aio.side_effect = None
            fake.get.aio.return_value = {"test": "motion"}
            self.assertEqual(client.get(path, headers=AUTH).json()["motion"], {"test": "motion"})
            fake.get.aio.side_effect = modal.exception.FunctionTimeoutError("execution timeout")
            self.assertEqual(client.get(path, headers=AUTH).json()["status"], "error")
            fake.get.aio.side_effect = modal.exception.OutputExpiredError("expired")
            self.assertEqual(client.get(path, headers=AUTH).status_code, 410)
            self.assertEqual(client.delete(path, headers=AUTH).status_code, 200)
            fake.cancel.aio.assert_awaited_once_with(terminate_containers=True)


if __name__ == "__main__":
    unittest.main()
