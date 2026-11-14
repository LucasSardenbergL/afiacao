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

function lerPrimitivo(raw: string, fallback: Primitive | Primitive[]): Primitive | Primitive[] {
  if (Array.isArray(fallback)) return raw.split('|');
  if (typeof fallback === 'boolean') return raw === '1';
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

function deserialize<T extends Primitive | Primitive[]>(raw: string | null, fallback: T): T {
  if (raw === null || raw === '') return fallback;
  // Residual deliberado, e estreito: o valor tem a mesma FAMÍLIA do fallback (texto/número/booleano/
  // lista), mas a URL não prova a união literal que `T` pode ser (`'abertos' | 'todos'`) — validar
  // isso é de quem conhece o vocabulário, não deste parser genérico.
  return lerPrimitivo(raw, fallback) as T;
}

export function useUrlState<S extends StateShape>(
  defaults: S,
): [S, (next: Partial<S> | ((prev: S) => S)) => void, () => void] {
  const [params, setParams] = useSearchParams();
  // Estabiliza defaults na primeira chamada — uso esperado é shape fixo.
  // Se o caller mudar shape entre renders, ignoramos (warning silencioso).
  const defaultsRef = useRef(defaults);

  // Params CORRENTES, incluindo escritas ainda não renderizadas. O `setSearchParams(fn)` do
  // react-router 6 NÃO é um updater enfileirado: o `fn` recebe os params DO RENDER. Duas chamadas
  // no mesmo tick (ex.: "Limpar filtros" = setSearch('') + setAccountFilter('all')) liam a mesma
  // base e a segunda regravava o valor antigo da primeira. A ref compõe as escritas em sequência;
  // navegação de fora (voltar, link) chega como `params` novo e reancora a ref.
  const correnteRef = useRef(params);
  const ultimoRenderRef = useRef(params);
  if (ultimoRenderRef.current !== params) {
    ultimoRenderRef.current = params;
    correnteRef.current = params;
  }

  const ler = useCallback((fonte: URLSearchParams): S => {
    const out: Record<string, unknown> = {};
    for (const key in defaultsRef.current) {
      out[key] = deserialize(fonte.get(key), defaultsRef.current[key] as Primitive | Primitive[]);
    }
    return out as S;
  }, []);

  const state = useMemo(() => ler(params), [ler, params]);

  const setState = useCallback(
    (next: Partial<S> | ((prev: S) => S)) => {
      const base = correnteRef.current;
      const anterior = ler(base);
      const merged: S =
        typeof next === 'function'
          ? (next as (p: S) => S)(anterior)
          : ({ ...anterior, ...next } as S);
      const updated = new URLSearchParams(base);
      for (const key in defaultsRef.current) {
        const value = serialize(merged[key] as Primitive | Primitive[]);
        if (value === null) updated.delete(key);
        else updated.set(key, value);
      }
      correnteRef.current = updated;
      setParams(updated, { replace: true });
    },
    [setParams, ler],
  );

  const reset = useCallback(() => {
    const updated = new URLSearchParams(correnteRef.current);
    for (const key in defaultsRef.current) updated.delete(key);
    correnteRef.current = updated;
    setParams(updated, { replace: true });
  }, [setParams]);

  return [state, setState, reset];
}
