// Geração pura de HTML para impressão de pedidos.
// Extraído de src/pages/SalesPrintDashboard.tsx (god-component split).
import { formatarDataPedido } from '@/lib/pedido/data-pedido';
import { escapeHtml } from '@/lib/escape-html';
import { linhaItemCupomHtml, textoVencimentosDoCupom, thDescontoHtml, totalDoCupomHtml, totaisComDescontoHtml, type PrintOrderData } from '@/components/OrderPrintLayout';
import type { CompanyFilter, SalesOrderRow } from './types';
import { formatPrecoOuAusente, totalLinhaOuAusente } from '@/lib/format';
import { receitaLiquidaItem } from '@/lib/pedido/desconto-item';
import { resolverDescontoCupom, type LeituraDescontosItens } from './descontoCupom';

// `descontos`: o que se leu de `order_items` para ESTE pedido. Obrigatório de propósito — cada
// chamador declara (lida, falhou, não se aplica); "esqueci de ler" não pode virar cupom sem desconto.
export function buildPrintData(
  order: SalesOrderRow,
  company: CompanyFilter,
  logoUrls: Record<string, string | null> | undefined,
  descontos: LeituraDescontosItens,
): PrintOrderData {
  const isOben = company === 'oben';
  const companyMap: Record<CompanyFilter, { name: string; cnpj: string; phone: string; address: string }> = {
    oben: {
      name: 'OBEN COMÉRCIO LTDA',
      cnpj: '51.027.034/0001-00',
      phone: '(37) 9987-8190',
      address: 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
    colacor: {
      name: 'COLACOR COMERCIAL LTDA',
      cnpj: '15.422.799/0001-81',
      phone: '(37) 3222-1035',
      address: 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
    afiacao: {
      name: 'COLACOR S.C LTDA',
      cnpj: '55.555.305/0001-51',
      phone: '(37) 9987-8190',
      address: 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
  };

  const c = companyMap[company];

  // Extract parcelaCode from omie_payload
  const payload = order.omie_payload;
  const parcelaCode = payload?.cabecalho?.codigo_parcela || undefined;

  const orderNumber = order.omie_numero_pedido?.replace(/^0+/, '') || order.id.slice(0, 8).toUpperCase();
  // Desconto de item: o jsonb `items` é BRUTO e o cabeçalho, desde o #2469, LÍQUIDO. A quebra só
  // entra quando fecha com o TOTAL gravado (régua em ./descontoCupom); senão o cupom é o de sempre.
  const descontoItens = resolverDescontoCupom(order.items || [], descontos, order.total);

  return {
    companyName: c.name,
    companyCnpj: c.cnpj,
    companyPhone: c.phone,
    companyAddress: c.address,
    companyLogoUrl: logoUrls?.[company] || undefined,
    orderNumber,
    // Pedido do sync tem created_at = data-pura (meia-noite UTC, sem hora real):
    // o helper imprime só a data no dia certo; com hora real, formato inalterado.
    date: formatarDataPedido(order.created_at, 'dd/MM/yyyy HH:mm'),
    customerName: order.customer_name || 'Cliente',
    customerDocument: order.customer_document || '',
    customerPhone: order.customer_phone,
    customerAddress: order.customer_address,
    vendedorName: order.vendedor_name,
    condPagamento: order.cond_pagamento,
    parcelaCode,
    items: (order.items || []).map((it, i) => ({
      codigo: it.codigo || it.omie_codigo || '-',
      // Só texto: um campo de outro tipo lançava no escapeHtml e derrubava o LOTE inteiro (Codex).
      descricao: typeof it.descricao === 'string' && it.descricao ? it.descricao : typeof it.nome === 'string' ? it.nome : '',
      // Era `|| 1`: quantidade 0 imprimia UMA unidade, e ausente também (revisão /sales #26). Ausente
      // ou não-número → `null`, que o cupom escreve "—"; o 0 informado sai 0.
      quantidade: typeof it.quantidade === 'number' && Number.isFinite(it.quantidade) ? it.quantidade : null,
      unidade: it.unidade || 'UN',
      // O `|| 0` daqui imprimia R$ 0,00 no cupom do CLIENTE para item cujo preco o Omie
      // nao informou. `null` atravessa ate o formatador, que escreve "-".
      valorUnitario: it.valor_unitario ?? null,
      // Com a quebra de desconto, o total da linha é o LÍQUIDO pela régua do edge — `null` (sai "—")
      // quando o desconto da linha não foi apurado, nunca o bruto com cara de líquido.
      valorTotal: descontoItens.quebra
        ? receitaLiquidaItem(it.valor_unitario, it.quantidade, descontoItens.descontoPorItem[i])
        // Quantidade ausente não vira 1 na conta (`totalLinhaOuAusente` faz `?? 1`): sem ela, só o total
        // que o Omie já apurou; senão "—" (Codex, revisão /sales #26).
        : it.valor_total ?? (typeof it.quantidade === 'number' ? totalLinhaOuAusente(it.quantidade, it.valor_unitario) : null),
      ...(descontoItens.quebra ? { descontoValor: descontoItens.descontoPorItem[i] } : {}),
      tintCorId: it.tint_cor_id,
      tintNomeCor: it.tint_nome_cor,
    })),
    subtotal: order.subtotal || 0,
    desconto: order.desconto ?? null,
    frete: order.frete || 0,
    total: order.total || 0,
    observacoes: order.notes || undefined,
    isOben: isOben,
    ...(descontoItens.quebra
      ? {
          quebraDesconto: {
            subtotalBruto: descontoItens.subtotalBruto,
            descontoTotal: descontoItens.descontoTotal,
            itensApurados: descontoItens.itensApurados,
          },
        }
      : {}),
    ...(!descontoItens.quebra && descontoItens.aviso ? { avisoDesconto: `Pedido ${orderNumber}: ${descontoItens.aviso}` } : {}),
  };
}

// Build HTML for a single order page (without <html>/<body> wrappers)
export function buildSingleOrderHtml(data: PrintOrderData): string {
  // `fmt` recebia `number` e nunca via null porque o mapper acima fabricava 0. Agora ele e o
  // formatador honesto: ausente vira "-" (o zero informado segue saindo como R$ 0,00).
  const fmt = formatPrecoOuAusente;

  // Vencimentos: a definir no faturamento — mesma linha do cupom avulso (textoVencimentosDoCupom).
  const installmentText = textoVencimentosDoCupom(data);

  // Linha do item: a MESMA do cupom avulso (linhaItemCupomHtml — cor, quantidade ausente).
  const itemsRows = data.items.map((item, i) => linhaItemCupomHtml(data, item, i)).join('');

  const cnpjsComDesconto = ['03.422.099/0001-08', '07.311.465/0001-02', '24.521.946/0001-61'];
  // Com a quebra de desconto de item, a linha legada (que lê o `discount` do cabeçalho, sempre 0)
  // não entra: o "Desconto" do rodapé é um só.
  const showDesconto = !data.quebraDesconto && data.desconto !== null && data.desconto > 0 && cnpjsComDesconto.includes(data.customerDocument || '');

  const obs = data.isOben
    ? 'RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL E-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA. TRANSPORTADORA: Transporte próprio: Oben Comercio Declaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\n\nCPF/CNPJ:___________________________________ DATA DA ENTREGA:___/___/____\n\nNome/ASSINATURA:_________________________________________________' + (data.observacoes ? '\n\n' + escapeHtml(data.observacoes) : '')
    : escapeHtml(data.observacoes) || '';

  return `<div>
<div class="header">
  <div class="header-left">
    ${data.companyLogoUrl ? `<img src="${escapeHtml(data.companyLogoUrl)}" class="company-logo" crossorigin="anonymous" />` : ''}
    <div>
      <div class="company-name">${escapeHtml(data.companyName)}</div>
      <div class="company-info">CNPJ: ${escapeHtml(data.companyCnpj)} • Tel: ${escapeHtml(data.companyPhone)}</div>
      <div class="company-info">${escapeHtml(data.companyAddress)}</div>
    </div>
  </div>
  <div class="order-box">
    <div class="label">PEDIDO DE VENDA</div>
    <div class="number">Nº ${escapeHtml(data.orderNumber)}</div>
    <div class="date">${data.date}</div>
  </div>
</div>
<div class="section-title">DADOS DO CLIENTE</div>
<div style="display:flex;justify-content:space-between">
  <div>
    <div class="customer-name">${escapeHtml(data.customerName)}</div>
    <div class="customer-info">CPF/CNPJ: ${escapeHtml(data.customerDocument) || 'N/A'}${data.customerPhone ? ' • Tel: ' + escapeHtml(data.customerPhone) : ''}</div>
    ${data.customerAddress ? `<div class="customer-info" style="margin-top:4px"><strong>Endereço:</strong> ${escapeHtml(data.customerAddress)}</div>` : ''}
  </div>
  <div class="right-info">
    ${data.vendedorName ? `Vendedor: ${escapeHtml(data.vendedorName)}` : ''}
  </div>
</div>
<div class="section-title">ITENS DO PEDIDO</div>
<table><thead><tr>
  <th style="width:30px;text-align:center">#</th>
  <th style="width:70px">Código</th>
  <th>Descrição</th>
  <th style="width:40px;text-align:center">Qtd</th>
  <th style="width:35px;text-align:center">Un</th>
  <th style="width:80px;text-align:right">Vlr Unit.</th>${thDescontoHtml(data)}
  <th style="width:80px;text-align:right">Vlr Total</th>
</tr></thead><tbody>${itemsRows}</tbody></table>
<div class="totals">
  ${data.quebraDesconto ? totaisComDescontoHtml(data) : `<div class="row"><span>Subtotal:</span><span>${fmt(data.subtotal)}</span></div>`}
  ${showDesconto ? `<div class="row"><span>Desconto:</span><span>- ${fmt(data.desconto)}</span></div>` : ''}
  
  ${totalDoCupomHtml(data)}
</div>
${data.condPagamento || installmentText ? `
<div class="section-title">CONDIÇÃO DE PAGAMENTO</div>
<div style="font-size:11px;margin-bottom:4px">${data.condPagamento ? `<strong>Prazo:</strong> ${escapeHtml(data.condPagamento)}` : ''}</div>
${installmentText ? `<div style="font-size:10px;color:#333;background:#f8f8f8;padding:6px 10px;border-radius:2px;border-left:3px solid #e91e63"><strong>Vencimentos:</strong><br/>${installmentText}</div>` : ''}
` : ''}
${obs ? `<div class="section-title">OBSERVAÇÕES</div><div class="obs-box">${obs.replace(/\n/g, '<br/>')}</div>` : ''}
<div class="footer">Documento gerado automaticamente pelo sistema • ${data.date}</div>
</div>`;
}

// Build the full printable HTML document (wrappers + CSS) for a set of order pages.
export function buildPrintDocument(pages: string[], dateLabel: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Impressão de Pedidos - ${dateLabel}</title>
<style>
  @media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 1.5cm; }
    .page-break { page-break-after: always; }
  }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #ccc; padding-bottom: 12px; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .company-logo { max-height: 50px; max-width: 120px; object-fit: contain; }
  .company-name { font-size: 22px; font-weight: bold; }
  .company-info { font-size: 10px; color: #666; margin-top: 2px; }
  .order-box { background: #e91e63; color: white; border-radius: 4px; padding: 8px 20px; text-align: center; }
  .order-box .label { font-size: 9px; }
  .order-box .number { font-size: 18px; font-weight: bold; }
  .order-box .date { font-size: 9px; }
  .section-title { font-size: 11px; font-weight: bold; color: #e91e63; margin: 14px 0 6px; }
  .customer-name { font-size: 14px; font-weight: bold; }
  .customer-info { font-size: 11px; color: #333; margin-top: 2px; }
  .right-info { font-size: 11px; color: #666; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2d2d2d; color: white; padding: 6px 4px; font-size: 10px; text-align: left; }
  .totals { display: flex; flex-direction: column; align-items: flex-end; margin-top: 12px; }
  .totals .row { display: flex; gap: 30px; font-size: 12px; padding: 3px 0; }
  .totals .total-row { border-top: 2px solid #2d2d2d; font-size: 15px; font-weight: bold; padding-top: 6px; margin-top: 4px; }
  .obs-box { background: #fafafa; border: 1px solid #ccc; border-radius: 2px; padding: 10px; font-size: 10px; white-space: pre-wrap; line-height: 1.5; }
  .footer { text-align: center; font-size: 8px; color: #999; margin-top: 30px; }
</style></head><body>
${pages.join('\n<div class="page-break"></div>\n')}
<script>window.onload = function() { window.print(); }</script>
</body></html>`;
}
