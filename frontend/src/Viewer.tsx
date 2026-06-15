import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveTargetBones, buildRetargetTable, smplAnimGlobals, applyFrame } from './retarget';
import type { Motion } from './api';

type Table = ReturnType<typeof buildRetargetTable>;

// Pose the character to one frame. frame may be fractional (App's clock); we
// floor and wrap it. Rotations only for now; root translation is Phase 4 work.
function showFrame(table: Table, motion: Motion, frame: number) {
  const f = ((Math.floor(frame) % motion.num_frames) + motion.num_frames) % motion.num_frames;
  applyFrame(table, smplAnimGlobals(motion.smpl_poses[f]));
}

// Controlled viewer: App owns playback and passes the current frame. The WebGL
// loop renders continuously (so orbit stays live); the pose updates whenever
// the frame or motion changes.
export default function Viewer({ motion, frame }: { motion: Motion | null; frame: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<Table | null>(null);
  const motionRef = useRef<Motion | null>(motion);
  const frameRef = useRef(frame);

  useEffect(() => {
    motionRef.current = motion;
    frameRef.current = frame;
    if (tableRef.current && motion) showFrame(tableRef.current, motion, frame);
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

    // Frame the camera to whatever scale the GLB uses (Mixamo exports vary
    // between meters and centimeters).
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
      const grid = new THREE.GridHelper(maxDim * 3, 12, 0x444444, 0x2a2a2a);
      grid.position.y = box.min.y;
      scene.add(grid);
    }

    new GLTFLoader().load(
      '/character.glb',
      (g) => {
        const root = g.scene;
        scene.add(root);
        root.updateMatrixWorld(true);
        const table = buildRetargetTable(resolveTargetBones(root));
        tableRef.current = table;
        frameObject(root);
        if (motionRef.current) showFrame(table, motionRef.current, frameRef.current);
        console.log(`retarget: mapped ${table.length} of 22 SMPL bones`);
      },
      undefined,
      (e) => console.error('character load failed', e),
    );

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
  }, []);

  return <div ref={mountRef} style={{ position: 'fixed', inset: 0 }} />;
}
