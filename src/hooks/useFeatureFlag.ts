import { useCallback, useEffect, useState } from 'react';

/**
 * Feature flags simples baseadas em localStorage. Permite rollback rápido sem deploy.
 *
 * Uso:
 *   const [newVisualEnabled, toggle] = useFeatureFlag('newVisual', true);
 *
 * Padrões:
 *   newVisual          — aplica novos tokens visuais (Vercel/Mercury direction)
 *
 * Cada flag tem default; quando o usuário toggla, é persistido em localStorage.
 * O hook escuta mudanças entre abas via storage event.
 */
const STORAGE_PREFIX = 'feature_flag_';

const DEFAULTS: Record<string, boolean> = {
  newVisual: true, // Novo visual ativo por padrão (rollout completo)
  regua_preco_carrinho: false, // Régua de Preço no carrinho — sombra→balcão (off por padrão)
  regua_preco_360: false, // Régua de Preço no Customer 360 (readonly, sem botão) — off por padrão
};

function readFlag(name: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(STORAGE_PREFIX + name);
  if (raw === null) return fallback;
  return raw === '1';
}

function writeFlag(name: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_PREFIX + name, value ? '1' : '0');
  // dispatch storage event manual pra notificar mesma aba
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_PREFIX + name, newValue: value ? '1' : '0' }));
}

export function useFeatureFlag(name: string, defaultValue?: boolean): [boolean, (next: boolean) => void] {
  const fallback = defaultValue ?? DEFAULTS[name] ?? false;
  const [enabled, setEnabled] = useState<boolean>(() => readFlag(name, fallback));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + name) {
        setEnabled(readFlag(name, fallback));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [name, fallback]);

  const toggle = useCallback((next: boolean) => {
    writeFlag(name, next);
    setEnabled(next);
  }, [name]);

  return [enabled, toggle];
}

/**
 * Aplica/remove uma classe no <html> baseado no estado da flag.
 * Útil pra ativar overrides CSS condicionais (ex: .legacy-visual revert tokens novos).
 */
export function useFeatureFlagBodyClass(name: string, className: string, invert = false): void {
  const [enabled] = useFeatureFlag(name);
  useEffect(() => {
    const root = document.documentElement;
    const shouldApply = invert ? !enabled : enabled;
    if (shouldApply) root.classList.add(className);
    else root.classList.remove(className);
    return () => root.classList.remove(className);
  }, [enabled, className, invert]);
}
