import type { SubmitQuoteParams, SubmitQuoteResult, SubmitErrorEntry } from './types';
import { logger } from '@/lib/logger';
import { formatCustomerAddress, resolveCustomerPhone } from './helpers';
import { validarVendabilidade, bloqueioVendabilidade } from './vendabilidade';
import { findInvalidPricedProductItems, invalidPriceMessage } from './priceGuard';

/**
 * Saves cart as quotes (orcamento) — no Omie sync.
 * Inserts one row per account into sales_orders with status='orcamento'.
 */
export async function submitQuote(params: SubmitQuoteParams): Promise<SubmitQuoteResult> {
  const { customer, customerUserId, user, cart, subtotals, delivery, meta, supabase } = params;
  const { obenProductItems, colacorProductItems } = cart;
  const errors: SubmitErrorEntry[] = [];
  const results: string[] = [];

  if (obenProductItems.length === 0 && colacorProductItems.length === 0) {
    return { success: false, results: [], errors: [{ step: 'validate', message: 'Carrinho vazio' }] };
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
        } : {}),
      }));
      const { error } = await supabase.from('sales_orders').insert({
        customer_user_id: customerUserId || user.id,
        created_by: user.id,
        items: itemsPayload,
        subtotal: subtotals.oben,
        total: subtotals.oben,
        status: 'orcamento',
        notes: meta.notes || null,
        account: 'oben',
        customer_address: storedAddress,
        customer_phone: storedPhone,
      });
      if (error) throw error;
      results.push('Orçamento Oben salvo');
    } catch (e) {
      logger.critical('Failed to insert quote in Supabase', {
        stage: 'supabase_insert',
        account: 'oben',
        customerId: customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: obenProductItems.length,
        kind: 'quote',
        error: e,
      });
      return {
        success: false,
        results,
        errors: [{ step: 'insert_oben_quote', message: e instanceof Error ? e.message : 'Erro ao salvar orçamento Oben' }],
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
        customer_user_id: customerUserId || user.id,
        created_by: user.id,
        items: itemsPayload,
        subtotal: subtotals.colacor,
        total: subtotals.colacor,
        status: 'orcamento',
        notes: meta.notes || null,
        account: 'colacor',
        customer_address: storedAddress,
        customer_phone: storedPhone,
      });
      if (error) throw error;
      results.push('Orçamento Colacor salvo');
    } catch (e) {
      logger.critical('Failed to insert quote in Supabase', {
        stage: 'supabase_insert',
        account: 'colacor',
        customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: colacorProductItems.length,
        kind: 'quote',
        error: e,
      });
      errors.push({ step: 'insert_colacor_quote', message: e instanceof Error ? e.message : 'Erro ao salvar orçamento Colacor' });
    }
  }

  return {
    success: results.length > 0,
    results,
    errors,
  };
}
