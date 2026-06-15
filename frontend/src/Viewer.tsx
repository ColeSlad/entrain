import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Section 8 Motion. Loaded from the committed fixture during seams-first dev.
interface Motion {
  fps: number;
  num_frames: number;
  smpl_poses: number[][]; // [num_frames][72] local axis-angle
  root_translation: number[][]; // [num_frames][3] meters, pelvis
  foot_contact: number[][];
  audio: unknown;
}

// SMPL 24-joint tree, names and parent indices (see
// reference/smpl_to_mixamo_retarget.js). Index order is parent-before-child.
const JOINT_NAMES = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
  'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
  'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
  'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hand', 'right_hand',
];
const PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];

// Placeholder rest offsets (parent -> child), Y-up, +X is the character's left,
// +Z forward, meters. The real SMPL joint locations come from the licensed
// model (Phase 1). These stand-in proportions are enough to validate the
// fixture seam: arms rest out to the sides so a shoulder rotation reads clearly.
const REST_OFFSETS: [number, number, number][] = [
  [0, 0, 0],          // pelvis
  [0.09, -0.06, 0],   // left_hip
  [-0.09, -0.06, 0],  // right_hip
  [0, 0.12, 0],       // spine1
  [0, -0.40, 0],      // left_knee
  [0, -0.40, 0],      // right_knee
  [0, 0.13, 0],       // spine2
  [0, -0.40, 0],      // left_ankle
  [0, -0.40, 0],      // right_ankle
  [0, 0.13, 0],       // spine3
  [0, -0.06, 0.12],   // left_foot
  [0, -0.06, 0.12],   // right_foot
  [0, 0.12, 0],       // neck
  [0.05, 0.10, 0],    // left_collar
  [-0.05, 0.10, 0],   // right_collar
  [0, 0.12, 0],       // head
  [0.11, 0.02, 0],    // left_shoulder
  [-0.11, 0.02, 0],   // right_shoulder
  [0.26, 0, 0],       // left_elbow
  [-0.26, 0, 0],      // right_elbow
  [0.24, 0, 0],       // left_wrist
  [-0.24, 0, 0],      // right_wrist
  [0.08, 0, 0],       // left_hand
  [-0.08, 0, 0],      // right_hand
];

// Color by side so the left/right validation (section 9) is unmistakable.
function sideColor(name: string): number {
  if (name.startsWith('left_')) return 0x39d353;
  if (name.startsWith('right_')) return 0xff5555;
  return 0xdddddd;
}

export default function Viewer() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current!;
    const w = () => window.innerWidth;
    const h = () => window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111418);
    scene.add(new THREE.GridHelper(6, 12, 0x444444, 0x2a2a2a));

    const camera = new THREE.PerspectiveCamera(50, w() / h(), 0.1, 100);
    camera.position.set(2.2, 1.4, 3.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w(), h());
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.update();

    // Build the skeleton: one node per joint, parented per the SMPL tree. Each
    // node sits at its rest offset, so Three's scene graph does the forward
    // kinematics for us. A bone line drawn in the parent frame to the child's
    // offset stays correct under any pose, since it transforms with the parent.
    const nodes: THREE.Object3D[] = [];
    const root = new THREE.Group();
    scene.add(root);
    const jointGeo = new THREE.SphereGeometry(0.025, 12, 12);
    for (let j = 0; j < JOINT_NAMES.length; j++) {
      const node = new THREE.Object3D();
      node.position.fromArray(REST_OFFSETS[j]);
      const color = sideColor(JOINT_NAMES[j]);
      node.add(new THREE.Mesh(jointGeo, new THREE.MeshBasicMaterial({ color })));
      nodes[j] = node;

      const p = PARENTS[j];
      if (p === -1) {
        root.add(node);
      } else {
        nodes[p].add(node);
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3().fromArray(REST_OFFSETS[j]),
        ]);
        nodes[p].add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
      }
    }

    const axis = new THREE.Vector3();
    const clock = new THREE.Clock();
    let motion: Motion | null = null;
    let raf = 0;

    function setFrame(f: number) {
      const poses = motion!.smpl_poses[f];
      for (let j = 0; j < nodes.length; j++) {
        const x = poses[j * 3], y = poses[j * 3 + 1], z = poses[j * 3 + 2];
        const angle = Math.hypot(x, y, z);
        if (angle < 1e-8) nodes[j].quaternion.set(0, 0, 0, 1);
        else nodes[j].quaternion.setFromAxisAngle(axis.set(x / angle, y / angle, z / angle), angle);
      }
      // Pelvis carries root translation. The fixture is Y-up; real SMPL data
      // would apply the COORD_FIX (reference, section 9) right here.
      nodes[0].position.fromArray(motion!.root_translation[f]);
    }

    function animate() {
      raf = requestAnimationFrame(animate);
      if (motion) {
        const f = Math.floor(clock.getElapsedTime() * motion.fps) % motion.num_frames;
        setFrame(f);
      }
      controls.update();
      renderer.render(scene, camera);
    }

    fetch('/sample_motion.json')
      .then((r) => r.json())
      .then((m: Motion) => { motion = m; clock.start(); })
      .catch((e) => console.error('failed to load sample_motion.json', e));

    animate();

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
