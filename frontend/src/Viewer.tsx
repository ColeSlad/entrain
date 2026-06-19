import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildSkeleton, type BuiltSkeleton } from './retarget';
import { createTsCore, type CoreOutput, type MotionCore, type MotionInput, type Params } from './core/retargetCore';
import { createWasmCore } from './core/wasm';
import type { Motion } from './api';

export interface ViewerHandle {
  exportGLB: () => void;
}

// Resolve the core kind once (WASM preferred, TS oracle fallback), then mint as
// many independent instances as the dancer field needs. The first call probes;
// later calls reuse the resolved kind.
let coreKind: 'wasm' | 'ts' | null = null;
async function makeCore(): Promise<MotionCore> {
  if (coreKind === 'ts') return createTsCore();
  if (coreKind === 'wasm') return createWasmCore();
  try {
    const c = await createWasmCore();
    coreKind = 'wasm';
    console.log('motion core: WASM');
    return c;
  } catch (err) {
    console.warn('WASM core load failed; using TS oracle fallback', err);
    coreKind = 'ts';
    return createTsCore();
  }
}

interface Dancer {
  index: number;
  group: THREE.Group; // placed at its grid cell; the clone sits inside it
  built: BuiltSkeleton;
  core: MotionCore;
  output: CoreOutput | null;
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

// Write one frame of a core's output onto its clone: every node's local
// rotation, plus the root node's grounded + foot-locked position (relative to
// the dancer's group, which carries the grid placement).
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

// Square-ish grid cells centered on the origin.
function gridCells(n: number, spacing: number): { x: number; z: number }[] {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    out.push({ x: (c - (cols - 1) / 2) * spacing, z: (r - (rows - 1) / 2) * spacing });
  }
  return out;
}

const Viewer = forwardRef<ViewerHandle, {
  motion: Motion | null;
  frame: number;
  characterUrl: string;
  characterFbx: boolean;
  count: number;
  params: Params;
}>(
  function Viewer({ motion, frame, characterUrl, characterFbx, count, params }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const gridRef = useRef<THREE.GridHelper | null>(null);
    const templateRef = useRef<THREE.Object3D | null>(null);
    const dancersRef = useRef<Dancer[]>([]);
    const rebuildToken = useRef(0);
    const motionRef = useRef<Motion | null>(motion);
    const frameRef = useRef(frame);
    const paramsRef = useRef<Params>(params);
    const countRef = useRef(count);

    // Phase offset spreads dancers across the clip so a crowd reads as a wave
    // rather than lockstep. Derived from the live motion length and field size.
    function phaseOf(index: number): number {
      const N = motionRef.current?.num_frames ?? 0;
      const n = dancersRef.current.length;
      return n > 1 ? Math.round((index * N) / n) : 0;
    }

    function applyField(f: number) {
      for (const d of dancersRef.current) {
        if (d.output) applyOutputFrame(d.built, d.output, f + phaseOf(d.index));
      }
    }

    // Retarget the current clip on every dancer's core. This is the K-times
    // work the WASM core makes cheap; it reruns on a param change (live tuning).
    function computeField() {
      const m = motionRef.current;
      if (!m) return;
      const mi = toMotionInput(m);
      for (const d of dancersRef.current) {
        d.core.setup(d.built.skeleton, mi, paramsRef.current);
        d.output = d.core.computeAll();
      }
      applyField(frameRef.current);
    }

    function frameGrid() {
      const scene = sceneRef.current, camera = cameraRef.current, controls = controlsRef.current;
      if (!scene || !camera || !controls || !dancersRef.current.length) return;
      const box = new THREE.Box3();
      for (const d of dancersRef.current) box.expandByObject(d.group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      controls.target.copy(center);
      camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.15, center.z + maxDim * 1.4);
      camera.near = maxDim / 100;
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.update();

      if (gridRef.current) scene.remove(gridRef.current);
      const grid = new THREE.GridHelper(maxDim * 3, 24, 0x444444, 0x2a2a2a);
      grid.position.set(center.x, box.min.y, center.z);
      scene.add(grid);
      gridRef.current = grid;
    }

    // Rebuild the whole field: clone the template count times, give each its own
    // core, lay them out, compute, and show the current frame. Core creation is
    // async, so a rebuild token discards a run that a newer one superseded.
    async function rebuildField() {
      const myToken = ++rebuildToken.current;
      const scene = sceneRef.current, template = templateRef.current;
      if (!scene || !template) return;
      const n = Math.max(1, countRef.current);

      const box = new THREE.Box3().setFromObject(template);
      const size = box.getSize(new THREE.Vector3());
      const spacing = (Math.max(size.x, size.z) || 1) * 1.6;
      const cells = gridCells(n, spacing);

      const next: Dancer[] = [];
      for (let i = 0; i < n; i++) {
        const clone = cloneSkeleton(template);
        const group = new THREE.Group();
        group.position.set(cells[i].x, 0, cells[i].z);
        group.add(clone);
        const built = buildSkeleton(clone);
        const core = await makeCore();
        next.push({ index: i, group, built, core, output: null });
      }
      if (myToken !== rebuildToken.current) { // superseded mid-build; discard
        for (const d of next) d.core.free();
        return;
      }
      for (const d of dancersRef.current) { d.core.free(); scene.remove(d.group); }
      dancersRef.current = next;
      for (const d of next) scene.add(d.group);
      computeField();
      frameGrid();
    }

    useImperativeHandle(ref, () => ({
      // Bake the first dancer's cached output into a GLTF AnimationClip and
      // download a .glb.
      exportGLB() {
        const d = dancersRef.current[0], m = motionRef.current;
        if (!d || !d.output || !m) return;
        const built = d.built, out = d.output;
        const N = m.num_frames, fps = m.fps, n = built.skeleton.numBones;
        const times = new Float32Array(N);
        for (let i = 0; i < N; i++) times[i] = i / fps;

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

    // New clip: recompute every dancer and show the frame.
    useEffect(() => {
      motionRef.current = motion;
      computeField();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [motion]);

    // Live tuning: changed params rerun the retarget on every dancer.
    useEffect(() => {
      paramsRef.current = params;
      computeField();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params]);

    // Dancer count changed: rebuild the field.
    useEffect(() => {
      countRef.current = count;
      void rebuildField();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [count]);

    // Frame changed (playback / scrub): index each dancer's cached buffer.
    useEffect(() => {
      frameRef.current = frame;
      applyField(frame);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frame]);

    // Scene setup and the character template load. Rebuilds the field when a new
    // character arrives.
    useEffect(() => {
      const mount = mountRef.current!;
      const w = () => window.innerWidth;
      const h = () => window.innerHeight;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111418);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));
      const dir = new THREE.DirectionalLight(0xffffff, 2.0);
      dir.position.set(3, 5, 4);
      scene.add(dir);
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(50, w() / h(), 0.01, 1000);
      cameraRef.current = camera;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w(), h());
      mount.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controlsRef.current = controls;

      const onErr = (e: unknown) => console.error('character load failed', e);
      function onTemplate(root: THREE.Object3D) {
        templateRef.current = root; // template only; clones are what get rendered
        void rebuildField();
      }
      // Mixamo exports FBX (bones named "mixamorig:Hips"); glTF tools rename to
      // "mixamorig_Hips". buildSkeleton normalizes both, so load either.
      if (characterFbx) {
        new FBXLoader().load(characterUrl, onTemplate, undefined, onErr);
      } else {
        new GLTFLoader().load(characterUrl, (g) => onTemplate(g.scene), undefined, onErr);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
        rebuildToken.current++; // cancel any in-flight rebuild
        for (const d of dancersRef.current) d.core.free();
        dancersRef.current = [];
        controls.dispose();
        renderer.dispose();
        mount.removeChild(renderer.domElement);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characterUrl, characterFbx]);

    return <div ref={mountRef} style={{ position: 'fixed', inset: 0 }} />;
  },
);

export default Viewer;
