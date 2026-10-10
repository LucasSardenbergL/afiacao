import type { SubmitClient } from './types';
import type { Json } from '@/integrations/supabase/types';

export type SalesOrderAction = 'insert' | 'reuse' | 'skip';

/**
 * Decide o que fazer com a linha de sales_orders de um (checkout_id, account).
 * O sinal de "já no Omie" é omie_pedido_id (NÃO o status — o sync de entrada muda
 * o status p/ faturado/separacao/importado após o envio; usar status reenviaria).
 *  - null                → 'insert'
 *  - omie_pedido_id != null → 'skip'  (idempotência: já está no Omie)
 *  - omie_pedido_id null    → 'reuse' (tentativa anterior não chegou no Omie)
 */
export function decideSalesOrderAction(
  existing: { omie_pedido_id: number | null } | null,
): SalesOrderAction {
  if (!existing) return 'insert';
  if (existing.omie_pedido_id != null) return 'skip';
  return 'reuse';
}

/**
 * O PV vinculado por DUPLICIDADE confere com o carrinho? (ATP 3.3, espelho de
 * `compararCarrinhoPv` em supabase/functions/_shared/atp-pv-omie.ts.) Quando o reenvio é
 * reconciliado, a edge vincula o PV que JÁ existia — com os itens de uma tentativa anterior — e
 * lança avisando. No clique SEGUINTE a linha já tem PID e este módulo PULA a edge: sem esta
 * conferência o carrinho atual seria dado como enviado (Codex 3.3, 2ª rodada).
 * `true` = não foi reconciliado, ou foi e o PV tem os mesmos SKU/quantidade.
 */
export function pvReconciliadoConfere(omieResponse: unknown, itens: unknown): boolean {
  const r = omieResponse as { reconciled?: unknown; consulta?: { pedido_venda_produto?: { det?: unknown }; det?: unknown } } | null;
  if (r?.reconciled !== true) return true;
  const det = r.consulta?.pedido_venda_produto?.det ?? r.consulta?.det;
  if (!Array.isArray(det) || det.length === 0 || !Array.isArray(itens)) return false;
  const soma = (pares: Array<[unknown, unknown]>): Map<number, number> | null => {
    const m = new Map<number, number>();
    for (const [c, q] of pares) {
      if (!/^[0-9]{1,18}$/.test(String(c ?? '')) || Number(c) <= 0) return null;
      if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) return null;
      m.set(Number(c), (m.get(Number(c)) ?? 0) + q);
    }
    return m;
  };
  const pv = soma(det.map((e) => {
    const p = (e as { produto?: { codigo_produto?: unknown; quantidade?: unknown } })?.produto;
    return [p?.codigo_produto, p?.quantidade];
  }));
  const carrinho = soma(itens.map((i) => {
    const x = i as { omie_codigo_produto?: unknown; quantidade?: unknown };
    return [x?.omie_codigo_produto, x?.quantidade];
  }));
  if (!pv || !carrinho || pv.size !== carrinho.size) return false;
  for (const [sku, q] of carrinho) {
    if (!pv.has(sku) || Math.abs((pv.get(sku) ?? 0) - q) > 1e-6) return false;
  }
  return true;
}

export interface EnsureSalesOrderArgs {
  checkoutId: string;
  account: string;
  origem: string | null;
  atendimentoId: string | null;
  fields: {
    customer_user_id: string; created_by: string; items: Json;
    subtotal: number; total: number; notes: string | null;
    customer_document: string | null;
    customer_address: string | null; customer_phone: string | null; ready_by_date: string | null;
  };
}

/**
 * Garante 1 linha de sales_orders por (checkout_id, account), idempotente:
 *  - já no Omie (omie_pedido_id) → não toca; alreadySent=true → o caller PULA o edge.
 *  - rascunho                    → atualiza os campos do carrinho atual; reusa o id.
 *  - inexistente                 → insere; em corrida (23505) re-busca e reusa.
 * O id é estável entre retries do mesmo checkout → a chave determinística PV_<id> também.
 */
export async function ensureSalesOrderRow(
  supabase: SubmitClient,
  args: EnsureSalesOrderArgs,
): Promise<{ id: string; alreadySent: boolean; pvDivergente?: boolean }> {
  const { checkoutId, account, origem, atendimentoId, fields } = args;

  type Existente = { id: string; omie_pedido_id: number | null; omie_response?: unknown };
  const findExisting = async (): Promise<Existente | null> => {
    const { data, error } = await supabase
      .from('sales_orders').select('id, omie_pedido_id, omie_response')
      .eq('checkout_id', checkoutId).eq('account', account).maybeSingle();
    if (error) throw error;
    return (data as Existente | null) ?? null;
  };

  const existing = await findExisting();
  const action = decideSalesOrderAction(existing);

  if (action === 'skip') {
    return { id: existing!.id, alreadySent: true, pvDivergente: !pvReconciliadoConfere(existing!.omie_response, fields.items) };
  }

  if (action === 'reuse') {
    const { error } = await supabase.from('sales_orders').update({
      items: fields.items, subtotal: fields.subtotal, total: fields.total, notes: fields.notes,
      customer_document: fields.customer_document,
      customer_address: fields.customer_address, customer_phone: fields.customer_phone,
      ready_by_date: fields.ready_by_date,
    }).eq('id', existing!.id);
    if (error) throw error;
    return { id: existing!.id, alreadySent: false };
  }

  const { data, error } = await supabase.from('sales_orders').insert({
    ...fields, status: 'rascunho', account, checkout_id: checkoutId, origem, atendimento_id: atendimentoId,
  }).select('id').single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExisting();
      if (raced) return { id: raced.id, alreadySent: decideSalesOrderAction(raced) === 'skip' };
      // 23505 mas a linha conflitante sumiu antes da re-busca (deleção concorrente rara) —
      // erro contextual em vez do PostgresError 23505 opaco (anti-falha-silenciosa).
      throw new Error(
        `Corrida de inserção (23505) em sales_orders (checkout_id=${checkoutId}, account=${account}): a linha conflitante sumiu antes da re-busca — tente novamente.`,
      );
    }
    throw error;
  }
  return { id: data.id, alreadySent: false };
}
