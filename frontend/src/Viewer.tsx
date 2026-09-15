import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildSkeleton, type BuiltSkeleton } from './retarget';
import type { Params } from './core/retargetCore';
import { toMotionInput } from './core/motionInput';
import { FieldWorker } from './core/fieldWorker';
import { optimizeCharacter } from './optimizeCharacter';
import type { Motion } from './api';

export interface ViewerHandle {
  exportGLB: () => Promise<void>;
  resetCamera: () => void;
}

interface Dancer {
  group: THREE.Group;
  built: BuiltSkeleton;
}

interface Character {
  root: THREE.Object3D;
  built: BuiltSkeleton;
  bounds: THREE.Box3;
  animated: number[];
}

// Clones share geometry/materials, but own their bone textures.
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
  const [characterState, setCharacterState] = useState<{ url: string; error: boolean } | null>(null);
  const inputs = useRef({ motion, frame, settings: { count, params, variation } });
  const sceneRef = useRef<{ sync: () => void; exportGLB: () => Promise<void>; resetCamera: () => void } | null>(null);

  useImperativeHandle(ref, () => ({
    exportGLB: async () => {
      if (!sceneRef.current) throw new Error('The character is still loading. Try exporting again in a moment.');
      await sceneRef.current.exportGLB();
    },
    resetCamera: () => sceneRef.current?.resetCamera(),
  }), []);

  useEffect(() => {
    inputs.current = { motion, frame, settings: { count, params, variation } };
    sceneRef.current?.sync();
  }, [motion, frame, count, params, variation]);

  useEffect(() => {
    const mount = mountRef.current!;
    let disposed = false, raf = 0, resizeFrame = 0;
    let character: Character | null = null;
    let applied = inputs.current;
    let layout = { cols: 1, rows: 1, spacing: 1 };
    const dancers: Dancer[] = [];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111418);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(3, 5, 4);
    scene.add(light);
    const width = Math.max(mount.clientWidth, 1), height = Math.max(mount.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.domElement.setAttribute('aria-label', '3D dance preview. Drag to orbit and scroll to zoom.');
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotionPreference = () => { controls.enableDamping = !reducedMotion.matches; };
    updateMotionPreference();
    reducedMotion.addEventListener('change', updateMotionPreference);
    controls.dampingFactor = 0.12;
    const grid = new THREE.GridHelper(1, 24, 0x444444, 0x2a2a2a);
    scene.add(grid);

    const worker = new FieldWorker((poses, readyCount) => {
      if (disposed || !character) return;
      const n = character.built.skeleton.numBones, stride = n * 4 + 3;
      for (let i = 0; i < Math.min(readyCount, dancers.length); i++) {
        const offset = i * stride, nodes = dancers[i].built.nodes;
        // Only animated bones and the root need local-matrix updates.
        for (const b of character.animated) {
          nodes[b].quaternion.fromArray(poses, offset + b * 4);
          nodes[b].updateMatrix();
        }
        nodes[0].position.fromArray(poses, offset + n * 4);
        nodes[0].updateMatrix();
      }
    });
    worker.tune(inputs.current.settings);

    function configureMotion(): void {
      if (character) {
        const m = inputs.current.motion;
        worker.configure(character.built.skeleton, m ? toMotionInput(m) : null);
      }
    }

    function placeDancer(d: Dancer, i: number): void {
      const { cols, rows, spacing } = layout;
      d.group.position.set(((i % cols) - (cols - 1) / 2) * spacing, 0,
        (Math.floor(i / cols) - (rows - 1) / 2) * spacing);
      d.group.updateMatrix();
    }

    function scheduleResize(): void {
      if (!character) return;
      // Compute layout once per count change, using cached template bounds.
      const n = inputs.current.settings.count;
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const size = character.bounds.getSize(new THREE.Vector3());
      const spacing = (Math.max(size.x, size.z) || 1) * 1.6;
      layout = { cols, rows, spacing };
      dancers.forEach(placeDancer);
      const maxDim = Math.max(size.x + (cols - 1) * spacing, size.y, size.z + (rows - 1) * spacing) || 1;
      const center = character.bounds.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      const fit = Math.max(1, 1 / camera.aspect);
      camera.position.set(center.x + maxDim * 0.7 * fit, center.y + maxDim * 0.15 * fit, center.z + maxDim * 1.4 * fit);
      camera.near = maxDim / 100;
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.update();
      controls.saveState();
      grid.position.set(center.x, character.bounds.min.y, center.z);
      grid.scale.setScalar(maxDim * 3);
      if (!resizeFrame) resizeFrame = requestAnimationFrame(resizeField);
    }

    function resizeField(): void {
      resizeFrame = 0;
      if (!character) return;
      const target = inputs.current.settings.count;
      const deadline = performance.now() + 4;
      // Each batch reads the latest target and yields to input/rendering.
      while (dancers.length !== target) {
        if (dancers.length > target) {
          disposeDancer(dancers.pop()!);
        } else {
          const clone = cloneSkeleton(character.root);
          const nodes: THREE.Object3D[] = [];
          clone.traverse((node) => {
            nodes.push(node);
            node.updateMatrix();
            node.matrixAutoUpdate = false;
          });
          const group = new THREE.Group();
          group.matrixAutoUpdate = false;
          group.add(clone);
          const d = { group, built: { ...character.built, nodes } };
          placeDancer(d, dancers.length);
          dancers.push(d);
          scene.add(group);
        }
        if (performance.now() >= deadline) break;
      }
      if (dancers.length !== target) resizeFrame = requestAnimationFrame(resizeField);
      worker.invalidateFrame(); // newly added clones also need a pose while paused
    }

    async function exportGLB(): Promise<void> {
      const d = dancers[0];
      if (!d || !character || !inputs.current.motion) {
        throw new Error('Wait for the character and dance to finish loading, then try exporting again.');
      }
      try {
        const out = await worker.bake();
        if (disposed) throw new Error('The character changed during export. Please try again.');
        const { numFrames: N, fps, numBones: n } = out;
        const times = Float32Array.from({ length: N }, (_, i) => i / fps);
        const tracks: THREE.KeyframeTrack[] = [];
        for (const b of character.animated) {
          const q = new Float32Array(N * 4);
          for (let f = 0; f < N; f++) q.set(out.localQuat.subarray((f * n + b) * 4, (f * n + b + 1) * 4), f * 4);
          tracks.push(new THREE.QuaternionKeyframeTrack(d.built.nodes[b].name + '.quaternion', times, q));
        }
        const root = d.built.nodes[0];
        if (!root.name) root.name = 'DanceRoot';
        tracks.push(new THREE.VectorKeyframeTrack(root.name + '.position', times, out.rootPos));
        const clip = new THREE.AnimationClip('dance', N / fps, tracks);
        const result = await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip] });
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'dance.glb';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (error) {
        console.error('GLB export failed', error);
        throw new Error('Could not export the dance. Check that your character is loaded and try again.', { cause: error });
      }
    }

    sceneRef.current = {
      exportGLB,
      resetCamera: () => controls.reset(),
      sync() {
        const next = inputs.current, a = applied.settings, b = next.settings;
        if (next.motion !== applied.motion) configureMotion();
        if (a.count !== b.count || a.params !== b.params || a.variation !== b.variation) worker.tune(b);
        if (a.count !== b.count) scheduleResize();
        applied = next;
      },
    };

    function onTemplate(root: THREE.Object3D): void {
      if (disposed) return;
      optimizeCharacter(root);
      const built = buildSkeleton(root);
      const bounds = new THREE.Box3().setFromObject(root);
      root.traverse((node) => {
        const mesh = node as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh) {
          // Clones inherit this bound instead of rescanning vertices on first render.
          mesh.boundingSphere = mesh.boundingBox!.getBoundingSphere(new THREE.Sphere());
          mesh.boundingSphere.radius *= 1.5;
        }
      });
      const animated = Array.from(new Set(Array.from(built.skeleton.smplToTarget).filter((b) => b >= 0)));
      character = { root, built, bounds, animated };
      configureMotion();
      scheduleResize();
      setCharacterState({ url: characterUrl, error: false });
    }
    const onError = (error: unknown) => {
      console.error('Character load failed', error);
      if (!disposed) setCharacterState({ url: characterUrl, error: true });
    };
    if (characterFbx) new FBXLoader().load(characterUrl, onTemplate, undefined, onError);
    else new GLTFLoader().load(characterUrl, (gltf) => onTemplate(gltf.scene), undefined, onError);

    function render(): void {
      raf = requestAnimationFrame(render);
      worker.requestFrame(inputs.current.frame);
      controls.update();
      renderer.render(scene, camera);
    }
    render();
    function onResize(): void {
      const nextWidth = Math.max(mount.clientWidth, 1), nextHeight = Math.max(mount.clientHeight, 1);
      // Preserve framing when the inspector or viewport changes the canvas size.
      const previousFit = Math.max(1, 1 / camera.aspect);
      camera.aspect = nextWidth / nextHeight;
      const nextFit = Math.max(1, 1 / camera.aspect);
      camera.position.sub(controls.target).multiplyScalar(nextFit / previousFit).add(controls.target);
      controls.position0.sub(controls.target0).multiplyScalar(nextFit / previousFit).add(controls.target0);
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener('change', updateMotionPreference);
      sceneRef.current = null;
      worker.dispose();
      dancers.forEach(disposeDancer);
      controls.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [characterUrl, characterFbx]);

  const loaded = characterState?.url === characterUrl;
  return <div className="viewer" ref={mountRef}>
    {!loaded && <div className="viewer-message" role="status"><span className="spinner" />Loading character…</div>}
    {loaded && characterState.error && <div className="viewer-message viewer-message-error" role="status">
      <strong>Couldn’t load this character</strong><p>Choose another rigged GLB, GLTF, or FBX file using Character above.</p>
    </div>}
  </div>;
});

export default Viewer;
