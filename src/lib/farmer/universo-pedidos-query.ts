import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { fetchAllKeyset, POSTGREST_PAGE_SIZE } from '@/lib/postgrest';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

/**
 * O UNIVERSO DE PEDIDOS dos três motores do Farmer (`useFarmerScoring`, `useCrossSellEngine`,
 * `useBundleEngine`), lido UMA vez e compartilhado — plano v4, lote 16 (C4′).
 *
 * Antes, cada motor baixava por conta o mesmo `sales_orders` (mesma denylist + `deleted_at`),
 * em páginas de 1.000 EM SÉRIE: ~32 mil linhas, ~33 requisições por motor. Agora:
 *
 * 1. UMA consulta (react-query) com a UNIÃO das colunas que os três leem. O cálculo de cada motor
 *    não muda — a prova é o golden de cada um (`src/test/golden/universo-pedidos/`), gravado com
 *    o código anterior a esta troca: mesmo dado ⇒ mesmo score, bit a bit.
 * 2. Páginas em PARALELO por KEYSET particionado: `FAIXAS_DO_ID` divide o espaço do uuid em faixas
 *    disjuntas e contíguas; cada faixa anda com o seu cursor (`fetchAllKeyset`) e todas correm
 *    juntas. Concatenar as faixas na ordem devolve a MESMA sequência global por `id` que a leitura
 *    sequencial devolvia — e a ordem é observável nos motores (desempates, `ordemDeLeitura` da
 *    referência de preço, `slice` de regras), então ela é parte do invariante, não detalhe.
 *    Ondas de offset em paralelo foram descartadas (parecer Codex do lote): um INSERT concorrente
 *    faz uma linha que existia SUMIR sem nenhum guard perceber. Com cursor, toda linha que existe
 *    durante a leitura volta exatamente uma vez.
 * 3. Falha de QUALQUER página de QUALQUER faixa rejeita a leitura inteira (erro assinado de
 *    `fetchAllKeyset`) — o motor declara `erro`; nunca universo parcial ou vazio.
 *
 * Não é fotografia atômica: o que nasce/morre no meio da leitura pode ou não vir (como antes).
 */

/** A união das colunas que os três motores leem. Coluna nova num motor = coluna nova AQUI. */
export const COLUNAS_UNIVERSO_PEDIDOS = 'id, customer_user_id, items, total, created_at, order_date_kpi, status, account';

export type PedidoDoUniverso = Readonly<
  Pick<
    Tables<'sales_orders'>,
    'id' | 'customer_user_id' | 'items' | 'total' | 'created_at' | 'order_date_kpi' | 'status' | 'account'
  >
>;

/**
 * 8 faixas `[de, ate)` sobre o uuid, pelo 1º dígito hex (o `gen_random_uuid()` é uniforme: em
 * prod, 16.182 de 32.159 abaixo de '8'). A 1ª não tem piso e a última não tem teto — a cobertura
 * do espaço inteiro é por CONSTRUÇÃO, não por suposição sobre os valores.
 */
export const FAIXAS_DO_ID: ReadonlyArray<{ de: string | null; ate: string | null }> = (() => {
  const cortes = ['2', '4', '6', '8', 'a', 'c', 'e'].map((d) => `${d}0000000-0000-0000-0000-000000000000`);
  return [null, ...cortes].map((de, i) => ({ de, ate: cortes[i] ?? null }));
})();

function lerFaixa(faixa: { de: string | null; ate: string | null }, indice: number): Promise<PedidoDoUniverso[]> {
  return fetchAllKeyset<PedidoDoUniverso>(
    (apos) => {
      let q = supabase
        .from('sales_orders')
        .select(COLUNAS_UNIVERSO_PEDIDOS)
        // DENYLIST + `deleted_at IS NULL`: o MESMO universo de `private.margem_cliente_agregada()`
        // (#1738) — ver `@/lib/farmer/universo-pedidos`.
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null);
      if (faixa.de !== null) q = q.gte('id', faixa.de);
      if (faixa.ate !== null) q = q.lt('id', faixa.ate);
      if (apos !== null) q = q.gt('id', apos);
      return q.order('id', { ascending: true }).limit(POSTGREST_PAGE_SIZE);
    },
    (p) => p.id,
    `sales_orders/universo-farmer#${indice}`,
  );
}

/** Lê o universo inteiro: as faixas em paralelo, concatenadas na ordem global por `id`. */
export async function lerUniversoPedidos(): Promise<readonly PedidoDoUniverso[]> {
  const porFaixa = await Promise.all(FAIXAS_DO_ID.map(lerFaixa));
  porFaixa.forEach((linhas, i) => {
    const { de, ate } = FAIXAS_DO_ID[i];
    // O servidor tem de ter honrado o recorte: é ele que garante faixas DISJUNTAS (sem linha em
    // dobro) e a ordem global da concatenação. Linha fora da faixa = bug, nunca "segue".
    if (linhas.some((l) => (de !== null && l.id < de) || (ate !== null && l.id >= ate))) {
      throw new Error(`universo de pedidos: a faixa ${i} trouxe linha fora do recorte de id`);
    }
  });
  // O array é COMPARTILHADO entre motores via cache: mutar em um contaminaria os outros. A guarda
  // é o `readonly` do tipo + o teste que roda os três no MESMO QueryClient contra o golden.
  // `Object.freeze` profundo foi medido e recusado: deixou o cálculo dos motores ~10x mais lento.
  return porFaixa.flat();
}

export const chaveUniversoPedidos = (userIdReal: string) => ['farmer', 'universo-pedidos', userIdReal] as const;

/** Quanto o universo em cache serve a quem NÃO publica nada (o scoring, que é só exibição). */
export const FRESCOR_UNIVERSO_MS = 60_000;

/**
 * O universo via react-query.
 *
 * - Chave pelo usuário REAL (`useAuth().user.id`, nunca o alvo da lente): é a RLS DELE que decide
 *   as linhas de `sales_orders`. Na lente "Ver como" o motor já lia com o usuário real; o alvo
 *   só entra em leituras próprias de cada motor (carteira, ligações). O logout limpa o cache.
 * - `fresco: true` (quem PUBLICA — cross-sell e bundle gravam a geração — e o botão Recalcular)
 *   relê sempre; `false` (o scoring ao montar) aceita até `FRESCOR_UNIVERSO_MS`. Leitura em voo
 *   na mesma chave é compartilhada mesmo com `fresco` (pode ter começado segundos antes).
 * - `retry: false`: o erro chega ao motor na hora, como antes (o default do app re-tentaria 2x).
 * - `networkMode: 'always'`: offline, o default 'online' PAUSA o `fetchQuery` sem rejeitar e o
 *   motor ficaria "calculando" para sempre, sem `erro`. Assim a tentativa falha e o erro aparece.
 * - `gcTime` curto e sem `structuralSharing`: são ~14 MB de jsonb `items`, e ninguém observa
 *   esta chave por referência (os motores leem imperativamente).
 */
export function buscarUniversoPedidos(
  queryClient: QueryClient,
  userIdReal: string,
  { fresco }: { fresco: boolean },
): Promise<readonly PedidoDoUniverso[]> {
  return queryClient.fetchQuery({
    queryKey: chaveUniversoPedidos(userIdReal),
    queryFn: lerUniversoPedidos,
    staleTime: fresco ? 0 : FRESCOR_UNIVERSO_MS,
    gcTime: 2 * FRESCOR_UNIVERSO_MS,
    retry: false,
    networkMode: 'always',
    structuralSharing: false,
  });
}
