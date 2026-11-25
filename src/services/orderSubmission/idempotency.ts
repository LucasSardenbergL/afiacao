import type { SubmitClient } from './types';
import type { Json } from '@/integrations/supabase/types';
import { centavos } from '@/lib/centavos';

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

/**
 * PR 2.4 (Codex #4164, rodada 2): o PV já enviado tem o VALOR que esta conta grava agora? O fingerprint
 * compara o unitário ao centavo, então um PV enviado a 100 × 7,1249 (R$ 712,49, rascunho de antes da
 * regra de centavos) e o carrinho atual a 7,12 (R$ 712,00) dão o MESMO envelope — o reenvio pularia o PV
 * como "já enviado" e o comprovante afirmaria R$ 712,00. Compara o `total` gravado na 1ª tentativa com o
 * desta, ao centavo. Ausente ≠ igual: total gravado nulo/ilegível → NÃO confere.
 */
export function valorGravadoConfere(totalGravado: unknown, totalAtual: number): boolean {
  if (typeof totalGravado === 'string' && totalGravado.trim() === '') return false;
  if (typeof totalGravado !== 'number' && typeof totalGravado !== 'string') return false;
  const g = Number(totalGravado);
  if (!Number.isFinite(g) || !Number.isFinite(totalAtual)) return false;
  return centavos(g) === centavos(totalAtual);
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
  // Pela RPC, não por `.from('sales_orders').select(... omie_response)`: omie_response é fechada por
  // coluna para authenticated (o select direto dava 403 e derrubava todo checkout pelo app). A RPC
  // devolve 0/1 linha do par (checkout_id, account) e a `consulta` do PV só quando reconciliado —
  // que é tudo o que pvReconciliadoConfere lê. Migration 20261121160000.
  const findExisting = async (): Promise<Existente | null> => {
    const { data, error } = await supabase
      .rpc('pedido_por_checkout', { p_checkout_id: checkoutId, p_account: account });
    if (error) throw error;
    const linhas = (data ?? []) as Array<{
      id: string; omie_pedido_id: number | null; pv_reconciliado: boolean; pv_consulta: unknown;
    }>;
    if (linhas.length > 1) {
      // UNIQUE (checkout_id, account) garante ≤1; mais que isso é dado quebrado — não escolher às cegas.
      throw new Error(`pedido_por_checkout devolveu ${linhas.length} linhas para (checkout_id=${checkoutId}, account=${account})`);
    }
    const l = linhas[0];
    if (!l) return null;
    return {
      id: l.id,
      omie_pedido_id: l.omie_pedido_id,
      omie_response: l.pv_reconciliado ? { reconciled: true, consulta: l.pv_consulta } : null,
    };
  };

  // skip/reuse sobre uma linha já lida — o MESMO caminho na 1ª leitura e na re-busca pós-23505
  // (antes a corrida devolvia alreadySent sem conferir o PV reconciliado e sem atualizar o rascunho
  // com o carrinho atual — Codex, 2026-11-21).
  const tratarExistente = async (linha: Existente): Promise<{ id: string; alreadySent: boolean; pvDivergente?: boolean }> => {
    if (decideSalesOrderAction(linha) === 'skip') {
      // `total` é legível por coluna (só omie_response é fechada — por isso a RPC acima). Falha de
      // leitura aborta o envio, como a da RPC: nunca dar o PV por conferido sem ter lido o valor.
      const { data: gravado, error: erroTotal } = await supabase
        .from('sales_orders').select('total').eq('id', linha.id).maybeSingle();
      if (erroTotal) throw erroTotal;
      if (!gravado) throw new Error(`sales_orders ${linha.id} não pôde ser lida ao conferir o valor do PV já enviado`);
      const confere = pvReconciliadoConfere(linha.omie_response, fields.items)
        && valorGravadoConfere((gravado as { total?: unknown }).total, fields.total);
      return { id: linha.id, alreadySent: true, pvDivergente: !confere };
    }
    const { error } = await supabase.from('sales_orders').update({
      items: fields.items, subtotal: fields.subtotal, total: fields.total, notes: fields.notes,
      customer_document: fields.customer_document,
      customer_address: fields.customer_address, customer_phone: fields.customer_phone,
      ready_by_date: fields.ready_by_date,
    }).eq('id', linha.id);
    if (error) throw error;
    return { id: linha.id, alreadySent: false };
  };

  const existing = await findExisting();
  if (existing) return tratarExistente(existing);

  const { data, error } = await supabase.from('sales_orders').insert({
    ...fields, status: 'rascunho', account, checkout_id: checkoutId, origem, atendimento_id: atendimentoId,
  }).select('id').single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExisting();
      if (raced) return tratarExistente(raced);
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
