import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { COLUNAS_UNIVERSO_PEDIDOS, type PedidoDoUniverso } from '@/lib/farmer/universo-pedidos-query';

/**
 * Substituto de `buscarUniversoPedidos` para os testes de REGRA dos motores do Farmer (oferta,
 * conta, escopo, head de geração…): lê `sales_orders` como os motores liam ANTES do lote 16 —
 * offset sequencial, mesma denylist, mesma ordem — pelo supabase que o próprio teste mocka.
 *
 * Por quê: esses testes modelam a leitura com stubs de `.range` (fixtures sem `id`, falha por
 * página, filtros aplicados) e não são sobre o transporte. O transporte novo (keyset paralelo +
 * cache) tem prova própria: `src/lib/farmer/__tests__/universo-pedidos-query.test.ts` mostra que
 * ele devolve EXATAMENTE o array desta leitura, e os goldens dos motores usam o caminho real.
 *
 * Uso: `vi.mock('@/lib/farmer/universo-pedidos-query', async (orig) => ({ ...(await orig()),
 * buscarUniversoPedidos: () => lerUniversoPorOffset() }))`.
 */
export function lerUniversoPorOffset(): Promise<readonly PedidoDoUniverso[]> {
  return fetchAllPages(
    (de, ate) =>
      supabase
        .from('sales_orders')
        .select(COLUNAS_UNIVERSO_PEDIDOS)
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(de, ate),
    'sales_orders/teste-offset',
  );
}
