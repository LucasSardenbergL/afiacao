/**
 * Hook fino de IO da fila de caça (Frente B).
 *
 * Lê as duas views SQL e delega TODA a lógica ao helper puro `montarFilaCaca`:
 *   - `v_caca_compradores` (~658 linhas) — fatos de quem JÁ compra.
 *   - `v_caca_candidatos`  (~10k linhas) — alvos a serem "caçados".
 *
 * Ambas paginadas via `.range()` (anti-truncamento do cap de 1000 do PostgREST),
 * seguindo o mesmo padrão de `useRouteContactList`. As views não estão no
 * `types.ts` gerado → cast pelo helper `cacaFrom` (mesmo padrão de `routeFrom`).
 *
 * Degradação honesta: erro de leitura NÃO quebra a UI — propaga via `error` e a
 * `queryFn` lança (TanStack expõe `error` + `data` undefined). NÃO faz gate de
 * auth aqui (a rota/página gateia).
 *
 * Sem teste unitário: é IO puro. A lógica testável vive em `src/lib/caca/fila.ts`.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { montarFilaCaca } from '@/lib/caca/fila';
import type {
  CacaCandidatoDisplay,
  CompradorRow,
  CandidatoRow,
} from '@/lib/caca/types';

const PAGE = 1000;

// v_caca_* não estão no types.ts gerado → cast (mesmo padrão de useRouteContactList).
type PgRes = { data: unknown; error: { message: string } | null };
interface CacaBuilder {
  select: (cols: string) => CacaBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => CacaBuilder;
  range: (from: number, to: number) => CacaBuilder;
  then: PromiseLike<PgRes>['then'];
}
function cacaFrom(view: string): CacaBuilder {
  return (supabase as unknown as { from: (v: string) => CacaBuilder }).from(view);
}

const COMPRADORES_SEL =
  'documento, empresa, cidade_uf, ramo, ticket_faixa, familias, volume, n_pedidos, recencia_dias, lucro_proxy, lucro_cobertura';
const CANDIDATOS_SEL =
  'documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone, cliente_user_id';

/**
 * Pagina uma view inteira via `.range()`. Ordena por `(documento, ordem2)` —
 * chave ÚNICA por grão (documento NÃO é único: há 1 linha por documento×empresa)
 * → paginação estável (sem pular/duplicar na fronteira de página).
 * Lança em erro de DB (chamador trata via TanStack `error`).
 */
async function paginarView<T>(view: string, sel: string, ordem2: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = (await cacaFrom(view)
      .select(sel)
      .order('documento', { ascending: true })
      .order(ordem2, { ascending: true })
      .range(from, from + PAGE - 1)) as PgRes;
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Carrega as duas views e monta a fila de caça unificada.
 * Expõe `{ data, isLoading, error }` (shape padrão do useQuery do projeto).
 */
export function useCaca() {
  return useQuery<CacaCandidatoDisplay[]>({
    queryKey: ['caca'],
    staleTime: 60_000,
    queryFn: async () => {
      const [compradores, candidatos] = await Promise.all([
        paginarView<CompradorRow>('v_caca_compradores', COMPRADORES_SEL, 'empresa'),
        paginarView<CandidatoRow>('v_caca_candidatos', CANDIDATOS_SEL, 'empresa_alvo'),
      ]);
      return montarFilaCaca(compradores, candidatos);
    },
  });
}
