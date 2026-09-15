# Saved Chopin demo

The audio is the user-provided recording of Frédéric Chopin's Prelude in A major,
Op. 28, No. 7 in the parent assets directory (43.702857 seconds, 376,507 bytes).
The owner approved this recording for public distribution as the demo.

`chopin-motion.json` is a real EDGE/Jukebox output from one Modal A10G invocation,
not the local development fixture: 1,275 frames at 30 fps, 42.5 seconds.
The complete recording was submitted; EDGE's 5-second windows at 2.5-second
stride cover the first 42.5 seconds. Playback clamps to the motion duration.
The original audio is unchanged. `chopin.mp3` is a byte-for-byte copy under a
portable ASCII filename; this avoids macOS/Linux Unicode filename differences.
The user's original recording is left untouched and need not be committed.

Generation run: https://modal.com/apps/coleslad/main/ap-arbqLp91hcQ87HXsAlFbvp

SHA-256:

- Audio: `e9436f2fc67a5d56933c431da38884504cf9574efab693230aeb32681fb5a003`
- Motion: `c2bf892f885587cb026ece4de668a84841b810f4cb904b51dbbf2d0e6720e1fa`

Vite emits the audio and JSON as separate content-hashed static assets. Loading,
playing, adjusting, and exporting the demo never calls Modal. Builds and tests
also do not generate motion. Model weights and account tokens are not included.
See [SETUP.md](../../docs/SETUP.md#regenerating-the-saved-demo) to intentionally
generate a replacement. The original recording's rights are distinct from
Chopin's composition; do not substitute unapproved recordings.
