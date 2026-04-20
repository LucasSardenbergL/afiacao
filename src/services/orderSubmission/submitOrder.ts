import { syncOrderToOmie } from '@/services/omieService';
import { logger } from '@/lib/logger';
import { DELIVERY_FEES } from '@/types';
import type {
  SubmitOrderParams,
  SubmitOrderResult,
  SubmitErrorEntry,
  LastOrderItem,
} from './types';
import type { ServiceCartItem } from '@/hooks/unifiedOrder/types';
import {
  buildToolInfo,
  formatCustomerAddress,
  getToolName,
  resolveCustomerPhone,
} from './helpers';
import { buildPrintData } from './buildPrintData';

/**
 * Pure submitOrder function. Orchestrates:
 *  1. Insert sales_order Oben (abort everything if fails) + Omie sync (non-blocking).
 *  2. Insert sales_order Colacor (abort if fails) + Omie sync + auto-create production
 *     orders for "produto acabado" (tipo_produto 04/4).
 *  3. Sync afiação OS to Omie (non-blocking).
 *  4. Build print data and last-order summary.
 */
export async function submitOrder(params: SubmitOrderParams): Promise<SubmitOrderResult> {
  const {
    customer, customerUserId, user, cart, subtotals, volumes,
    payment, delivery, meta, companyProfiles, defaultProductionAssigneeId,
    getServicePrice, supabase,
  } = params;
  const { obenProductItems, colacorProductItems, serviceItems } = cart;
  const errors: SubmitErrorEntry[] = [];
  const results: string[] = [];

  if (!obenProductItems.length && !colacorProductItems.length && !serviceItems.length) {
    return {
      success: false,
      results: [],
      printDataList: [],
      lastOrderData: null,
      errors: [{ step: 'validate', message: 'Carrinho vazio' }],
    };
  }

  const storedAddress = formatCustomerAddress(delivery.selectedAddress, customer);
  const storedPhone = await resolveCustomerPhone(supabase, customer, customerUserId, user.id);

  // ──────────────── Oben ────────────────
  if (obenProductItems.length > 0) {
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

    let salesOrderId: string;
    try {
      const { data: salesOrder, error: insertError } = await supabase
        .from('sales_orders').insert({
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.oben,
          total: subtotals.oben,
          status: 'rascunho',
          notes: meta.notes || null,
          account: 'oben',
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        }).select('id').single();
      if (insertError) throw insertError;
      salesOrderId = salesOrder.id;
    } catch (e: any) {
      logger.critical('Failed to insert sales_order in Supabase — aborting', {
        stage: 'supabase_insert',
        account: 'oben',
        customerId: customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: obenProductItems.length,
        error: e,
      });
      return {
        success: false,
        results,
        printDataList: [],
        lastOrderData: null,
        errors: [{ step: 'insert_oben', message: e?.message || 'Erro ao inserir pedido Oben' }],
      };
    }

    try {
      const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_pedido', account: 'oben', sales_order_id: salesOrderId,
          codigo_cliente: customer.codigo_cliente,
          codigo_vendedor: customer.codigo_vendedor,
          items: obenProductItems.map(c => ({
            omie_codigo_produto: c.product.omie_codigo_produto,
            quantidade: c.quantity,
            valor_unitario: c.unit_price,
            descricao: c.product.descricao,
            ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor } : {}),
          })),
          observacao: meta.notes,
          codigo_parcela: payment.parcelaOben,
          quantidade_volumes: volumes.oben || undefined,
          ordem_compra: meta.ordemCompra || undefined,
        },
      });
      if (!omieError) {
        results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
      } else {
        results.push('PV Oben (pendente ERP)');
        errors.push({ step: 'sync_oben_omie', message: omieError.message || 'Falha ao sincronizar Oben com Omie' });
      }
    } catch (e: any) {
      logger.error('Oben Omie sync exception', {
        stage: 'omie_sync',
        account: 'oben',
        customerId: customer.codigo_cliente,
        salesOrderId,
        error: e,
      });
      results.push('PV Oben (pendente ERP)');
      errors.push({ step: 'sync_oben_omie', message: e?.message || 'Falha ao sincronizar Oben com Omie' });
    }
  }

  // ──────────────── Colacor ────────────────
  if (colacorProductItems.length > 0) {
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

    let salesOrderId: string;
    try {
      const { data: salesOrder, error: insertError } = await supabase
        .from('sales_orders').insert({
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.colacor,
          total: subtotals.colacor,
          status: 'rascunho',
          notes: meta.notes || null,
          account: 'colacor',
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        }).select('id').single();
      if (insertError) throw insertError;
      salesOrderId = salesOrder.id;
    } catch (e: any) {
      logger.critical('Failed to insert sales_order in Supabase — aborting', {
        stage: 'supabase_insert',
        account: 'colacor',
        customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: colacorProductItems.length,
        error: e,
      });
      return {
        success: false,
        results,
        printDataList: [],
        lastOrderData: null,
        errors: [...errors, { step: 'insert_colacor', message: e?.message || 'Erro ao inserir pedido Colacor' }],
      };
    }

    try {
      const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_pedido', account: 'colacor', sales_order_id: salesOrderId,
          codigo_cliente: customer.codigo_cliente_colacor || customer.codigo_cliente,
          codigo_vendedor: customer.codigo_vendedor_colacor ?? customer.codigo_vendedor,
          items: colacorProductItems.map(c => ({
            omie_codigo_produto: c.product.omie_codigo_produto,
            quantidade: c.quantity,
            valor_unitario: c.unit_price,
          })),
          observacao: meta.notes,
          codigo_parcela: payment.parcelaColacor,
          quantidade_volumes: volumes.colacor || undefined,
          ordem_compra: meta.ordemCompra || undefined,
        },
      });
      if (!omieError) {
        results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
        // Auto-create production orders for "produto acabado"
        const produtoAcabadoItems = colacorProductItems.filter(c => {
          const tp = c.product.metadata?.tipo_produto;
          return tp === '04' || tp === 4 || tp === '4';
        });
        if (produtoAcabadoItems.length > 0) {
          if (!defaultProductionAssigneeId) {
            errors.push({
              step: 'create_production_order',
              message: 'Responsável padrão de produção não configurado (Governance > Settings).',
            });
            logger.warn('Skipping production order: default_production_assignee_id is not set', {
              stage: 'op_creation',
              account: 'colacor',
              salesOrderId,
              produtoAcabadoCount: produtoAcabadoItems.length,
            });
          } else {
            try {
              await supabase.functions.invoke('omie-vendas-sync', {
                body: {
                  action: 'criar_ordem_producao', account: 'colacor',
                  sales_order_id: salesOrderId,
                  items: produtoAcabadoItems.map(c => ({
                    product_id: c.product.id,
                    omie_codigo_produto: c.product.omie_codigo_produto,
                    codigo: c.product.codigo,
                    descricao: c.product.descricao,
                    quantidade: c.quantity,
                    unidade: c.product.unidade,
                    assigned_to: defaultProductionAssigneeId,
                  })),
                },
              });
              logger.info('Production orders created', {
                stage: 'op_creation',
                account: 'colacor',
                salesOrderId,
                count: produtoAcabadoItems.length,
              });
            } catch (opErr: any) {
              logger.critical('Failed to create production orders for produto acabado', {
                stage: 'op_creation',
                account: 'colacor',
                customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
                salesOrderId,
                itemCount: produtoAcabadoItems.length,
                error: opErr,
              });
              errors.push({ step: 'create_production_order', message: opErr?.message || 'Falha ao criar OP' });
            }
          }
        }
      } else {
        results.push('PV Colacor (pendente ERP)');
        errors.push({ step: 'sync_colacor_omie', message: omieError.message || 'Falha ao sincronizar Colacor com Omie' });
      }
    } catch (e: any) {
      logger.error('Colacor Omie sync exception', {
        stage: 'omie_sync',
        account: 'colacor',
        customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
        salesOrderId,
        error: e,
      });
      results.push('PV Colacor (pendente ERP)');
      errors.push({ step: 'sync_colacor_omie', message: e?.message || 'Falha ao sincronizar Colacor com Omie' });
    }
  }

  // ──────────────── Afiação ────────────────
  if (serviceItems.length > 0) {
    try {
      const orderId = crypto.randomUUID();
      const orderItems = serviceItems.map((c: ServiceCartItem) => {
        const price = getServicePrice(c);
        return {
          category: c.servico?.descricao || '',
          quantity: c.quantity,
          omie_codigo_servico: c.servico?.omie_codigo_servico,
          userToolId: c.userTool.id,
          toolName: getToolName(c.userTool),
          notes: c.notes,
          photos: c.photos || [],
          unitPrice: price || 0,
          toolCategoryId: c.userTool.tool_category_id,
          toolSpecs: c.userTool.specifications || {},
        };
      });
      const addr = delivery.selectedAddress;
      const addressPayload = addr ? {
        street: addr.street, number: addr.number,
        complement: addr.complement || undefined,
        neighborhood: addr.neighborhood, city: addr.city,
        state: addr.state, zip_code: addr.zipCode,
      } : undefined;
      const orderData = {
        items: orderItems,
        service_type: 'padrao',
        subtotal: subtotals.service,
        delivery_fee: DELIVERY_FEES[delivery.option],
        total: subtotals.service + DELIVERY_FEES[delivery.option],
        notes: serviceItems.map(buildToolInfo).filter(Boolean).join(' || '),
        payment_method: payment.afiacaoMethod,
      };
      const profileData = {
        name: customer.nome_fantasia || customer.razao_social,
        document: customer.cnpj_cpf || undefined,
      };
      const staffContext = {
        customerOmieCode: customer.codigo_cliente_afiacao || customer.codigo_cliente,
        customerUserId: customerUserId || null,
        customerCodigoVendedor: customer.codigo_vendedor_afiacao ?? customer.codigo_vendedor ?? null,
      };
      const result = await syncOrderToOmie(orderId, orderData, profileData, addressPayload, staffContext);
      if (result.success) {
        results.push(`OS ${result.omie_os?.cNumOS || ''}`);
      } else {
        results.push('OS Afiação (pendente ERP)');
        errors.push({ step: 'sync_os_omie', message: 'Falha ao sincronizar OS com Omie' });
      }
    } catch (e: any) {
      logger.error('Afiação OS Omie sync exception', {
        stage: 'omie_sync',
        account: 'afiacao',
        customerId: customer.codigo_cliente_afiacao || customer.codigo_cliente,
        error: e,
      });
      results.push('OS Afiação (pendente ERP)');
      errors.push({ step: 'sync_os_omie', message: e?.message || 'Falha ao sincronizar OS com Omie' });
    }
  }

  // ──────────────── Print + Last-order data ────────────────
  const customerAddressFull = formatCustomerAddress(delivery.selectedAddress, customer) || undefined;
  const customerPhone = storedPhone || '';

  const printDataList = buildPrintData({
    customer,
    customerAddress: customerAddressFull,
    customerPhone,
    obenProductItems,
    colacorProductItems,
    serviceItems,
    obenSubtotal: subtotals.oben,
    colacorSubtotal: subtotals.colacor,
    serviceSubtotal: subtotals.service,
    parcelaOben: payment.parcelaOben,
    parcelaColacor: payment.parcelaColacor,
    formasPagamentoOben: payment.formasPagamentoOben,
    formasPagamentoColacor: payment.formasPagamentoColacor,
    afiacaoMethod: payment.afiacaoMethod,
    deliveryOption: delivery.option,
    notes: meta.notes,
    results,
    companyProfiles,
    getServicePrice,
  });

  const allItems: LastOrderItem[] = [
    ...obenProductItems.map(c => ({
      description: c.product.descricao,
      quantity: c.quantity,
      unitPrice: c.unit_price,
      codigo: c.product.codigo,
      unidade: c.product.unidade,
      tintCorId: c.tint_cor_id,
      tintNomeCor: c.tint_nome_cor,
    })),
    ...colacorProductItems.map(c => ({
      description: c.product.descricao,
      quantity: c.quantity,
      unitPrice: c.unit_price,
      codigo: c.product.codigo,
      unidade: c.product.unidade,
    })),
    ...serviceItems.map(c => ({
      description: c.servico?.descricao || getToolName(c.userTool),
      quantity: c.quantity,
      unitPrice: getServicePrice(c) || 0,
    })),
  ];

  const total =
    subtotals.oben + subtotals.colacor +
    subtotals.service + DELIVERY_FEES[delivery.option];

  const lastOrderData = {
    customerName: customer.nome_fantasia || customer.razao_social,
    customerDocument: customer.cnpj_cpf || '',
    items: allItems,
    total,
    orderNumbers: results,
    printDataList,
  };

  return {
    success: true,
    results,
    printDataList,
    lastOrderData,
    errors,
  };
}
