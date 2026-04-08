import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface PrintOrderData {
  companyName: string; // "OBEN COMÉRCIO LTDA" or "COLACOR COMERCIAL LTDA"
  companyCnpj: string;
  companyPhone: string;
  companyAddress: string;
  orderNumber: string;
  date: string;
  customerName: string;
  customerDocument: string;
  customerPhone?: string;
  customerAddress?: string;
  vendedorName?: string;
  condPagamento?: string;
  items: Array<{
    codigo: string;
    descricao: string;
    quantidade: number;
    unidade: string;
    valorUnitario: number;
    valorTotal: number;
    tintCorId?: string;
    tintNomeCor?: string;
  }>;
  subtotal: number;
  desconto: number;
  frete: number;
  total: number;
  observacoes?: string;
  isOben?: boolean;
}

function buildObsText(data: PrintOrderData): string {
  // Build tint color lines
  const tintLines = data.items
    .filter(i => i.tintCorId && i.tintNomeCor)
    .map(i => {
      const corParts = i.tintNomeCor!.split(' - ');
      // Remove base info (last parts after the color name)
      const simplified = corParts.length > 2 ? corParts.slice(0, -1).join(' - ') : i.tintNomeCor!;
      return `Cor: ${i.tintCorId} - ${simplified} - Qtd: ${i.quantidade}`;
    });

  const parts: string[] = [];
  if (tintLines.length > 0) parts.push(tintLines.join('\n'));

  if (data.isOben) {
    parts.push(
      'RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL E-PTA-RE Nº: 45.000035717-51 / ' +
      'OBEN COMÉRCIO LTDA. TRANSPORTADORA: Transporte próprio: Oben Comercio ' +
      'Declaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias ' +
      'se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito ' +
      'no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por ' +
      'mim no local indicado acima.\n\n' +
      'CPF/CNPJ:___________________________________ DATA DA ENTREGA:___/___/____\n\n' +
      'Nome/ASSINATURA:_________________________________________________'
    );
  }

  if (data.observacoes) parts.push(data.observacoes);

  return parts.join('\n\n');
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function openPrintOrder(data: PrintOrderData) {
  const obs = buildObsText(data);
  const itemsRows = data.items.map((item, i) => {
    const descLines = [item.descricao];
    if (item.tintCorId && item.tintNomeCor) {
      const corParts = item.tintNomeCor.split(' - ');
      const simplified = corParts.length > 2 ? corParts.slice(0, -1).join(' - ') : item.tintNomeCor;
      descLines.push(`Cor: ${item.tintCorId} - ${simplified} - Qtd: ${item.quantidade}`);
    }
    return `
      <tr style="background:${i % 2 === 1 ? '#f5f5f5' : '#fff'}">
        <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${i + 1}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${item.codigo}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${descLines.join('<br/>')}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${item.quantidade}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${item.unidade}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorUnitario)}</td>
        <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorTotal)}</td>
      </tr>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pedido ${data.orderNumber}</title>
<style>
  @media print { @page { margin: 1.5cm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #ccc; padding-bottom: 12px; }
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
<div class="header">
  <div>
    <div class="company-name">${data.companyName}</div>
    <div class="company-info">CNPJ: ${data.companyCnpj} • Tel: ${data.companyPhone}</div>
    <div class="company-info">${data.companyAddress}</div>
  </div>
  <div class="order-box">
    <div class="label">PEDIDO DE VENDA</div>
    <div class="number">Nº ${data.orderNumber}</div>
    <div class="date">${data.date}</div>
  </div>
</div>

<div class="section-title">DADOS DO CLIENTE</div>
<div style="display:flex;justify-content:space-between">
  <div>
    <div class="customer-name">${data.customerName}</div>
    <div class="customer-info">CPF/CNPJ: ${data.customerDocument || 'N/A'}${data.customerPhone ? ' • Tel: ' + data.customerPhone : ''}</div>
    ${data.customerAddress ? `<div class="customer-info">${data.customerAddress}</div>` : ''}
  </div>
  <div class="right-info">
    ${data.vendedorName ? `Vendedor: ${data.vendedorName}<br/>` : ''}
    ${data.condPagamento ? `Cond. Pgto: ${data.condPagamento}` : ''}
  </div>
</div>

<div class="section-title">ITENS DO PEDIDO</div>
<table>
  <thead><tr>
    <th style="width:30px;text-align:center">#</th>
    <th style="width:70px">Código</th>
    <th>Descrição</th>
    <th style="width:40px;text-align:center">Qtd</th>
    <th style="width:35px;text-align:center">Un</th>
    <th style="width:80px;text-align:right">Vlr Unit.</th>
    <th style="width:80px;text-align:right">Vlr Total</th>
  </tr></thead>
  <tbody>${itemsRows}</tbody>
</table>

const cnpjsComDesconto = ['03.422.099/0001-08', '07.311.465/0001-02', '24.521.946/0001-61'];
const showDesconto = data.desconto > 0 && cnpjsComDesconto.includes(data.customerDocument || '');

return `
<div class="totals">
  <div class="row"><span>Subtotal:</span><span>${fmt(data.subtotal)}</span></div>
  ${showDesconto ? `<div class="row"><span>Desconto:</span><span>- ${fmt(data.desconto)}</span></div>` : ''}
  <div class="row"><span>Frete:</span><span>${fmt(data.frete)}</span></div>
  <div class="row total-row"><span>TOTAL:</span><span>${fmt(data.total)}</span></div>
</div>`;

${obs ? `
<div class="section-title">OBSERVAÇÕES</div>
<div class="obs-box">${obs.replace(/\n/g, '<br/>')}</div>
` : ''}

<div class="footer">Documento gerado automaticamente pelo sistema • ${data.date}</div>
<script>window.onload = function() { window.print(); }</script>
</body></html>`;

  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
}
