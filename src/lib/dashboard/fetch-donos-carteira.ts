import { supabase } from '@/integrations/supabase/client';

/** `UNIQUE(customer_user_id)` ⇒ cada lote devolve ≤ 150 linhas, longe do teto de 1.000 do PostgREST. */
const LOTE = 150;

/**
 * Dono ATUAL da carteira ELEGÍVEL de cada cliente (cliente → owner_user_id): a régua do ranking do Master,
 * a mesma da positivação e da cadeia de comissão. `eligible = false` (clone de grupo, alias fiscal) é
 * invisível por contrato — todo leitor filtra.
 *
 * Cliente sem linha elegível NÃO entra no mapa: é a verdade do banco (sem carteira). Já a falha de leitura
 * LANÇA — `error` ou `data` nula sem `error` —, porque tratá-la como "sem carteira" mandaria a venda para
 * "Sem vendedor atribuído": veredito sobre o que ninguém leu (classe #1338→#1564).
 * Spec: docs/superpowers/specs/2026-10-06-ranking-atribuicao-por-carteira-design.md §5.2
 */
export async function fetchDonosCarteira(clienteIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(clienteIds)];
  const donos = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const { data, error } = await supabase
      .from('carteira_assignments')
      .select('customer_user_id, owner_user_id')
      .eq('eligible', true)
      .in('customer_user_id', lote);
    if (error) throw new Error(`carteira_assignments (donos): ${error.message}`);
    if (data == null) throw new Error('carteira_assignments (donos): data null sem error — malformada, não é fim');
    for (const r of data) donos.set(r.customer_user_id, r.owner_user_id);
  }
  return donos;
}
