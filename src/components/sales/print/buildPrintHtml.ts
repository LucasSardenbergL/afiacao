// Geração pura de HTML para impressão de pedidos.
// Extraído de src/pages/SalesPrintDashboard.tsx (god-component split).
import { addDays } from 'date-fns';
import { formatarDataPedido } from '@/lib/pedido/data-pedido';
import { escapeHtml } from '@/lib/escape-html';
import { type PrintOrderData } from '@/components/OrderPrintLayout';
import type { CompanyFilter, SalesOrderRow } from './types';

export function buildPrintData(order: SalesOrderRow, company: CompanyFilter, logoUrls?: Record<string, string | null>): PrintOrderData {
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

  return {
    companyName: c.name,
    companyCnpj: c.cnpj,
    companyPhone: c.phone,
    companyAddress: c.address,
    companyLogoUrl: logoUrls?.[company] || undefined,
    orderNumber: order.omie_numero_pedido?.replace(/^0+/, '') || order.id.slice(0, 8).toUpperCase(),
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
    items: (order.items || []).map((it) => ({
      codigo: it.codigo || it.omie_codigo || '-',
      descricao: it.descricao || it.nome || '',
      quantidade: it.quantidade || 1,
      unidade: it.unidade || 'UN',
      valorUnitario: it.valor_unitario || 0,
      valorTotal: it.valor_total || 0,
      tintCorId: it.tint_cor_id,
      tintNomeCor: it.tint_nome_cor,
    })),
    subtotal: order.subtotal || 0,
    desconto: order.desconto || 0,
    frete: order.frete || 0,
    total: order.total || 0,
    observacoes: order.notes || undefined,
    isOben: isOben,
  };
}

// Build HTML for a single order page (without <html>/<body> wrappers)
export function buildSingleOrderHtml(data: PrintOrderData): string {
  const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Build installment dates
  const parseParcelaDays = (codeOrDesc?: string): number[] => {
    if (!codeOrDesc) return [];
    const clean = codeOrDesc.trim();
    if (clean === '000' || clean === '999' || /vista/i.test(clean)) return [];
    // Extract all numeric groups — handles codes like "S37", "A28", "028/042", "28/42 DDL"
    const matches = clean.match(/(\d{1,3})/g);
    if (!matches) return [];
    return matches.map(s => parseInt(s, 10)).filter(n => n > 0 && n <= 365);
  };

  let days = parseParcelaDays(data.condPagamento);
  if (days.length === 0) days = parseParcelaDays(data.parcelaCode);
  let installmentText = '';
  if (days.length > 0) {
    const today = new Date();
    const parcValue = data.total && days.length > 0 ? data.total / days.length : 0;
    installmentText = days.map((d, i) => {
      const dueDate = addDays(today, d);
      const dateStr = `${String(dueDate.getDate()).padStart(2, '0')}/${String(dueDate.getMonth() + 1).padStart(2, '0')}/${dueDate.getFullYear()}`;
      const valStr = parcValue > 0 ? ` – ${fmt(parcValue)}` : '';
      return `${i + 1}ª parcela: ${dateStr}${valStr}`;
    }).join(' | ');
  }

  const itemsRows = data.items.map((item, i) => {
    const descLines = [escapeHtml(item.descricao)];
    if (item.tintCorId && item.tintNomeCor) {
      const corParts = item.tintNomeCor.split(' - ');
      const simplified = corParts.length > 2 ? corParts.slice(0, -1).join(' - ') : item.tintNomeCor;
      const embMatch = item.descricao.match(/\b(QT|GL|LT|BD|BH|5L)\b/i);
      const embalagem = embMatch ? embMatch[1].toUpperCase() : '';
      descLines.push(`Cor: ${escapeHtml(item.tintCorId)} - ${escapeHtml(simplified)}${embalagem ? ' - ' + escapeHtml(embalagem) : ''}`);
    }
    return `<tr style="background:${i % 2 === 1 ? '#f5f5f5' : '#fff'}">
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${i + 1}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${escapeHtml(item.codigo)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${descLines.join('<br/>')}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${item.quantidade}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${escapeHtml(item.unidade)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorUnitario)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorTotal)}</td>
    </tr>`;
  }).join('');

  const cnpjsComDesconto = ['03.422.099/0001-08', '07.311.465/0001-02', '24.521.946/0001-61'];
  const showDesconto = data.desconto > 0 && cnpjsComDesconto.includes(data.customerDocument || '');

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
  <th style="width:80px;text-align:right">Vlr Unit.</th>
  <th style="width:80px;text-align:right">Vlr Total</th>
</tr></thead><tbody>${itemsRows}</tbody></table>
<div class="totals">
  <div class="row"><span>Subtotal:</span><span>${fmt(data.subtotal)}</span></div>
  ${showDesconto ? `<div class="row"><span>Desconto:</span><span>- ${fmt(data.desconto)}</span></div>` : ''}
  
  <div class="row total-row"><span>TOTAL:</span><span>${fmt(data.total)}</span></div>
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
