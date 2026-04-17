import type { SubmitQuoteParams, SubmitQuoteResult, SubmitErrorEntry } from './types';
import { formatCustomerAddress, resolveCustomerPhone } from './helpers';

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
      } as any);
      if (error) throw error;
      results.push('Orçamento Oben salvo');
    } catch (e: any) {
      console.error('[submitQuote] Oben insert failed:', e);
      return {
        success: false,
        results,
        errors: [{ step: 'insert_oben_quote', message: e?.message || 'Erro ao salvar orçamento Oben' }],
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
      } as any);
      if (error) throw error;
      results.push('Orçamento Colacor salvo');
    } catch (e: any) {
      console.error('[submitQuote] Colacor insert failed:', e);
      errors.push({ step: 'insert_colacor_quote', message: e?.message || 'Erro ao salvar orçamento Colacor' });
    }
  }

  return {
    success: results.length > 0,
    results,
    errors,
  };
}
