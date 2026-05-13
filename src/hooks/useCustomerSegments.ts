import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'customer_segments_v1';

/**
 * Segmentos salvos de filtros de clientes — local por usuário (localStorage).
 *
 * TODO(schema): substituir por tabela `user_segments(id uuid, user_id uuid, area text, name text, filter jsonb, shared bool)`
 * para persistir no servidor e suportar segmentos compartilhados com o time.
 * Quando isso existir, este hook vira um wrapper sobre useQuery + useMutation.
 */
export interface CustomerSegment {
  id: string;
  name: string;
  filters: {
    search?: string;
    health?: string;
    [key: string]: string | undefined;
  };
}

function read(): CustomerSegment[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as CustomerSegment[];
  } catch {
    return [];
  }
}

function write(segments: CustomerSegment[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(segments));
}

export function useCustomerSegments() {
  const [segments, setSegments] = useState<CustomerSegment[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setSegments(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const save = useCallback((name: string, filters: CustomerSegment['filters']): CustomerSegment => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`;
    const seg: CustomerSegment = { id, name, filters };
    setSegments((prev) => {
      const next = [seg, ...prev];
      write(next);
      return next;
    });
    return seg;
  }, []);

  const remove = useCallback((id: string) => {
    setSegments((prev) => {
      const next = prev.filter((s) => s.id !== id);
      write(next);
      return next;
    });
  }, []);

  return { segments, save, remove };
}
