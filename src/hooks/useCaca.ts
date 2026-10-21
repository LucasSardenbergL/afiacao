/**
 * Hook fino de IO da fila de caça (Frente B).
 *
 * Lê as duas views SQL e delega TODA a lógica ao helper puro `montarFilaCaca`:
 *   - `v_caca_compradores` (~658 linhas) — fatos de quem JÁ compra.
 *   - `v_caca_candidatos`  (~10k linhas) — alvos a serem "caçados".
 *
 * Ambas paginadas via `.range()` (anti-truncamento do cap de 1000 do PostgREST) e
 * tipadas pelo `types.ts`; a borda `src/lib/caca/linha-view.ts` exige as colunas-chave.
 *
 * Degradação honesta: erro de leitura NÃO quebra a UI — propaga via `error` e a
 * `queryFn` lança (TanStack expõe `error` + `data` undefined). NÃO faz gate de
 * auth aqui (a rota/página gateia).
 *
 * Sem teste unitário: é IO puro. A lógica testável vive em `src/lib/caca/fila.ts`.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { montarFilaCaca } from '@/lib/caca/fila';
import { empresasSemLucroConfiavel } from '@/lib/caca/melhores';
import { paraCandidato, paraComprador } from '@/lib/caca/linha-view';
import type {
  CacaCandidatoDisplay,
  CompradorRow,
  CandidatoRow,
} from '@/lib/caca/types';


const COMPRADORES_SEL =
  'documento, empresa, cidade_uf, ramo, ticket_faixa, familias, volume, n_pedidos, recencia_dias, lucro_proxy, lucro_cobertura';
const CANDIDATOS_SEL =
  'documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone, cliente_user_id';

/**
 * Pagina as views inteiras via `.range()`. Ordena por `(documento, empresa*)` — chave ÚNICA por
 * grão (documento NÃO é único: há 1 linha por documento×empresa) → paginação estável (sem
 * pular/duplicar na fronteira de página).
 * Pelo canônico: lança em erro de DB ou `data: null` sem error (truncaria a fila de caça, ~10k
 * candidatos, em silêncio) — chamador trata via TanStack `error` — e a página perdida é medida.
 * A linha passa pela borda (`linha-view.ts`): colunas-chave exigidas, empresa guardada.
 */
async function lerCompradores(): Promise<CompradorRow[]> {
  const linhas = await fetchAllPagesComMensagem(
    (de, ate) =>
      supabase
        .from('v_caca_compradores')
        .select(COMPRADORES_SEL)
        .order('documento', { ascending: true })
        .order('empresa', { ascending: true })
        .range(de, ate),
    'v_caca_compradores/fila-caca',
    'v_caca_compradores',
  );
  return linhas.map(paraComprador);
}

async function lerCandidatos(): Promise<CandidatoRow[]> {
  const linhas = await fetchAllPagesComMensagem(
    (de, ate) =>
      supabase
        .from('v_caca_candidatos')
        .select(CANDIDATOS_SEL)
        .order('documento', { ascending: true })
        .order('empresa_alvo', { ascending: true })
        .range(de, ate),
    'v_caca_candidatos/fila-caca',
    'v_caca_candidatos',
  );
  return linhas.map(paraCandidato);
}

/**
 * Carrega as duas views e monta a fila de caça unificada.
 * Expõe `{ data, isLoading, error }` (shape padrão do useQuery do projeto).
 */
export interface CacaResultado {
  fila: CacaCandidatoDisplay[];
  /**
   * Empresas em que NENHUM comprador tem lucro confiável — logo o componente de lucro (peso 0,4)
   * saiu do índice para TODA a empresa, e o ranking passou a ser volume + fidelidade.
   *
   * Por que POR EMPRESA e não global: `montarFilaCaca` roda `selecionarMelhores` uma vez por
   * empresa-alvo, com percentis calculados dentro de cada uma. Oben pode ter custo sincronizado e
   * Colacor não — um sinal global diria "tem lucro" e esconderia a empresa cega (achado do
   * challenge Codex nesta entrega).
   *
   * Por que isto NÃO muda o ranking: quando o lucro sai de todas as linhas de uma empresa, o
   * `selecionarMelhores` imputa o percentil neutro 0,5 em todas — e `0,4 × 0,5` vira uma
   * CONSTANTE somada a todos, transformação afim crescente que preserva ordem e empates. O que se
   * perde não é a ordem: é o operador saber que o critério mudou. Por isso a correção é DECLARAR,
   * não recalcular.
   */
  empresasSemLucro: string[];
}

export function useCaca() {
  return useQuery<CacaResultado>({
    queryKey: ['caca'],
    staleTime: 60_000,
    queryFn: async () => {
      const [compradores, candidatos] = await Promise.all([
        lerCompradores(),
        lerCandidatos(),
      ]);

      // Helper PURO de `melhores.ts`, não reescrito aqui: duplicar o limiar 0,5 faria o aviso
      // divergir do cálculo — a tela diria "com lucro" com o índice já tendo descartado o termo.
      return {
        fila: montarFilaCaca(compradores, candidatos),
        empresasSemLucro: empresasSemLucroConfiavel(compradores),
      };
    },
  });
}
