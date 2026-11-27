import type { SubmitQuoteParams, SubmitQuoteResult, SubmitErrorEntry } from './types';
import { logger } from '@/lib/logger';
import { formatCustomerAddress, resolveCustomerPhone, titularDoPedido, MSG_TITULAR_SEM_CLIENTE } from './helpers';
import { validarVendabilidade, bloqueioVendabilidade } from './vendabilidade';
import { findInvalidPricedProductItems, invalidPriceMessage } from './priceGuard';
import { bloqueioTabelaTint } from './tabelaTint';

/**
 * Saves cart as quotes (orcamento) — no Omie sync.
 * Inserts one row per account into sales_orders with status='orcamento'.
 */
export async function submitQuote(params: SubmitQuoteParams): Promise<SubmitQuoteResult> {
  const { customer, customerUserId, user, cart, subtotals, delivery, meta, supabase, isCustomerMode = false } = params;
  const { obenProductItems, colacorProductItems } = cart;
  const errors: SubmitErrorEntry[] = [];
  const results: string[] = [];
  // A4 (rodada 2): o desfecho é POR CONTA — orçamento misto com uma conta falhando não é "salvo".
  const contasSalvas: Array<'oben' | 'colacor'> = [];
  const contasPendentes: Array<'oben' | 'colacor'> = [];

  if (obenProductItems.length === 0 && colacorProductItems.length === 0) {
    return { success: false, results: [], errors: [{ step: 'validate', message: 'Carrinho vazio' }] };
  }

  // Onda D 4b-2: staff sem cliente vinculado não grava orçamento no próprio nome (ver titularDoPedido).
  const titular = titularDoPedido(customerUserId, user.id, isCustomerMode);
  if (!titular) {
    return { success: false, results: [], errors: [{ step: 'validate_titular', message: MSG_TITULAR_SEM_CLIENTE }] };
  }

  // Guard money-path: orçamento com produto a preço ≤ 0 vira pedido depois — bloqueia
  // igual ao submitOrder (fail-closed, antes de qualquer insert). Ver priceGuard.ts.
  const invalidPriced = findInvalidPricedProductItems([...obenProductItems, ...colacorProductItems]);
  if (invalidPriced.length > 0) {
    return { success: false, results: [], errors: [{ step: 'validate_price', message: invalidPriceMessage(invalidPriced) }] };
  }

  // Preflight de vendabilidade (fail-closed) — mesma fronteira money-path do submitOrder:
  // não salvar orçamento de produto que ficou inativo no Omie (rascunho/cache podem trazê-lo).
  const vend = await validarVendabilidade(supabase, [...obenProductItems, ...colacorProductItems]);
  const bloqueioVend = bloqueioVendabilidade(vend);
  if (bloqueioVend) {
    return { success: false, results: [], errors: [{ step: 'validate_vendabilidade', message: bloqueioVend }] };
  }

  // Fonte tint 'tabela' implausível (CSV sem a base, < 50% do calculado): o orçamento
  // não cruza o gate do edge, mas é impresso ao cliente — revalida aqui (fail-closed).
  const bloqueioTabela = await bloqueioTabelaTint(supabase, [...obenProductItems, ...colacorProductItems]);
  if (bloqueioTabela) {
    return { success: false, results: [], errors: [{ step: 'validate_tint_tabela', message: bloqueioTabela }] };
  }

  const storedAddress = formatCustomerAddress(delivery.selectedAddress, customer);
  const storedPhone = await resolveCustomerPhone(supabase, customer, customerUserId, user.id);

  // Oben quote
  if (obenProductItems.length > 0) {
    try {
      const itemsPayload = obenProductItems.map(c => ({
        product_id: c.product.id,
        omie_codigo_produto: c.product.omie_codigo_produto,
        codigo: c.product.codigo,
        descricao: c.product.descricao,
        unidade: c.product.unidade,
        quantidade: c.quantity,
        valor_unitario: c.unit_price,
        valor_total: c.quantity * c.unit_price,
        ...(c.tint_cor_id ? {
          tint_cor_id: c.tint_cor_id,
          tint_nome_cor: c.tint_nome_cor,
          tint_formula_id: c.tint_formula_id,
          // Fase 3: fonte/desconto viajam no orçamento — a CONVERSÃO repassa ao
          // edge e o gate revalida a fonte declarada contra o estado do dia.
          ...(c.tint_price_source ? {
            tint_price_source: c.tint_price_source,
            tint_discount_pct: c.tint_discount_pct ?? 0,
            ...(c.tint_preco_sem_desconto != null ? { tint_preco_sem_desconto: c.tint_preco_sem_desconto } : {}),
          } : {}),
        } : {}),
      }));
      const { error } = await supabase.from('sales_orders').insert({
        customer_user_id: titular,
        created_by: user.id,
        items: itemsPayload,
        subtotal: subtotals.oben,
        total: subtotals.oben,
        status: 'orcamento',
        notes: meta.notes || null,
        account: 'oben',
        // Âncora money-path (P0-B): documento do cliente REAL (raw). O edge deriva o código Omie por-conta
        // DESTE documento na conversão — imune ao fallback customer_user_id || user.id.
        customer_document: customer.cnpj_cpf || null,
        customer_address: storedAddress,
        customer_phone: storedPhone,
      });
      if (error) throw error;
      results.push('Orçamento Oben salvo');
      contasSalvas.push('oben');
    } catch (e) {
      logger.critical('Failed to insert quote in Supabase', {
        stage: 'supabase_insert',
        account: 'oben',
        customerId: customer.codigo_cliente,
        customerUserId: titular,
        itemCount: obenProductItems.length,
        kind: 'quote',
        error: e,
      });
      return {
        success: false,
        results,
        errors: [{ step: 'insert_oben_quote', message: e instanceof Error ? e.message : 'Erro ao salvar orçamento Oben' }],
        // Oben aborta ANTES da Colacor: nada gravou — as duas contas seguem pendentes.
        contasSalvas: [],
        contasPendentes: colacorProductItems.length > 0 ? ['oben', 'colacor'] : ['oben'],
      };
    }
  }

  // Colacor quote
  if (colacorProductItems.length > 0) {
    try {
      const itemsPayload = colacorProductItems.map(c => ({
        product_id: c.product.id,
        omie_codigo_produto: c.product.omie_codigo_produto,
        codigo: c.product.codigo,
        descricao: c.product.descricao,
        unidade: c.product.unidade,
        quantidade: c.quantity,
        valor_unitario: c.unit_price,
        valor_total: c.quantity * c.unit_price,
      }));
      const { error } = await supabase.from('sales_orders').insert({
        customer_user_id: titular,
        created_by: user.id,
        items: itemsPayload,
        subtotal: subtotals.colacor,
        total: subtotals.colacor,
        status: 'orcamento',
        notes: meta.notes || null,
        account: 'colacor',
        customer_document: customer.cnpj_cpf || null,
        customer_address: storedAddress,
        customer_phone: storedPhone,
      });
      if (error) throw error;
      results.push('Orçamento Colacor salvo');
      contasSalvas.push('colacor');
    } catch (e) {
      logger.critical('Failed to insert quote in Supabase', {
        stage: 'supabase_insert',
        account: 'colacor',
        customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
        customerUserId: titular,
        itemCount: colacorProductItems.length,
        kind: 'quote',
        error: e,
      });
      contasPendentes.push('colacor');
      errors.push({ step: 'insert_colacor_quote', message: e instanceof Error ? e.message : 'Erro ao salvar orçamento Colacor' });
    }
  }

  return {
    success: contasSalvas.length > 0,
    results,
    errors,
    contasSalvas,
    contasPendentes,
  };
}

const NOME_CONTA: Record<'oben' | 'colacor', string> = { oben: 'Oben', colacor: 'Colacor' };

/** A4 (rodada 2): título do desfecho parcial — diz o que gravou e o que ficou, por conta. */
export function mensagemOrcamentoParcial(
  salvas: ReadonlyArray<'oben' | 'colacor'>,
  pendentes: ReadonlyArray<'oben' | 'colacor'>,
): string {
  const s = salvas.map(c => NOME_CONTA[c]).join(' e ');
  const p = pendentes.map(c => NOME_CONTA[c]).join(' e ');
  return `Orçamento ${s} salvo; ${p} pendente — os itens pendentes seguem no carrinho`;
}

/** A4 (rodada 2) + ciclo do rascunho: após um orçamento PARCIAL, ficam no carrinho só as linhas
 *  das contas que NÃO foram gravadas (reenviar não duplica a conta salva). Serviços e contas
 *  pendentes ficam. O mesmo recorte grava o rascunho NA HORA — um refresh antes do debounce
 *  restauraria a conta salva e o reenvio a duplicaria. */
export function carrinhoAposOrcamentoParcial<T extends { type: string; account?: string | null }>(
  cart: ReadonlyArray<T>,
  contasSalvas: ReadonlyArray<'oben' | 'colacor'>,
): T[] {
  const salvas = new Set<string>(contasSalvas);
  return cart.filter(c => !(c.type === 'product' && c.account != null && salvas.has(c.account)));
}
