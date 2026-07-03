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
  missingAccountIdentities,
  resolveCustomerPhone,
} from './helpers';
import { buildPrintData } from './buildPrintData';
import { ensureSalesOrderRow } from './idempotency';
import { validarVendabilidade, bloqueioVendabilidade } from './vendabilidade';
import { findInvalidPricedProductItems, invalidPriceMessage } from './priceGuard';

/** Resposta estruturada do gate de crédito do edge (trava Fase 2 — não cria o PV). */
interface GateCreditoPayload {
  blocked?: string;
  gate?: { vencido?: number | null; titulos?: number | null } | null;
}

export function mensagemBloqueioCredito(
  conta: string,
  gate?: { vencido?: number | null; titulos?: number | null } | null,
): string {
  const valor =
    typeof gate?.vencido === 'number'
      ? ` — R$ ${gate.vencido.toFixed(2)} vencido há 60+ dias${gate?.titulos ? ` (${gate.titulos} título${gate.titulos > 1 ? 's' : ''})` : ''}`
      : '';
  return (
    `Pedido ${conta} BLOQUEADO por crédito${valor}. O pedido ficou salvo: ` +
    `um gestor pode aprovar uma exceção para ESTE pedido e aí é só reenviar.`
  );
}

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
    getServicePrice, supabase, isCustomerMode = false,
    checkoutId, origem = null, atendimentoId = null,
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
      allConfirmed: false,
    };
  }

  // ── Guard money-path: nenhum item de PRODUTO pode ter preço ≤ 0 ──
  // O input do carrinho vira 0 ao esvaziar (parseFloat||0) e o cockpit/Régua filtram
  // preco>0, então um produto zerado fica invisível e enviaria um PV com valor zerado
  // (prejuízo / pedido inválido no Omie). Bloqueia o pedido INTEIRO (fail-closed) antes
  // de qualquer insert ou chamada ao ERP. Serviço de afiação fica de fora (preço 0 = "a orçar").
  const invalidPriced = findInvalidPricedProductItems([...obenProductItems, ...colacorProductItems]);
  if (invalidPriced.length > 0) {
    return {
      success: false,
      results: [],
      printDataList: [],
      lastOrderData: null,
      errors: [{ step: 'validate_price', message: invalidPriceMessage(invalidPriced) }],
      allConfirmed: false,
    };
  }

  // ── Preflight de identidade por-conta (fail-closed) — APENAS staff ──
  // Cada conta Omie tem código de cliente próprio; NUNCA enviar o código de uma
  // conta para outra (o fallback antigo `|| codigo_cliente` registrava o pedido
  // no cliente errado). Se uma conta COM itens não tem identidade resolvida,
  // bloqueia o envio INTEIRO antes de qualquer insert — não enviar pela metade
  // num pedido multi-conta nem registrar na conta errada.
  // Modo cliente (autoatendimento) usa cliente sintético (codigo_cliente=0, sem
  // código por-conta) e só tem itens de afiação; lá o edge resolve a identidade
  // por user/documento → não aplicar o preflight (senão bloquearia toda OS).
  if (!isCustomerMode) {
    const missingIdentities = missingAccountIdentities({
      hasOben: obenProductItems.length > 0,
      hasColacor: colacorProductItems.length > 0,
      hasAfiacao: serviceItems.length > 0,
      codigoCliente: customer.codigo_cliente,
      codigoClienteColacor: customer.codigo_cliente_colacor,
      codigoClienteAfiacao: customer.codigo_cliente_afiacao,
    });
    if (missingIdentities.length > 0) {
      return {
        success: false,
        results: [],
        printDataList: [],
        lastOrderData: null,
        errors: [{
          step: 'validate_identity',
          message: `Não foi possível confirmar o cadastro do cliente na(s) conta(s): ${missingIdentities.join(', ')} (provável falha temporária do Omie). O pedido NÃO foi enviado — evita registrar na conta errada. Para revalidar, re-selecione o cliente (atenção: isso limpa o carrinho).`,
        }],
        allConfirmed: false,
      };
    }
  }

  // ── Preflight de vendabilidade (fail-closed) — fronteira money-path ──
  // O filtro de catálogo (wizard/tint) é UX; a GARANTIA de não vender inativo é aqui.
  // Rascunho restaurado e o cache de 10min do catálogo podem trazer um produto que
  // ficou inativo no Omie DEPOIS da seleção (useCart aceita qualquer Product) →
  // revalida `ativo` no banco antes de criar qualquer sales_order/PV. Serviços de
  // afiação não passam (não são omie_products vendáveis).
  const vend = await validarVendabilidade(supabase, [...obenProductItems, ...colacorProductItems]);
  const bloqueioVend = bloqueioVendabilidade(vend);
  if (bloqueioVend) {
    return {
      success: false,
      results: [],
      printDataList: [],
      lastOrderData: null,
      errors: [{ step: 'validate_vendabilidade', message: bloqueioVend }],
      allConfirmed: false,
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
    let alreadySent: boolean;
    try {
      const ensured = await ensureSalesOrderRow(supabase, {
        checkoutId, account: 'oben', origem, atendimentoId,
        fields: {
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.oben,
          total: subtotals.oben,
          notes: meta.notes || null,
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        },
      });
      salesOrderId = ensured.id;
      alreadySent = ensured.alreadySent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Erro ao inserir pedido Oben';
      logger.critical('Failed to ensure sales_order in Supabase — aborting', {
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
        errors: [{ step: 'insert_oben', message }],
        allConfirmed: false,
      };
    }

    if (alreadySent) {
      results.push('PV Oben (já enviado)');
    } else {
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
          const gatePayload = omieResult as GateCreditoPayload | null;
          if (gatePayload?.blocked === 'credito') {
            // Trava Fase 2: o edge NÃO criou o PV — degradar honesto, nunca "parecer enviado".
            results.push('PV Oben (bloqueado: crédito)');
            errors.push({ step: 'bloqueio_credito_oben', message: mensagemBloqueioCredito('Oben', gatePayload.gate) });
          } else {
            results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
          }
        } else {
          results.push('PV Oben (pendente ERP)');
          errors.push({ step: 'sync_oben_omie', message: omieError.message || 'Falha ao sincronizar Oben com Omie' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Falha ao sincronizar Oben com Omie';
        logger.error('Oben Omie sync exception', {
          stage: 'omie_sync',
          account: 'oben',
          customerId: customer.codigo_cliente,
          salesOrderId,
          error: e,
        });
        results.push('PV Oben (pendente ERP)');
        errors.push({ step: 'sync_oben_omie', message });
      }
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
    let alreadySent: boolean;
    try {
      const ensured = await ensureSalesOrderRow(supabase, {
        checkoutId, account: 'colacor', origem, atendimentoId,
        fields: {
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.colacor,
          total: subtotals.colacor,
          notes: meta.notes || null,
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        },
      });
      salesOrderId = ensured.id;
      alreadySent = ensured.alreadySent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Erro ao inserir pedido Colacor';
      logger.critical('Failed to ensure sales_order in Supabase — aborting', {
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
        errors: [...errors, { step: 'insert_colacor', message }],
        allConfirmed: false,
      };
    }

    if (alreadySent) {
      results.push('PV Colacor (já enviado)');
    } else {
      try {
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'colacor', sales_order_id: salesOrderId,
            // Identidade Colacor garantida pelo preflight (staff; Colacor não existe em modo cliente).
            codigo_cliente: customer.codigo_cliente_colacor!,
            // Vendedor é por-conta: NUNCA cair no vendedor Oben (comissão na conta errada). Ausente = null (edge tolera).
            codigo_vendedor: customer.codigo_vendedor_colacor ?? null,
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
        const gatePayloadColacor = !omieError ? (omieResult as GateCreditoPayload | null) : null;
        if (!omieError && gatePayloadColacor?.blocked === 'credito') {
          // Trava Fase 2: o edge NÃO criou o PV — degradar honesto, nunca "parecer enviado".
          results.push('PV Colacor (bloqueado: crédito)');
          errors.push({ step: 'bloqueio_credito_colacor', message: mensagemBloqueioCredito('Colacor', gatePayloadColacor.gate) });
        } else if (!omieError) {
          results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
          // Auto-create production orders for "produto acabado"
          const produtoAcabadoItems = colacorProductItems.filter(c => {
            // Coluna dedicada tipo_produto (Migration 2026-06-04) com fallback ao metadata legado.
            const tp = c.product.tipo_produto ?? c.product.metadata?.tipo_produto;
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
              } catch (opErr: unknown) {
                const opMessage = opErr instanceof Error ? opErr.message : 'Falha ao criar OP';
                logger.critical('Failed to create production orders for produto acabado', {
                  stage: 'op_creation',
                  account: 'colacor',
                  customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
                  salesOrderId,
                  itemCount: produtoAcabadoItems.length,
                  error: opErr,
                });
                errors.push({ step: 'create_production_order', message: opMessage });
              }
            }
          }
        } else {
          results.push('PV Colacor (pendente ERP)');
          errors.push({ step: 'sync_colacor_omie', message: omieError.message || 'Falha ao sincronizar Colacor com Omie' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Falha ao sincronizar Colacor com Omie';
        logger.error('Colacor Omie sync exception', {
          stage: 'omie_sync',
          account: 'colacor',
          customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
          salesOrderId,
          error: e,
        });
        results.push('PV Colacor (pendente ERP)');
        errors.push({ step: 'sync_colacor_omie', message });
      }
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
        // Staff: identidade Afiação garantida pelo preflight. Modo cliente (autoatendimento):
        // cliente sintético sem código afiação → mantém o fallback (o edge resolve por user/doc).
        customerOmieCode: isCustomerMode
          ? (customer.codigo_cliente_afiacao || customer.codigo_cliente)
          : customer.codigo_cliente_afiacao!,
        customerUserId: customerUserId || null,
        // Vendedor é por-conta: NUNCA cair no vendedor Oben (comissão errada). Ausente = null (edge tolera).
        customerCodigoVendedor: customer.codigo_vendedor_afiacao ?? null,
      };
      const result = await syncOrderToOmie(orderId, orderData, profileData, addressPayload, staffContext);
      if (result.success) {
        results.push(`OS ${result.omie_os?.cNumOS || ''}`);
      } else {
        results.push('OS Afiação (pendente ERP)');
        errors.push({ step: 'sync_os_omie', message: 'Falha ao sincronizar OS com Omie' });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Falha ao sincronizar OS com Omie';
      logger.error('Afiação OS Omie sync exception', {
        stage: 'omie_sync',
        account: 'afiacao',
        customerId: customer.codigo_cliente_afiacao || customer.codigo_cliente,
        error: e,
      });
      results.push('OS Afiação (pendente ERP)');
      errors.push({ step: 'sync_os_omie', message });
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
    allConfirmed: !errors.some(e =>
      e.step === 'sync_oben_omie' || e.step === 'sync_colacor_omie' || e.step === 'sync_os_omie' ||
      e.step === 'bloqueio_credito_oben' || e.step === 'bloqueio_credito_colacor'),
  };
}
