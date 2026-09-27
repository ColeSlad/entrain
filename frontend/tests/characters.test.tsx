import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_CHARACTERS } from '../src/characters';
import CharacterPicker from '../src/CharacterPicker';
import { disposeCharacter } from '../src/disposeCharacter';

describe('built-in characters', () => {
  it('keeps the existing default and bundles a binary FBX URL for Mouse', () => {
    expect(BUILTIN_CHARACTERS[0]).toMatchObject({ id: 'default', url: '/character.glb', fbx: false });
    expect(BUILTIN_CHARACTERS[1]).toMatchObject({ id: 'ch14', name: 'Mouse', fbx: true });
    expect(BUILTIN_CHARACTERS[1].url).toContain('ch14');
    const file = readFileSync(new URL('../../assets/ch14.fbx', import.meta.url));
    expect(file.subarray(0, 19).toString()).toBe('Kaydara FBX Binary ');
    expect(file.length).toBeLessThan(100 * 1024 * 1024);
  });

  it('marks the selected preset and preserves a separate upload action', () => {
    const html = renderToStaticMarkup(<CharacterPicker selected={BUILTIN_CHARACTERS[1]} disabled={false}
      onSelect={() => {}} onUpload={() => {}} />);
    expect(html).toContain('Current: Mouse');
    expect(html).toMatch(/aria-pressed="true"[^>]*><span>Mouse/);
    expect(html).toMatch(/aria-pressed="false"[^>]*><span>Default character/);
    expect(html).toContain('Upload character…');
    expect(html).not.toContain('<img'); // opening the picker never preloads models
  });

  it('shows an uploaded filename without selecting a built-in option', () => {
    const html = renderToStaticMarkup(<CharacterPicker selected={{ id: 'upload', name: 'my-rig.glb', url: 'blob:test', fbx: false }}
      disabled onSelect={() => {}} onUpload={() => {}} />);
    expect(html).toContain('Current: my-rig.glb');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('aria-disabled="true"');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
  });
});

it('releases shared template resources once when switching characters', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture({ src: 'blob:embedded-image' });
  const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture });
  const skeleton = new THREE.Skeleton([new THREE.Bone()]);
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.skeleton = skeleton;
    root.add(mesh);
  }
  const disposers = [geometry, material, texture, skeleton].map(resource => vi.spyOn(resource, 'dispose'));
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  try {
    disposeCharacter(root);
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:embedded-image');
  } finally { vi.restoreAllMocks(); }
});
