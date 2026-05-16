import { useEffect, useState } from 'react';

const STORAGE_KEY = 'dashboardLastVisit';

export interface UseLastVisitReturn {
  /** Timestamp ISO da última visita, ou null se nunca visitou. */
  lastVisitIso: string | null;
  /** Idade em minutos desde a última visita (null se primeira visita). */
  minutesSinceLastVisit: number | null;
}

/**
 * Lê a última visita salva, e ao desmontar atualiza o storage com `now`.
 * O refresh no unmount (não no mount) garante que o usuário SEMPRE vê os deltas dele mesmo
 * na próxima abertura.
 */
export function useLastVisit(): UseLastVisitReturn {
  const [snapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    };
  }, []);

  const minutesSinceLastVisit = snapshot
    ? Math.floor((Date.now() - new Date(snapshot).getTime()) / 60_000)
    : null;

  return { lastVisitIso: snapshot, minutesSinceLastVisit };
}
