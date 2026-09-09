import { useEffect, useMemo, useRef, useState } from "react";

interface QuickOpenClassModalProps {
  classNames: string[];
  onOpen: (className: string) => void;
  onClose: () => void;
}

const MAX_RESULTS = 100;

/** Studio's Ctrl+O is a plain substring filter (not VS Code's fuzzy/subsequence match) — this
 * mirrors that: exact-prefix matches first, then anywhere-substring matches, each group
 * alphabetical. `names` is pre-sorted, so a full/empty query already comes back alphabetical. */
function rankMatches(query: string, names: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return names.slice(0, MAX_RESULTS);
  const startsWith: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) startsWith.push(name);
    else if (lower.includes(q)) contains.push(name);
  }
  return [...startsWith, ...contains].slice(0, MAX_RESULTS);
}

/** Studio's Ctrl+O "Open Class" — type a (partial) class name, arrow keys to pick, Enter to open. */
function QuickOpenClassModal({ classNames, onOpen, onClose }: QuickOpenClassModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedNames = useMemo(
    () => [...classNames].sort((a, b) => a.localeCompare(b)),
    [classNames],
  );
  const matches = useMemo(() => rankMatches(query, sortedNames), [query, sortedNames]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = matches[selectedIndex];
      if (target) onOpen(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal quick-open-modal" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nome da classe… (Enter abre, Esc cancela)"
        />
        <ul className="quick-open-list">
          {matches.length === 0 && <li className="quick-open-empty">Nenhuma classe encontrada.</li>}
          {matches.map((name, index) => (
            <li
              key={name}
              className={index === selectedIndex ? "active" : ""}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onOpen(name)}
            >
              {name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default QuickOpenClassModal;
