import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { optimizeCharacter } from '../src/optimizeCharacter';

it('reduces default-character vertices while preserving every triangle attribute', async () => {
  const glb = readFileSync(new URL('../../assets/character.glb', import.meta.url));
  const { scene } = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  const originals = new Map<THREE.Mesh, THREE.BufferGeometry>();
  scene.traverse((node) => { if ((node as THREE.Mesh).isMesh) originals.set(node as THREE.Mesh, (node as THREE.Mesh).geometry); });
  optimizeCharacter(scene);
  let before = 0, after = 0, maxError = 0;
  for (const [mesh, original] of originals) {
    const optimized = mesh.geometry;
    before += original.attributes.position.count;
    after += optimized.attributes.position.count;
    expect(optimized.index!.count).toBe(original.index?.count ?? original.attributes.position.count);
    expect(optimized.groups).toEqual(original.groups);
    for (const [name, attribute] of Object.entries(original.attributes)) {
      const actual = optimized.attributes[name];
      for (let triangleVertex = 0; triangleVertex < optimized.index!.count; triangleVertex++) {
        const vertex = original.index?.getX(triangleVertex) ?? triangleVertex;
        const index = optimized.index!.getX(triangleVertex);
        for (let component = 0; component < attribute.itemSize; component++) {
          maxError = Math.max(maxError, Math.abs(attribute.getComponent(vertex, component) - actual.getComponent(index, component)));
        }
      }
    }
  }
  expect(after).toBeLessThan(before / 4);
  expect(maxError).toBeLessThan(1e-6);
});
