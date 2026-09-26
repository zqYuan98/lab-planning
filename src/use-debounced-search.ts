import { useEffect, useState } from 'react'

export const SEARCH_DEBOUNCE_MS = 300
/**
 * Server search reads wait for a typing pause; every keystroke otherwise costs one
 * full synchronous server read even when the browser aborts it. Clearing applies at
 * once so programmatic resets stay a single read.
 */
export function useDebouncedSearch(value: string, delay = SEARCH_DEBOUNCE_MS) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (value === '' || value === debounced) { setDebounced(value); return }
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}
