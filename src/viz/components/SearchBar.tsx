import { useState, useRef, useCallback, useEffect } from 'react';
import { searchEntities, type SearchResult } from '../lib/api';

interface Props {
  onSelect: (id: string) => void;
  /** Optional override — defaults to the legacy entity search.
   *  Engine-aware callers pass a function that hits /api/engine/search and
   *  reshapes results into SearchResult ({id, name, type, score}). */
  searchFn?: (q: string) => Promise<SearchResult[]>;
  placeholder?: string;
}

export function SearchBar({ onSelect, searchFn, placeholder }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    const hits = searchFn ? await searchFn(q) : await searchEntities(q);
    setResults(hits);
    setIsOpen(hits.length > 0);
  }, [searchFn]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => doSearch(value), 300);
    },
    [doSearch],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setIsOpen(false);
      setQuery('');
      setResults([]);
      onSelect(id);
    },
    [onSelect],
  );

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder={placeholder ?? 'Search entities...'}
        value={query}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
      />
      {isOpen && (
        <div className="search-results">
          {results.map((r) => (
            <div
              key={r.id}
              className="search-result"
              onMouseDown={() => handleSelect(r.id)}
            >
              <span className={`type-badge ${r.type}`}>{r.type}</span>
              <span>{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
