import { useEffect, useId, useRef, useState } from 'react';

// One control for browsing and filtering. Selection is explicit; typing never
// changes the stored source/value. DOM focus stays in the combobox.
export function SearchablePicker({ label, options, value, onChange, disabled, required, placeholder = 'Оберіть або почніть вводити', unknownLabel = 'Збережене значення недоступне' }) {
  const id = useId(); const input = useRef(null);
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(null); const [active, setActive] = useState(0);
  const selected = options.find((option) => option.value === value);
  const matches = options.filter((option) => option.label.toLocaleLowerCase('uk').includes((query || '').toLocaleLowerCase('uk')));
  const index = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => { if (open) document.getElementById(`${id}-${index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [id, index, open]);
  const choose = (option) => { if (!option || disabled) return; onChange(option.value); setOpen(false); setQuery(null); };
  return <div className="et-combobox" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(null); } }}>
    <label htmlFor={id}>{label}</label>
    <input ref={(element) => { input.current = element; element?.setCustomValidity(required && !value ? 'Оберіть значення зі списку.' : ''); }} id={id} className="input" role="combobox" autoComplete="off"
      aria-autocomplete="list" aria-expanded={open} aria-controls={id + '-options'} aria-activedescendant={open && matches.length ? `${id}-${index}` : undefined} aria-required={required || undefined}
      disabled={disabled} placeholder={placeholder} value={open && query !== null ? query : selected?.label || (value ? unknownLabel : '')}
      onFocus={(event) => { setOpen(true); setQuery(null); setActive(0); event.target.select(); }} onClick={() => setOpen(true)}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(null); }
        else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); setActive(open ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % (matches.length || 1) : 0); }
        else if (event.key === 'Enter' && open) { event.preventDefault(); choose(matches[index]); }
      }} />
    {open && <ul id={id + '-options'} role="listbox" aria-label={label + ': варіанти'} className="et-combobox-options">
      {matches.map((option, i) => <li key={option.value} id={`${id}-${i}`} role="option" aria-selected={value === option.value} data-active={index === i}
        onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => choose(option)}>{option.label}</li>)}
      {!matches.length && <li role="presentation">За поточним пошуком нічого не знайдено.</li>}
    </ul>}
  </div>;
}
