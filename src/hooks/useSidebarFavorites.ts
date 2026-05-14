import { useCallback, useEffect, useState } from 'react';

/**
 * Favoritos pinados da sidebar — pattern Mercury "Pinned" / Linear "Favorites".
 * Usuário fixa até 5 itens (rotas) que aparecem acima de todas as seções regulares.
 *
 * Persistência: localStorage por usuário (chave fixa por enquanto; pode evoluir
 * pra incluir userId quando autenticação estiver tudo alinhada).
 *
 * v1: lista simples de paths. Sem reorder por drag (futuro).
 */
const STORAGE_KEY = 'sidebar_favorites_v1';
const MAX_FAVORITES = 5;

function read(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function write(paths: string[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(paths) }));
}

export function useSidebarFavorites() {
  const [favorites, setFavorites] = useState<string[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setFavorites(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isFavorite = useCallback((path: string) => favorites.includes(path), [favorites]);

  const toggle = useCallback((path: string) => {
    setFavorites((prev) => {
      const next = prev.includes(path)
        ? prev.filter((p) => p !== path)
        : prev.length >= MAX_FAVORITES
          ? prev // limite atingido — silencioso (UI deve dar feedback)
          : [...prev, path];
      write(next);
      return next;
    });
  }, []);

  return {
    favorites,
    isFavorite,
    toggle,
    canAddMore: favorites.length < MAX_FAVORITES,
    max: MAX_FAVORITES,
  };
}
