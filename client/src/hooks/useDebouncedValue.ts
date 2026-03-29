import { useState, useEffect } from 'react';

/**
 * Debounces a value — returns the value only after it stops changing for `delay` ms.
 * Used for search inputs to avoid firing API calls on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
