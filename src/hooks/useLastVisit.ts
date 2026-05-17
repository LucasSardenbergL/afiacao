import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'dashboardLastVisit';
const MIN_SESSION_MS = 5 * 60 * 1000; // 5min

export interface UseLastVisitReturn {
  /** Timestamp ISO da última visita, ou null se nunca visitou. */
  lastVisitIso: string | null;
  /** Idade em minutos desde a última visita (null se primeira visita). */
  minutesSinceLastVisit: number | null;
}

/**
 * Lê a última visita salva, e ao desmontar atualiza o storage com `now` —
 * mas APENAS se a sessão durou ≥ 5min. Sem esse threshold, F5 ou navegação
 * curta apagaria os deltas (próximo mount leria o `now` que acabou de
 * escrever e `shouldHideStrip(< 30min)` esconderia a strip pra sempre).
 *
 * O refresh no unmount (não no mount) garante que o usuário SEMPRE vê os
 * deltas dele mesmo na próxima abertura.
 */
export function useLastVisit(): UseLastVisitReturn {
  const [snapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      const sessionDuration = Date.now() - mountedAtRef.current;
      if (sessionDuration < MIN_SESSION_MS) return;
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    };
  }, []);

  const minutesSinceLastVisit = snapshot
    ? Math.floor((Date.now() - new Date(snapshot).getTime()) / 60_000)
    : null;

  return { lastVisitIso: snapshot, minutesSinceLastVisit };
}
