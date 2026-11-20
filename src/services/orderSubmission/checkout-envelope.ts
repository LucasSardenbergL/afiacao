export interface CheckoutEnvelope {
  checkoutId: string; fingerprint: string; committed: boolean;
  // Metadata da ponte CONGELADA na criação (Fase 1): nunca lida ao vivo no submit.
  customerUserId?: string | null; origem?: string | null; atendimentoId?: string | null;
  /** A1 (rodada 2): OS de Afiação já confirmada NESTE envelope. A fp só cobre PRODUTO, então o
   *  reenvio (falha parcial, "Tentar novamente" do ATP, backorder) reusaria o envelope e
   *  recriaria a OS — o Omie não deduplica. Presente = pular o bloco Afiação. */
  afiacaoOs?: MarcaOsAfiacao | null;
}

/** O que foi confirmado da OS de Afiação: quais ferramentas/serviços (assinatura) e o nº da OS. */
export interface MarcaOsAfiacao {
  assinatura: string;
  numero: string | null;
}

/** Assinatura estável (ordem-independente) dos serviços de afiação: ferramenta + serviço + quantidade.
 *  Observação/foto não entram: mudá-las não justifica uma 2ª OS. */
export function assinaturaServicosAfiacao(
  itens: ReadonlyArray<{ userToolId: string; codigoServico: number | string | null | undefined; quantity: number }>,
): string {
  return itens.map(i => `${i.userToolId}:${i.codigoServico ?? '-'}:${i.quantity}`).sort().join('|');
}
export type CheckoutDecision = 'reuse' | 'new' | 'conflict';

/** Impressão digital estável do pedido de PRODUTO (cliente + itens oben/colacor). Ordem-independente.
 *  unit_price é normalizado com toFixed(2) para evitar falso conflito por ruído de representação float
 *  (ex.: 30.5 vs 30.500000001). Mudança REAL de preço em centavos ainda muda a fp. */
export function computeCheckoutFingerprint(
  customerKey: string,
  items: ReadonlyArray<{ account: string; omie_codigo_produto: number | string; quantity: number; unit_price: number }>,
): string {
  const sig = items.map(i => `${i.account}:${i.omie_codigo_produto}:${i.quantity}:${i.unit_price.toFixed(2)}`).sort().join('|');
  return `${customerKey}#${sig}`;
}

/**
 * Decide o que fazer com o envelope persistido dada a impressão digital atual:
 *  - sem envelope                       → 'new'
 *  - mesma fp                           → 'reuse'    (retry do MESMO pedido — com ou sem commit)
 *  - fp diferente E ainda não committed → 'new'      (mudou o pedido antes de qualquer envio)
 *  - fp diferente E já committed        → 'conflict' (há um envio pendente de OUTRO carrinho;
 *                                                      não criar em silêncio → avisar)
 */
export function decideCheckoutEnvelope(stored: CheckoutEnvelope | null, fingerprint: string): CheckoutDecision {
  if (!stored) return 'new';
  if (stored.fingerprint === fingerprint) return 'reuse';
  if (stored.committed) return 'conflict';
  return 'new';
}
