import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Auto-save de rascunho de pedido em localStorage.
 *
 * Princípio: vendedor externo no carro. Se cair sinal ou fechar a aba por engano, ao reabrir
 * a página deve aparecer "Você tinha um pedido em andamento. Restaurar?".
 *
 * v1: salva snapshot completo do `state` (objeto JSON-serializável). Cabe ao caller decidir
 * o que entra (tipicamente: customer ref, cart, notes, deliveryOption, paymentSelections).
 *
 * Limitações conhecidas:
 *  - Se algum produto for removido do catálogo entre a salvagem e o restore, restore vai render
 *    a UI com item inválido — caller deve validar contra catálogo atual antes de aplicar.
 *  - localStorage tem ~5MB por origin — pedidos com 100+ itens podem aproximar do limite.
 *
 * Chave: `order_draft:{scopeKey}` — passe o user.id (ou user.id + customer.id) para isolar.
 */
export interface OrderDraft<T = unknown> {
  state: T;
  savedAt: string;
  scopeKey: string;
}

interface Options<T> {
  scopeKey: string;
  state: T;
  /** Predicate que diz se o estado atual vale ser salvo (ex: cart.length > 0). */
  shouldSave: boolean;
  /** Debounce em ms (default 600). */
  debounceMs?: number;
  /** Quando true (após submit bem-sucedido), limpa o draft imediatamente. */
  clearTrigger?: boolean;
}

function key(scopeKey: string) {
  return `order_draft:${scopeKey}`;
}

export function useOrderDraft<T>({
  scopeKey,
  state,
  shouldSave,
  debounceMs = 600,
  clearTrigger,
}: Options<T>) {
  const [draft, setDraft] = useState<OrderDraft<T> | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(key(scopeKey));
      return raw ? (JSON.parse(raw) as OrderDraft<T>) : null;
    } catch {
      return null;
    }
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save com debounce
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!shouldSave) return;
    debounceRef.current = setTimeout(() => {
      try {
        const payload: OrderDraft<T> = {
          state,
          savedAt: new Date().toISOString(),
          scopeKey,
        };
        localStorage.setItem(key(scopeKey), JSON.stringify(payload));
      } catch {
        // quota — ignora
      }
    }, debounceMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scopeKey, state, shouldSave, debounceMs]);

  // Limpar quando trigger
  useEffect(() => {
    if (clearTrigger && typeof localStorage !== 'undefined') {
      localStorage.removeItem(key(scopeKey));
      setDraft(null);
    }
  }, [clearTrigger, scopeKey]);

  // Aviso ao fechar a aba com cart pendente (vendedor no carro fecha sem querer)
  useEffect(() => {
    if (!shouldSave) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [shouldSave]);

  const clear = useCallback(() => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key(scopeKey));
    setDraft(null);
  }, [scopeKey]);

  const dismiss = useCallback(() => {
    setDraft(null);
  }, []);

  return { draft, clear, dismiss };
}
