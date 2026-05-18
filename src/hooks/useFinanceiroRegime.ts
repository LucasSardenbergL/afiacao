import { useEffect, useState, useCallback } from 'react';

export type DreRegime = 'caixa' | 'competencia';
const KEY = 'financeiroRegime';

const subscribers = new Set<() => void>();

function read(): DreRegime {
  if (typeof window === 'undefined') return 'competencia';
  const v = localStorage.getItem(KEY);
  return v === 'caixa' || v === 'competencia' ? v : 'competencia';
}

export function useFinanceiroRegime() {
  const [regime, setLocal] = useState<DreRegime>(read);

  useEffect(() => {
    const sync = () => setLocal(read());
    subscribers.add(sync);
    return () => { subscribers.delete(sync); };
  }, []);

  const setRegime = useCallback((next: DreRegime) => {
    localStorage.setItem(KEY, next);
    subscribers.forEach(s => s());
  }, []);

  return { regime, setRegime };
}
