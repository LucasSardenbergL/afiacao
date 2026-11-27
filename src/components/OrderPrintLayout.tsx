import { escapeHtml } from '@/lib/escape-html';
import { formatPrecoOuAusente } from '@/lib/format';
import { textoDaCor } from '@/lib/cor-tinta';

export interface PrintOrderData {
  companyName: string;
  companyCnpj: string;
  companyPhone: string;
  companyAddress: string;
  companyLogoUrl?: string;
  orderNumber: string;
  date: string;
  customerName: string;
  customerDocument: string;
  customerPhone?: string;
  customerAddress?: string;
  vendedorName?: string;
  condPagamento?: string;
  parcelaCode?: string; // e.g. "028", "028/042", "000"
  items: Array<{
    codigo: string;
    descricao: string;
    /** `null` = quantidade NÃO SABIDA: sai "—" no cupom, nunca 1 (ausente ≠ inventado). */
    quantidade: number | null;
    unidade: string;
    /** `null` = preco NAO SABIDO. Sai "-" no cupom, nunca R$ 0,00 (ausente != zero). */
    valorUnitario: number | null;
    valorTotal: number | null;
    /** Desconto da LINHA em R$ — só no cupom com quebra de desconto. `null` = não apurado: sai "—". */
    descontoValor?: number | null;
    tintCorId?: string;
    tintNomeCor?: string;
  }>;
  subtotal: number;
  /** Desconto do CABEÇALHO; `null` = não informado (não vira 0). Só aparece no cupom quando > 0. */
  desconto: number | null;
  frete: number;
  total: number;
  observacoes?: string;
  isOben?: boolean;
  /**
   * Quebra do desconto de item (`order_items.desconto_valor`). Presente SÓ quando Subtotal bruto −
   * Desconto fecha com o TOTAL em centavos: aí o cupom ganha a coluna Desconto, o `valorTotal` de cada
   * item é o LÍQUIDO da linha e o rodapé mostra Subtotal/Desconto/TOTAL. Ausente = o cupom de sempre.
   */
  quebraDesconto?: { subtotalBruto: number; descontoTotal: number; itensApurados: number };
  /** Aviso à EQUIPE, não vai ao papel: o cupom saiu sem a quebra de um desconto que existe ou que não se leu. */
  avisoDesconto?: string;
}

/**
 * Linha de "Vencimentos" do cupom — ÚNICA para as duas vias (`openPrintOrder` e `buildSingleOrderHtml`).
 *
 * Antes as duas vias inventavam o calendário: data = dia da IMPRESSÃO + os números achados no código da
 * parcela, e o total dividido igualmente. Reimprimir no dia seguinte mudava todos os vencimentos; o
 * código `S41` da Oben (28/42/56 dias) saía como "41 dias"; e o PV pode ter parcelas de valores
 * diferentes negociadas no Omie (revisão 2026-11-25 + Codex 2026-11-26). O app não guarda as parcelas
 * reais do PV — elas nascem no faturamento. Ausente ≠ inventado: o cupom diz que estão a definir, e a
 * condição comercial (`condPagamento`) continua impressa como "Prazo". À vista ou sem condição → nada.
 */
export function textoVencimentosDoCupom(data: Pick<PrintOrderData, 'parcelaCode' | 'condPagamento'>): string {
  const cond = (data.condPagamento ?? '').trim();
  const codigo = (data.parcelaCode ?? '').trim();
  if (!cond && !codigo) return '';
  if (codigo === '000' || cond === '000' || /vista/i.test(cond)) return '';
  return 'A definir no faturamento — as datas e os valores de cada parcela saem na nota fiscal e nos boletos.';
}

function buildObsText(data: PrintOrderData): string {
  const parts: string[] = [];

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

  if (data.observacoes) parts.push(escapeHtml(data.observacoes));

  return parts.join('\n\n');
}

// Ausente != zero tambem no CUPOM: item cujo preco o Omie nao informou sai "-", nao R$ 0,00.
// Um zero INFORMADO (bonificacao/brinde) segue saindo como R$ 0,00 — a distincao e o ponto.
const fmt = formatPrecoOuAusente;

// ── Desconto de item no cupom — markup ÚNICO para as duas vias ─────────────────────────────────
// `openPrintOrder` (avulso) e `buildSingleOrderHtml` (lote, em sales/print) usam estes três, para
// a coluna e o rodapé não divergirem entre elas. Sem `quebraDesconto` devolvem '' e o HTML sai o de
// sempre, byte a byte.

/** Cabeçalho da coluna Desconto. */
export function thDescontoHtml(data: PrintOrderData): string {
  return data.quebraDesconto ? '<th style="width:70px;text-align:right">Desconto</th>' : '';
}

/** Célula de desconto da linha: R$ da linha, ou "—" quando não apurado (nunca R$ 0,00). */
function tdDescontoHtml(data: PrintOrderData, item: PrintOrderData['items'][number]): string {
  if (!data.quebraDesconto) return '';
  return `<td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.descontoValor)}</td>`;
}

/** B4 (Codex P2): item sem preço (serviço a orçar) não entra na soma — rotular "TOTAL" seria
 *  afirmar um total que não existe. Ausente ≠ zero: diz quantos itens ficaram de fora. ÚNICO para as
 *  duas vias: o lote (`buildSingleOrderHtml`) imprimia "TOTAL" fixo (Codex, revisão /sales #11). */
export function totalDoCupomHtml(data: Pick<PrintOrderData, 'items' | 'total'>): string {
  const semPreco = data.items.filter(i => i.valorUnitario === null).length;
  if (semPreco === 0) return `<div class="row total-row"><span>TOTAL:</span><span>${fmt(data.total)}</span></div>`;
  return `<div class="row total-row"><span>SUBTOTAL CONHECIDO:</span><span>${fmt(data.total)}</span></div>`
    + `<div class="row"><span>Total a definir: ${semPreco} ${semPreco === 1 ? 'item' : 'itens'} sem preço</span></div>`;
}

/** Subtotal BRUTO e Desconto do rodapé; com linha não apurada, o rótulo diz quantos itens entraram. */
export function totaisComDescontoHtml(data: PrintOrderData): string {
  const q = data.quebraDesconto;
  if (!q) return '';
  const parcial = q.itensApurados < data.items.length ? ` (${q.itensApurados} de ${data.items.length} itens)` : '';
  return `<div class="row"><span>Subtotal:</span><span>${fmt(q.subtotalBruto)}</span></div>`
    + `<div class="row"><span>Desconto${parcial}:</span><span>- ${fmt(q.descontoTotal)}</span></div>`;
}

/**
 * Linha de ITEM do cupom — ÚNICA para as duas vias (`openPrintOrder` e `buildSingleOrderHtml`), que
 * antes a copiavam byte a byte (revisão /sales #53). Cor: o que se sabe dela (`textoDaCor`, #24 — antes
 * exigia id E nome, e o sync grava quase sempre só o nome). Quantidade ausente sai "—", nunca 1 (#26).
 */
export function linhaItemCupomHtml(data: PrintOrderData, item: PrintOrderData['items'][number], i: number): string {
  const descLines = [escapeHtml(item.descricao)];
  const cor = textoDaCor(item.tintCorId, item.tintNomeCor, item.descricao);
  if (cor !== null) descLines.push(`Cor: ${escapeHtml(cor)}`);
  const quantidade = item.quantidade === null ? '—' : String(item.quantidade);
  return `<tr style="background:${i % 2 === 1 ? '#f5f5f5' : '#fff'}">
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${i + 1}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${escapeHtml(item.codigo)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${descLines.join('<br/>')}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${quantidade}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${escapeHtml(item.unidade)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorUnitario)}</td>${tdDescontoHtml(data, item)}
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorTotal)}</td>
    </tr>`;
}

export function openPrintOrder(data: PrintOrderData) {
  const obs = buildObsText(data);
  const installmentText = textoVencimentosDoCupom(data);
  const itemsRows = data.items.map((item, i) => linhaItemCupomHtml(data, item, i)).join('');

  const cnpjsComDesconto = ['15.422.799/0001-81', '51.027.034/0001-00', '55.555.305/0001-51'];
  // Com a quebra de desconto de item, a linha legada (que lê o `discount` do cabeçalho, sempre 0)
  // não entra: o "Desconto" do rodapé é um só.
  const showDesconto = !data.quebraDesconto && data.desconto !== null && data.desconto > 0 && cnpjsComDesconto.includes(data.customerDocument || '');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Pedido ${escapeHtml(data.orderNumber)}</title>
<style>
  @media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 1.5cm; }
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
  .installments { font-size: 10px; color: #333; margin-top: 4px; background: #f8f8f8; padding: 6px 10px; border-radius: 2px; border-left: 3px solid #e91e63; }
</style></head><body>
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
    <div class="number">Nº ${escapeHtml(data.orderNumber.replace(/^0+/, '') || '0')}</div>
    <div class="date">${escapeHtml(data.date)}</div>
  </div>
</div>

<div class="section-title">DADOS DO CLIENTE</div>
<div style="display:flex;justify-content:space-between">
  <div>
    <div class="customer-name">${escapeHtml(data.customerName)}</div>
    <div class="customer-info">CPF/CNPJ: ${escapeHtml(data.customerDocument || 'N/A')}${data.customerPhone ? ' • Tel: ' + escapeHtml(data.customerPhone) : ''}</div>
    ${data.customerAddress ? `<div class="customer-info" style="margin-top:4px"><strong>Endereço:</strong> ${escapeHtml(data.customerAddress)}</div>` : ''}
  </div>
  <div class="right-info">
    ${data.vendedorName ? `Vendedor: ${escapeHtml(data.vendedorName)}` : ''}
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
    <th style="width:80px;text-align:right">Vlr Unit.</th>${thDescontoHtml(data)}
    <th style="width:80px;text-align:right">Vlr Total</th>
  </tr></thead>
  <tbody>${itemsRows}</tbody>
</table>

<div class="totals">
  ${totaisComDescontoHtml(data)}${showDesconto ? `<div class="row"><span>Subtotal:</span><span>${fmt(data.subtotal)}</span></div>` : ''}
  ${showDesconto ? `<div class="row"><span>Desconto:</span><span>- ${fmt(data.desconto)}</span></div>` : ''}
  
  ${totalDoCupomHtml(data)}
</div>

${data.condPagamento || installmentText ? `
<div class="section-title">CONDIÇÃO DE PAGAMENTO</div>
<div style="font-size:11px;margin-bottom:4px">${data.condPagamento ? `<strong>Prazo:</strong> ${escapeHtml(data.condPagamento)}` : ''}</div>
${installmentText ? `<div class="installments"><strong>Vencimentos:</strong><br/>${installmentText}</div>` : ''}
` : ''}

${obs ? `
<div class="section-title">OBSERVAÇÕES</div>
<div class="obs-box">${obs.replace(/\n/g, '<br/>')}</div>
` : ''}

<div class="footer">Documento gerado automaticamente pelo sistema • ${escapeHtml(data.date)}</div>
<script>window.onload = function() { window.print(); }</script>
</body></html>`;

  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
}
