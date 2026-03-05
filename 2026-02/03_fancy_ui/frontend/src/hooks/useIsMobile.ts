import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768; // md breakpoint

const query = typeof window !== 'undefined'
  ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  : null;

function subscribe(cb: () => void) {
  query?.addEventListener('change', cb);
  return () => query?.removeEventListener('change', cb);
}

function getSnapshot() {
  return query?.matches ?? false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
