import { useEffect, useRef } from 'react';
import { BUILTIN_CHARACTERS, type CharacterChoice } from './characters';
import Icon from './Icon';

export default function CharacterPicker({ selected, disabled, onSelect, onUpload }: {
  selected: CharacterChoice;
  disabled: boolean;
  onSelect: (character: CharacterChoice) => void;
  onUpload: () => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target) && detailsRef.current) {
        detailsRef.current.open = false;
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && detailsRef.current?.open) {
        detailsRef.current.open = false;
        summaryRef.current?.focus();
        event.stopPropagation();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  function close() {
    if (detailsRef.current) detailsRef.current.open = false;
    summaryRef.current?.focus();
  }

  return <details className="character-picker" ref={detailsRef}>
    <summary ref={summaryRef} className="button stage-button" aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0} onClick={(event) => { if (disabled) event.preventDefault(); }}
      title={`Change character · ${selected.name}`}>
      <Icon name="person" /><span>Character</span><Icon name="chevron" className="character-chevron" />
    </summary>
    <div className="character-options" role="group" aria-label="Choose a character">
      <p className="character-current">Current: {selected.name}</p>
      {BUILTIN_CHARACTERS.map((character) => <button key={character.id} className="button character-option"
        disabled={disabled} aria-pressed={selected.id === character.id} onClick={() => { onSelect(character); close(); }}>
        <span>{character.name}</span>{selected.id === character.id && <Icon name="check" />}
      </button>)}
      <button className="button character-option character-upload" disabled={disabled} onClick={() => { close(); onUpload(); }}>
        <Icon name="upload" /><span>Upload character…</span>
      </button>
    </div>
  </details>;
}
