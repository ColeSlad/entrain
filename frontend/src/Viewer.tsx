import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { buildSkeleton, defaultParams, type BuiltSkeleton } from './retarget';
import { createTsCore, type CoreOutput, type MotionCore, type MotionInput, type Params } from './core/retargetCore';
import type { Motion } from './api';

export interface ViewerHandle {
  exportGLB: () => void;
}

// Flatten the Motion contract into the core's typed-array input.
function toMotionInput(m: Motion): MotionInput {
  const N = m.num_frames;
  const smplPoses = new Float32Array(N * 72);
  const rootTranslation = new Float32Array(N * 3);
  const footContact = new Float32Array(N * 4);
  for (let f = 0; f < N; f++) {
    const p = m.smpl_poses[f];
    for (let k = 0; k < 72; k++) smplPoses[f * 72 + k] = p[k];
    const t = m.root_translation[f];
    rootTranslation[f * 3] = t[0]; rootTranslation[f * 3 + 1] = t[1]; rootTranslation[f * 3 + 2] = t[2];
    const c = m.foot_contact?.[f];
    if (c) for (let k = 0; k < 4; k++) footContact[f * 4 + k] = c[k];
  }
  return { fps: m.fps, numFrames: N, smplPoses, rootTranslation, footContact };
}

// Write one frame of the core output onto the scene: every node's local
// rotation, plus the root node's grounded + foot-locked position.
function applyOutputFrame(built: BuiltSkeleton, out: CoreOutput, frame: number) {
  const n = built.skeleton.numBones;
  const N = out.rootPos.length / 3;
  const f = ((Math.floor(frame) % N) + N) % N;
  const lq = out.localQuat;
  const base = f * n * 4;
  for (let b = 0; b < n; b++) {
    const o = base + b * 4;
    built.nodes[b].quaternion.set(lq[o], lq[o + 1], lq[o + 2], lq[o + 3]);
  }
  built.nodes[0].position.set(out.rootPos[f * 3], out.rootPos[f * 3 + 1], out.rootPos[f * 3 + 2]);
}

const Viewer = forwardRef<ViewerHandle, { motion: Motion | null; frame: number; characterUrl: string; characterFbx: boolean }>(
  function Viewer({ motion, frame, characterUrl, characterFbx }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const coreRef = useRef<MotionCore | null>(null);
    const builtRef = useRef<BuiltSkeleton | null>(null);
    const outputRef = useRef<CoreOutput | null>(null);
    const motionRef = useRef<Motion | null>(motion);
    const frameRef = useRef(frame);
    const paramsRef = useRef<Params>(defaultParams());

    // Retarget the current clip through the core and cache the output buffer.
    // The render loop then just indexes into it (no per-frame core call).
    function setupAndCompute() {
      const built = builtRef.current, m = motionRef.current, core = coreRef.current;
      if (!built || !m || !core) return;
      core.setup(built.skeleton, toMotionInput(m), paramsRef.current);
      outputRef.current = core.computeAll();
    }

    useImperativeHandle(ref, () => ({
      // Bake the cached output into a GLTF AnimationClip (per-frame bone
      // rotations plus the root position) and download a .glb.
      exportGLB() {
        const built = builtRef.current, out = outputRef.current, m = motionRef.current;
        if (!built || !out || !m) return;
        const N = m.num_frames, fps = m.fps, n = built.skeleton.numBones;
        const times = new Float32Array(N);
        for (let i = 0; i < N; i++) times[i] = i / fps;

        // Animate only the mapped bones; everything else holds its rest pose.
        const mapped = Array.from(new Set(Array.from(built.skeleton.smplToTarget).filter((b) => b >= 0)));
        const tracks: THREE.KeyframeTrack[] = [];
        for (const b of mapped) {
          const q = new Float32Array(N * 4);
          for (let f = 0; f < N; f++) {
            const o = f * n * 4 + b * 4;
            q.set([out.localQuat[o], out.localQuat[o + 1], out.localQuat[o + 2], out.localQuat[o + 3]], f * 4);
          }
          tracks.push(new THREE.QuaternionKeyframeTrack(`${built.nodes[b].name}.quaternion`, times, q));
        }
        const root = built.nodes[0];
        if (!root.name) root.name = 'DanceRoot';
        tracks.push(new THREE.VectorKeyframeTrack(`${root.name}.position`, times, out.rootPos.slice(0, N * 3)));

        const clip = new THREE.AnimationClip('dance', N / fps, tracks);
        new GLTFExporter().parse(
          root,
          (result) => {
            const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'dance.glb';
            a.click();
            URL.revokeObjectURL(a.href);
          },
          (err) => console.error('GLB export failed', err),
          { binary: true, animations: [clip] },
        );
      },
    }), []);

    // New clip arrived: retarget it and show the current frame.
    useEffect(() => {
      motionRef.current = motion;
      if (builtRef.current && motion) {
        setupAndCompute();
        if (outputRef.current) applyOutputFrame(builtRef.current, outputRef.current, frameRef.current);
      }
    }, [motion]);

    // Frame changed (playback / scrub): index the cached buffer.
    useEffect(() => {
      frameRef.current = frame;
      if (builtRef.current && outputRef.current) {
        applyOutputFrame(builtRef.current, outputRef.current, frame);
      }
    }, [frame]);

    useEffect(() => {
      const mount = mountRef.current!;
      const w = () => window.innerWidth;
      const h = () => window.innerHeight;

      if (!coreRef.current) coreRef.current = createTsCore();

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111418);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));
      const dir = new THREE.DirectionalLight(0xffffff, 2.0);
      dir.position.set(3, 5, 4);
      scene.add(dir);

      const camera = new THREE.PerspectiveCamera(50, w() / h(), 0.01, 1000);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w(), h());
      mount.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);

      function frameObject(obj: THREE.Object3D) {
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        controls.target.copy(center);
        camera.position.set(center.x + maxDim * 0.8, center.y, center.z + maxDim * 1.6);
        camera.near = maxDim / 100;
        camera.far = maxDim * 100;
        camera.updateProjectionMatrix();
        controls.update();
        const grid = new THREE.GridHelper(maxDim * 6, 24, 0x444444, 0x2a2a2a);
        grid.position.y = box.min.y;
        scene.add(grid);
      }

      function onLoaded(root: THREE.Object3D) {
        scene.add(root);
        root.updateMatrixWorld(true);
        const built = buildSkeleton(root);
        if (!built.mappedCount) {
          console.error('No mixamorig bones found; upload a Mixamo-rigged character.');
        }
        builtRef.current = built;
        frameObject(root);
        if (motionRef.current) {
          setupAndCompute();
          if (outputRef.current) applyOutputFrame(built, outputRef.current, frameRef.current);
        }
        console.log(`retarget: mapped ${built.mappedCount} of 22 SMPL bones`);
      }
      const onErr = (e: unknown) => console.error('character load failed', e);
      // Mixamo exports FBX (bones named "mixamorig:Hips"); glTF tools rename to
      // "mixamorig_Hips". buildSkeleton normalizes both, so load either.
      if (characterFbx) {
        new FBXLoader().load(characterUrl, onLoaded, undefined, onErr);
      } else {
        new GLTFLoader().load(characterUrl, (g) => onLoaded(g.scene), undefined, onErr);
      }

      let raf = 0;
      function render() {
        raf = requestAnimationFrame(render);
        controls.update();
        renderer.render(scene, camera);
      }
      render();

      function onResize() {
        camera.aspect = w() / h();
        camera.updateProjectionMatrix();
        renderer.setSize(w(), h());
      }
      window.addEventListener('resize', onResize);

      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        controls.dispose();
        renderer.dispose();
        mount.removeChild(renderer.domElement);
      };
    }, [characterUrl, characterFbx]);

    return <div ref={mountRef} style={{ position: 'fixed', inset: 0 }} />;
  },
);

export default Viewer;
