import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The default character repeats its vertices for every triangle.
// Index matching attributes once at load time, then every clone shares the
// optimized geometry. Normals, UV seams, bone indices and weights remain intact.
export function optimizeCharacter(root: THREE.Object3D): void {
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.geometry;
    if (Object.keys(source.morphAttributes).length ||
      Object.values(source.attributes).some((a) => a instanceof THREE.InterleavedBufferAttribute || a.itemSize > 4)) return;
    let optimized = geometries.get(source);
    if (!optimized) {
      optimized = mergeVertices(source, 1e-6);
      geometries.set(source, optimized);
    }
    mesh.geometry = optimized;
  });
  for (const source of geometries.keys()) source.dispose();
}
