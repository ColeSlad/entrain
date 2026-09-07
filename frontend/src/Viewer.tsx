import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildSkeleton, type BuiltSkeleton } from './retarget';
import type { MotionInput, Params } from './core/retargetCore';
import { FieldWorker } from './core/fieldWorker';
import { optimizeCharacter } from './optimizeCharacter';
import type { Motion } from './api';

export interface ViewerHandle {
  exportGLB: () => void;
}

interface Dancer {
  group: THREE.Group;
  built: BuiltSkeleton;
}

function toMotionInput(m: Motion): MotionInput {
  return {
    fps: m.fps,
    numFrames: m.num_frames,
    smplPoses: Float32Array.from(m.smpl_poses.flat()),
    rootTranslation: Float32Array.from(m.root_translation.flat()),
    footContact: m.foot_contact ? Float32Array.from(m.foot_contact.flat()) : new Float32Array(m.num_frames * 4),
  };
}

// Clones share the template's geometry/materials, but own their bone textures.
function disposeDancer(d: Dancer): void {
  const skeletons = new Set<THREE.Skeleton>();
  d.group.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  d.group.removeFromParent();
}

const Viewer = forwardRef<ViewerHandle, {
  motion: Motion | null;
  frame: number;
  characterUrl: string;
  characterFbx: boolean;
  count: number;
  params: Params;
  variation: number;
}>(function Viewer({ motion, frame, characterUrl, characterFbx, count, params, variation }, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const templateRef = useRef<THREE.Object3D | null>(null);
  const builtRef = useRef<BuiltSkeleton | null>(null);
  const boundsRef = useRef<THREE.Box3 | null>(null);
  const animatedRef = useRef<number[]>([]);
  const dancersRef = useRef<Dancer[]>([]);
  const workerRef = useRef<FieldWorker | null>(null);
  const resizeRef = useRef(0);
  const motionRef = useRef<Motion | null>(motion);
  const frameRef = useRef(frame);
  const paramsRef = useRef(params);
  const countRef = useRef(count);
  const variationRef = useRef(variation);

  function placeDancer(d: Dancer, i: number): void {
    const n = countRef.current;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const size = boundsRef.current!.getSize(new THREE.Vector3());
    const spacing = (Math.max(size.x, size.z) || 1) * 1.6;
    d.group.position.set(((i % cols) - (cols - 1) / 2) * spacing, 0,
      (Math.floor(i / cols) - (rows - 1) / 2) * spacing);
    d.group.updateMatrix();
  }

  function frameGrid(): void {
    const camera = cameraRef.current, controls = controlsRef.current, bounds = boundsRef.current;
    if (!camera || !controls || !bounds) return;
    // Use the template bounds and grid dimensions. Computing a skinned bounding
    // box for every clone revisits every vertex and stalls large count changes.
    const n = countRef.current;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const size = bounds.getSize(new THREE.Vector3());
    const spacing = (Math.max(size.x, size.z) || 1) * 1.6;
    const maxDim = Math.max(size.x + (cols - 1) * spacing, size.y, size.z + (rows - 1) * spacing) || 1;
    const center = bounds.getCenter(new THREE.Vector3());
    controls.target.copy(center);
    camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.15, center.z + maxDim * 1.4);
    camera.near = maxDim / 100;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.update();
    gridRef.current!.position.set(center.x, bounds.min.y, center.z);
    gridRef.current!.scale.setScalar(maxDim * 3);
  }

  function resizeField(): void {
    resizeRef.current = 0;
    const scene = sceneRef.current, template = templateRef.current, built = builtRef.current;
    if (!scene || !template || !built) return;
    const dancers = dancersRef.current;
    const deadline = performance.now() + 4;
    // Keep existing clones and only add/remove the difference. A short batch
    // yields to input/rendering; the next batch reads the latest slider target.
    do {
      if (dancers.length > countRef.current) {
        disposeDancer(dancers.pop()!);
      } else if (dancers.length < countRef.current) {
        const clone = cloneSkeleton(template);
        const nodes: THREE.Object3D[] = [];
        clone.traverse((node) => {
          nodes.push(node);
          node.updateMatrix();
          node.matrixAutoUpdate = false;
        });
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        group.add(clone);
        const d = { group, built: { ...built, nodes } };
        placeDancer(d, dancers.length);
        dancers.push(d);
        scene.add(group);
      } else {
        break;
      }
    } while (performance.now() < deadline);
    if (dancers.length !== countRef.current) resizeRef.current = requestAnimationFrame(resizeField);
    // A paused scene must also receive a pose for newly added clones.
    workerRef.current?.invalidateFrame();
  }

  function scheduleResize(): void {
    if (!builtRef.current) return;
    dancersRef.current.forEach(placeDancer);
    frameGrid();
    if (!resizeRef.current) resizeRef.current = requestAnimationFrame(resizeField);
  }

  async function exportGLB(): Promise<void> {
    const d = dancersRef.current[0], worker = workerRef.current;
    if (!d || !worker || !motionRef.current) return;
    try {
      const out = await worker.bake();
      if (workerRef.current !== worker) return;
      const { numFrames: N, fps, numBones: n } = out;
      const times = Float32Array.from({ length: N }, (_, i) => i / fps);
      const tracks: THREE.KeyframeTrack[] = [];
      for (const b of animatedRef.current) {
        const q = new Float32Array(N * 4);
        for (let f = 0; f < N; f++) q.set(out.localQuat.subarray((f * n + b) * 4, (f * n + b + 1) * 4), f * 4);
        tracks.push(new THREE.QuaternionKeyframeTrack(d.built.nodes[b].name + '.quaternion', times, q));
      }
      const root = d.built.nodes[0];
      if (!root.name) root.name = 'DanceRoot';
      tracks.push(new THREE.VectorKeyframeTrack(root.name + '.position', times, out.rootPos));
      const clip = new THREE.AnimationClip('dance', N / fps, tracks);
      new GLTFExporter().parse(root, (result) => {
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'dance.glb';
        a.click();
        URL.revokeObjectURL(a.href);
      }, (error) => console.error('GLB export failed', error), { binary: true, animations: [clip] });
    } catch (error) {
      console.error('GLB export failed', error);
    }
  }

  useImperativeHandle(ref, () => ({ exportGLB: () => { void exportGLB(); } }), []);

  useEffect(() => {
    motionRef.current = motion;
    const built = builtRef.current;
    if (built) workerRef.current?.configure(built.skeleton, motion ? toMotionInput(motion) : null);
  }, [motion]);

  useEffect(() => {
    const changedCount = countRef.current !== count;
    paramsRef.current = params;
    countRef.current = count;
    variationRef.current = variation;
    workerRef.current?.tune({ count, params, variation });
    if (changedCount) scheduleResize();
    // Functions read current scene refs, including across character changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, variation, count]);

  useEffect(() => { frameRef.current = frame; }, [frame]);

  useEffect(() => {
    const mount = mountRef.current!;
    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111418);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(3, 5, 4);
    scene.add(light);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    const grid = new THREE.GridHelper(1, 24, 0x444444, 0x2a2a2a);
    scene.add(grid);
    gridRef.current = grid;

    const worker = new FieldWorker((poses, readyCount) => {
      if (disposed || !builtRef.current) return;
      const n = builtRef.current.skeleton.numBones;
      const stride = n * 4 + 3;
      const dancers = dancersRef.current;
      for (let i = 0; i < Math.min(readyCount, dancers.length); i++) {
        const offset = i * stride, nodes = dancers[i].built.nodes;
        // Unmapped nodes retain their rest transforms. Only animated bones and
        // the root need local-matrix updates, once per incoming motion frame.
        for (const b of animatedRef.current) {
          const o = offset + b * 4;
          nodes[b].quaternion.fromArray(poses, o);
          nodes[b].updateMatrix();
        }
        nodes[0].position.fromArray(poses, offset + n * 4);
        nodes[0].updateMatrix();
      }
    });
    workerRef.current = worker;
    worker.tune({ count: countRef.current, params: paramsRef.current, variation: variationRef.current });

    function onTemplate(root: THREE.Object3D): void {
      if (disposed) return;
      optimizeCharacter(root);
      templateRef.current = root;
      builtRef.current = buildSkeleton(root);
      boundsRef.current = new THREE.Box3().setFromObject(root);
      root.traverse((node) => {
        const mesh = node as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh) {
          // Clones inherit this bound, avoiding a vertex-by-vertex sphere
          // calculation on their first render. Leave room for dancing limbs.
          mesh.boundingSphere = mesh.boundingBox!.getBoundingSphere(new THREE.Sphere());
          mesh.boundingSphere.radius *= 1.5;
        }
      });
      animatedRef.current = Array.from(new Set(Array.from(builtRef.current.skeleton.smplToTarget).filter((b) => b >= 0)));
      const m = motionRef.current;
      worker.configure(builtRef.current.skeleton, m ? toMotionInput(m) : null);
      scheduleResize();
    }
    const onError = (error: unknown) => console.error('Character load failed', error);
    if (characterFbx) new FBXLoader().load(characterUrl, onTemplate, undefined, onError);
    else new GLTFLoader().load(characterUrl, (gltf) => onTemplate(gltf.scene), undefined, onError);

    let raf = 0;
    function render(): void {
      raf = requestAnimationFrame(render);
      worker.requestFrame(frameRef.current);
      controls.update();
      renderer.render(scene, camera);
    }
    render();
    function onResize(): void {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRef.current);
      resizeRef.current = 0;
      window.removeEventListener('resize', onResize);
      worker.dispose();
      workerRef.current = null;
      for (const d of dancersRef.current) disposeDancer(d);
      dancersRef.current = [];
      templateRef.current = null;
      builtRef.current = null;
      boundsRef.current = null;
      controls.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterUrl, characterFbx]);

  return <div ref={mountRef} style={{ position: 'fixed', inset: 0 }} />;
});

export default Viewer;
