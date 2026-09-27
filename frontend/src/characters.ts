import ch14Url from '../../assets/ch14.fbx?url';

export interface CharacterChoice {
  id: string;
  name: string;
  url: string;
  fbx: boolean;
}

// Importing a URL bundles the asset but does not download or parse it until
// selected. Keep the existing lightweight default on first load.
export const BUILTIN_CHARACTERS: readonly CharacterChoice[] = [
  { id: 'default', name: 'Default character', url: '/character.glb', fbx: false },
  { id: 'ch14', name: 'Mouse', url: ch14Url, fbx: true },
];
