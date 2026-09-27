import * as THREE from 'three';

// Call only after clones have been removed: they share the template's geometry,
// materials and textures. Repeated character switches must release these too.
export function disposeCharacter(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) {
    // FBXLoader creates blob URLs for embedded images; these are not app-owned
    // upload URLs and must be released independently.
    const image = texture.image;
    const source = image && typeof image === 'object' && 'src' in image ? image.src : null;
    if (typeof source === 'string' && source.startsWith('blob:')) URL.revokeObjectURL(source);
    texture.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
