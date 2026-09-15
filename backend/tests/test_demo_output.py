import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import modal_app
from pipeline.contracts import Motion


class DemoOutputTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((Path(__file__).parents[1] / "fixtures/sample_motion.json").read_text())
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audio = Path(self.directory.name) / "song.mp3"
        self.audio.write_bytes(b"test audio")
        self.output = Path(self.directory.name) / "demo/motion.json"

    def test_saves_validated_result_from_one_remote_call(self):
        with patch.object(modal_app, "Generator") as generator:
            generator.return_value.generate.remote.return_value = self.fixture
            modal_app.main(str(self.audio), str(self.output))
            generator.return_value.generate.remote.assert_called_once_with(b"test audio", "song.mp3")
        self.assertEqual(Motion.load(self.output).to_dict(), self.fixture)

    def test_existing_output_rejected_before_billable_work(self):
        with patch.object(modal_app, "Generator") as generator:
            with self.assertRaises(FileExistsError):
                modal_app.main(str(self.audio), str(self.audio))
            generator.assert_not_called()
        self.assertEqual(self.audio.read_bytes(), b"test audio")

    def test_failed_generation_not_retried_or_saved(self):
        with patch.object(modal_app, "Generator") as generator:
            generator.return_value.generate.remote.side_effect = RuntimeError("failed")
            with self.assertRaises(RuntimeError):
                modal_app.main(str(self.audio), str(self.output))
            generator.return_value.generate.remote.assert_called_once()
        self.assertFalse(self.output.exists())

    def test_malformed_result_not_saved(self):
        with patch.object(modal_app, "Generator") as generator:
            generator.return_value.generate.remote.return_value = {**self.fixture, "smpl_poses": []}
            with self.assertRaises(ValueError):
                modal_app.main(str(self.audio), str(self.output))
        self.assertFalse(self.output.exists())

    def test_nonfinite_result_not_saved(self):
        self.fixture["smpl_poses"][0][0] = float("nan")
        with patch.object(modal_app, "Generator") as generator:
            generator.return_value.generate.remote.return_value = self.fixture
            with self.assertRaises(ValueError):
                modal_app.main(str(self.audio), str(self.output))
        self.assertFalse(self.output.exists())
