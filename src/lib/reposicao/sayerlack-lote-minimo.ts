// Lote mínimo do portal Sayerlack — Fase 0 (money-path).
// Spec: docs/superpowers/specs/2026-11-18-sayerlack-lote-minimo-portal-design.md
//
// ⚠️ ESPELHO BYTE-IDÊNTICO em `supabase/functions/_shared/sayerlack-lote-minimo.ts` (o edge
// não importa de src/ — Deno). Paridade e guard de interpolação em
// `__tests__/sayerlack-lote-minimo.test.ts`. Sem imports de propósito: os dois caminhos
// relativos diferem e quebrariam a identidade de bytes. Arquivo separado de
// `sayerlack-pos-login.ts` para não mudar o bundle das outras 3 edges que importam aquele.

export interface LoteMinimoPortal {
  /** Lote mínimo de venda, em Qtd UN do portal (confirmado pelo founder, 2026-11-18). */
  lote: number;
  /** Trecho exato que casou — evidência para auditoria. */
  trecho: string;
}

export interface ContextoLoteMinimo {
  skuPortal: string | null;
  lote: number;
  qtdeEnviada: number | null;
}

/**
 * Lê a recusa "Quantidade informada menor que o lote mínimo de venda (N)" nos textos
 * vistos após o salvar-item (corpo do POST + alertas do DOM). Puro, sem I/O.
 *
 * Roda em DOIS lugares: aqui (vitest) e no Chrome remoto, interpolada via toString()
 * dentro do template literal do Browserless — por isso o corpo NÃO pode ter crase nem
 * cifrão-chave (guard no teste).
 *
 * Ausente/ilegível → null (nunca um lote fabricado): sem número > 0 não é recusa provada.
 */
export function extrairLoteMinimoPortal(textos: Array<string | null | undefined>): LoteMinimoPortal | null {
  const re = /lote\s+m[ií]nimo\s+de\s+venda\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)/i;
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i];
    if (typeof t !== 'string' || t.length === 0) continue;
    const m = re.exec(t);
    if (!m) continue;
    const lote = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(lote) || lote <= 0) continue;
    return { lote: lote, trecho: m[0] };
  }
  return null;
}

/**
 * Lado Deno: lê evidence.loteMinimo (vindo do Chrome remoto, logo NÃO confiável) e só
 * devolve o contexto se o lote for número finito > 0. Forma estranha → null (o alerta
 * sai com "nao capturado", nunca com número fabricado).
 */
export function lerLoteMinimoDaEvidencia(evidence: unknown): ContextoLoteMinimo | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const lm = (evidence as Record<string, unknown>).loteMinimo;
  if (!lm || typeof lm !== 'object') return null;
  const o = lm as Record<string, unknown>;
  const lote = typeof o.lote === 'number' ? o.lote : NaN;
  if (!Number.isFinite(lote) || lote <= 0) return null;
  const qtde = typeof o.qtdeEnviada === 'number' && Number.isFinite(o.qtdeEnviada) ? o.qtdeEnviada : null;
  const sku = typeof o.skuPortal === 'string' && o.skuPortal.length > 0 ? o.skuPortal : null;
  return { skuPortal: sku, lote: lote, qtdeEnviada: qtde };
}

/**
 * Texto do `fornecedor_alerta` para LOTE_MINIMO_PORTAL. Alerta na PRIMEIRA vez: retentar a
 * MESMA quantidade repete a recusa. É decisão de compra (comprar o lote, pedir redução ao
 * CRS ou tirar o item), não falha técnica — por isso 'atencao', não 'urgente'.
 */
export function decidirAlertaLoteMinimo(lm: ContextoLoteMinimo | null): {
  titulo: string;
  mensagem: string;
  severidade: 'urgente' | 'atencao';
} {
  const sku = lm && lm.skuPortal ? lm.skuPortal : '(SKU nao capturado)';
  const lote = lm ? String(lm.lote) : '(lote nao capturado)';
  const qtde = lm && lm.qtdeEnviada !== null ? String(lm.qtdeEnviada) : '?';
  return {
    titulo: 'Portal Sayerlack recusou item abaixo do lote minimo',
    mensagem:
      'O portal recusou o item ' + sku + ': lote minimo de venda ' + lote + ' UN, o pedido tinha ' +
      qtde + ' UN. Nenhum pedido foi colocado no fornecedor (o clique de finalizacao nunca ocorreu). ' +
      'ACAO: em /admin/reposicao/pedidos, decidir entre comprar o lote, tirar o item ou pedir ' +
      'reducao ao CRS (fluxo da spec 2026-11-18-sayerlack-lote-minimo-portal).',
    severidade: 'atencao',
  };
}
