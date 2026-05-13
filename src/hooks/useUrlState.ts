import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Sincroniza estado com URL search params (compartilhável, sobrevive a F5).
 *
 * Uso:
 *   const [filters, setFilters] = useUrlState({ search: '', status: 'all' });
 *   setFilters({ search: 'foo' });   // ?search=foo&status=all
 *   setFilters((prev) => ({ ...prev, status: 'open' }));
 *
 * Apenas strings, números e booleans são serializados. Listas via separador "|".
 * Para schemas complexos use useUrlState com schema zod (não incluído aqui).
 *
 * Atenção: NÃO colocar PII (CPF/CNPJ) nesses params — vai parar em logs/históricos.
 */
type Primitive = string | number | boolean | null | undefined;
type StateShape = Record<string, Primitive | Primitive[]>;

function serialize(value: Primitive | Primitive[]): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const cleaned = value.filter((v) => v !== null && v !== undefined && v !== '');
    return cleaned.length ? cleaned.join('|') : null;
  }
  if (typeof value === 'boolean') return value ? '1' : null;
  return String(value);
}

function deserialize<T extends Primitive | Primitive[]>(raw: string | null, fallback: T): T {
  if (raw === null || raw === '') return fallback;
  if (Array.isArray(fallback)) {
    return raw.split('|') as unknown as T;
  }
  if (typeof fallback === 'boolean') {
    return (raw === '1') as unknown as T;
  }
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : fallback) as unknown as T;
  }
  return raw as unknown as T;
}

export function useUrlState<S extends StateShape>(
  defaults: S,
): [S, (next: Partial<S> | ((prev: S) => S)) => void, () => void] {
  const [params, setParams] = useSearchParams();
  // Estabiliza defaults na primeira chamada — uso esperado é shape fixo.
  // Se o caller mudar shape entre renders, ignoramos (warning silencioso).
  const defaultsRef = useRef(defaults);

  const state = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key in defaultsRef.current) {
      const raw = params.get(key);
      out[key] = deserialize(raw, defaultsRef.current[key] as Primitive | Primitive[]);
    }
    return out as S;
  }, [params]);

  const setState = useCallback(
    (next: Partial<S> | ((prev: S) => S)) => {
      setParams(
        (prev) => {
          const merged: S =
            typeof next === 'function'
              ? (next as (p: S) => S)(state)
              : ({ ...state, ...next } as S);
          const updated = new URLSearchParams(prev);
          for (const key in defaultsRef.current) {
            const value = serialize(merged[key] as Primitive | Primitive[]);
            if (value === null) updated.delete(key);
            else updated.set(key, value);
          }
          return updated;
        },
        { replace: true },
      );
    },
    [setParams, state],
  );

  const reset = useCallback(() => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        for (const key in defaultsRef.current) updated.delete(key);
        return updated;
      },
      { replace: true },
    );
  }, [setParams]);

  return [state, setState, reset];
}
