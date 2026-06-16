import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { resolveTargetBones, buildRetargetTable, smplAnimGlobals, applyFrame } from './retarget';
import type { Motion } from './api';

type Table = ReturnType<typeof buildRetargetTable>;
type XZ = { x: number; z: number };

export interface ViewerHandle {
  exportGLB: () => void;
}

// 0 = centered (feet slide in place), 1 = lock the planted foot so it does not
// slide. Tune down if the travel still wanders too far.
const FOOT_LOCK = 1.0;
// Recentering window (frames): a slow moving average of the lock path is
// subtracted so the dancer foot-locks step to step but does not drift off.
const RECENTER_WIN = 61;

function showFrame(table: Table, motion: Motion, frame: number) {
  const f = ((Math.floor(frame) % motion.num_frames) + motion.num_frames) % motion.num_frames;
  applyFrame(table, smplAnimGlobals(motion.smpl_poses[f]));
}

const _foot = new THREE.Vector3();

function groundToFeet(root: THREE.Object3D, feet: THREE.Object3D[], groundY: number) {
  if (!feet.length) return;
  root.updateMatrixWorld(true);
  let minY = Infinity;
  for (const b of feet) minY = Math.min(minY, b.getWorldPosition(_foot).y);
  root.position.y += groundY - minY;
}

const _vp = new THREE.Vector3();

function movingAvg(p: XZ[], win: number): XZ[] {
  const half = (win - 1) / 2, n = p.length, out: XZ[] = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sz = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sx += p[j].x; sz += p[j].z; c++;
    }
    out.push({ x: sx / c, z: sz / c });
  }
  return out;
}

// Foot-locking: keep the planted (lower) foot horizontally fixed by offsetting
// the root, then high-pass so the dancer does not drift off. Precomputed once.
function computeRootPath(table: Table, motion: Motion, left: THREE.Object3D, right: THREE.Object3D, root: THREE.Object3D): XZ[] {
  const path: XZ[] = [];
  root.position.set(0, 0, 0);
  let anchorX = 0, anchorZ = 0, offX = 0, offZ = 0, prev = '';
  for (let f = 0; f < motion.num_frames; f++) {
    showFrame(table, motion, f);
    root.updateMatrixWorld(true);
    left.getWorldPosition(_vp);
    const lx = _vp.x, lz = _vp.z, ly = _vp.y;
    right.getWorldPosition(_vp);
    const rx = _vp.x, rz = _vp.z, ry = _vp.y;
    const supL = ly <= ry;
    const fx = supL ? lx : rx, fz = supL ? lz : rz, cur = supL ? 'L' : 'R';
    if (cur !== prev) { anchorX = fx + offX; anchorZ = fz + offZ; prev = cur; }
    offX = anchorX - fx;
    offZ = anchorZ - fz;
    path.push({ x: offX, z: offZ });
  }
  const smoothed = movingAvg(path, 7);
  const drift = movingAvg(smoothed, RECENTER_WIN);
  return smoothed.map((p, i) => ({ x: p.x - drift[i].x, z: p.z - drift[i].z }));
}

// Pose a frame and place the root (foot-lock + ground), shared by playback and
// the export bake so both produce identical motion.
function poseAt(table: Table, motion: Motion, frame: number, root: THREE.Object3D, feet: THREE.Object3D[], path: XZ[], groundY: number) {
  showFrame(table, motion, frame);
  const i = ((Math.floor(frame) % motion.num_frames) + motion.num_frames) % motion.num_frames;
  const off = path[i] ?? { x: 0, z: 0 };
  root.position.x = off.x * FOOT_LOCK;
  root.position.z = off.z * FOOT_LOCK;
  groundToFeet(root, feet, groundY);
}

const Viewer = forwardRef<ViewerHandle, { motion: Motion | null; frame: number; characterUrl: string; characterFbx: boolean }>(
  function Viewer({ motion, frame, characterUrl, characterFbx }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<Table | null>(null);
    const motionRef = useRef<Motion | null>(motion);
    const frameRef = useRef(frame);
    const rootObjRef = useRef<THREE.Object3D | null>(null);
    const feetRef = useRef<THREE.Object3D[]>([]);
    const lockFeetRef = useRef<[THREE.Object3D, THREE.Object3D] | null>(null);
    const groundYRef = useRef(0);
    const rootPathRef = useRef<XZ[]>([]);

    useImperativeHandle(ref, () => ({
      // Bake the current motion into a GLTF AnimationClip (bone rotations plus
      // the root's foot-locked, grounded position) and download a .glb.
      exportGLB() {
        const root = rootObjRef.current, table = tableRef.current, m = motionRef.current;
        if (!root || !table || !m) return;
        const N = m.num_frames, fps = m.fps;
        const times = new Float32Array(N);
        for (let i = 0; i < N; i++) times[i] = i / fps;
        const quat = table.map(() => new Float32Array(N * 4));
        const rootPos = new Float32Array(N * 3);
        for (let f = 0; f < N; f++) {
          poseAt(table, m, f, root, feetRef.current, rootPathRef.current, groundYRef.current);
          for (let b = 0; b < table.length; b++) {
            const q = table[b].bone.quaternion;
            quat[b].set([q.x, q.y, q.z, q.w], f * 4);
          }
          rootPos.set([root.position.x, root.position.y, root.position.z], f * 3);
        }
        const tracks: THREE.KeyframeTrack[] = table.map((row, b) =>
          new THREE.QuaternionKeyframeTrack(`${row.bone.name}.quaternion`, times, quat[b]));
        if (!root.name) root.name = 'DanceRoot';
        tracks.push(new THREE.VectorKeyframeTrack(`${root.name}.position`, times, rootPos));
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

    // Recompute the foot-locking path when a new clip arrives.
    useEffect(() => {
      const root = rootObjRef.current;
      if (tableRef.current && motion && root && lockFeetRef.current) {
        const [lf, rf] = lockFeetRef.current;
        rootPathRef.current = computeRootPath(tableRef.current, motion, lf, rf, root);
      }
    }, [motion]);

    useEffect(() => {
      motionRef.current = motion;
      frameRef.current = frame;
      const root = rootObjRef.current;
      if (tableRef.current && motion && root) {
        poseAt(tableRef.current, motion, frame, root, feetRef.current, rootPathRef.current, groundYRef.current);
      }
    }, [motion, frame]);

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
        const bones = resolveTargetBones(root);
        const table = buildRetargetTable(bones);
        if (!table.length) {
          console.error('No mixamorig bones found; upload a Mixamo-rigged character.');
        }
        tableRef.current = table;
        rootObjRef.current = root;
        const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase']
          .map((n) => bones.get(n))
          .filter((b): b is THREE.Bone => !!b);
        feetRef.current = feet;
        groundYRef.current = feet.reduce((m, b) => Math.min(m, b.getWorldPosition(_foot).y), Infinity);
        const lf = bones.get('LeftFoot');
        const rf = bones.get('RightFoot');
        if (lf && rf) lockFeetRef.current = [lf, rf];
        frameObject(root);
        if (motionRef.current && lf && rf) {
          rootPathRef.current = computeRootPath(table, motionRef.current, lf, rf, root);
          poseAt(table, motionRef.current, frameRef.current, root, feet, rootPathRef.current, groundYRef.current);
        }
        console.log(`retarget: mapped ${table.length} of 22 SMPL bones`);
      }
      const onErr = (e: unknown) => console.error('character load failed', e);
      // Mixamo exports FBX (bones named "mixamorig:Hips"); glTF tools rename to
      // "mixamorig_Hips". The retarget normalizes both, so load either.
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
