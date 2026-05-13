import { useCallback, useEffect, useState } from 'react';

const RECENTS_KEY = 'tint_recents_v1';
const FAVORITES_KEY = 'tint_favorites_v1';
const MAX_RECENTS = 10;

export interface TintFormulaRef {
  id: string;
  cor_id: string;
  nome_cor: string;
  produto_descricao?: string;
  base_descricao?: string;
}

function safeRead<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded → ignora silenciosamente, não vale a pena quebrar a UI
  }
}

/**
 * Recentes (FIFO 10) e favoritos (estrela) das fórmulas tintométricas — por usuário (localStorage).
 * Substitui a busca repetida no balcão.
 */
export function useTintRecentsFavorites() {
  const [recents, setRecents] = useState<TintFormulaRef[]>(() => safeRead(RECENTS_KEY, []));
  const [favorites, setFavorites] = useState<TintFormulaRef[]>(() => safeRead(FAVORITES_KEY, []));

  // Sync entre abas
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === RECENTS_KEY) setRecents(safeRead(RECENTS_KEY, []));
      if (e.key === FAVORITES_KEY) setFavorites(safeRead(FAVORITES_KEY, []));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const pushRecent = useCallback((formula: TintFormulaRef) => {
    setRecents((prev) => {
      const next = [formula, ...prev.filter((f) => f.id !== formula.id)].slice(0, MAX_RECENTS);
      safeWrite(RECENTS_KEY, next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((formula: TintFormulaRef) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.id === formula.id);
      const next = exists ? prev.filter((f) => f.id !== formula.id) : [formula, ...prev];
      safeWrite(FAVORITES_KEY, next);
      return next;
    });
  }, []);

  const isFavorite = useCallback((id: string) => favorites.some((f) => f.id === id), [favorites]);

  const clearRecents = useCallback(() => {
    setRecents([]);
    safeWrite(RECENTS_KEY, []);
  }, []);

  return { recents, favorites, pushRecent, toggleFavorite, isFavorite, clearRecents };
}
