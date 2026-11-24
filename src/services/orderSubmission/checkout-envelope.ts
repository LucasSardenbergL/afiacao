export interface CheckoutEnvelope {
  checkoutId: string; fingerprint: string; committed: boolean;
  /** PR 2.2 (rodada 3): o nonce da cópia que DERIVOU este checkoutId (`idDoEnvio`). Ausente = envelope
   *  legado (id sorteado). Adotá-lo é como outra aba/um refresh retoma ESTE envio sem id novo. */
  nonce?: string | null;
  /** P0 do Codex no PR 2.2: o id que vai ao servidor é POR CONTA (`idsDoEnvio`) — mudar só os itens de
   *  uma conta não muda o id da outra. CONGELADO na criação. Ausente = legado: `checkoutId` em todas. */
  idsPorConta?: IdsPorConta | null;
  // Metadata da ponte CONGELADA na criação (Fase 1): nunca lida ao vivo no submit.
  customerUserId?: string | null; origem?: string | null; atendimentoId?: string | null;
  /** A1 (rodada 2): OS de Afiação já confirmada NESTE envelope. A fp só cobre PRODUTO, então o
   *  reenvio (falha parcial, "Tentar novamente" do ATP, backorder) reusaria o envelope e
   *  recriaria a OS — o Omie não deduplica. Presente = pular o bloco Afiação. */
  afiacaoOs?: MarcaOsAfiacao | null;
  /** Follow-up Codex do #4042: a edge da OS foi chamada neste envelope sem confirmação chegar
   *  (a OS pode existir no Omie). Limpa quando a marca `afiacaoOs` é gravada. */
  afiacaoPendente?: boolean;
}

/** O id de idempotência de cada pedido do checkout: `sales_orders.checkout_id` da Oben e da Colacor
 *  (`pedido_por_checkout`) e o `orderId` da OS de Afiação (edge `omie-sync`). */
export interface IdsPorConta { oben: string; colacor: string; afiacao: string }

/** O que foi confirmado da OS de Afiação: quais ferramentas/serviços (assinatura) e o nº da OS. */
export interface MarcaOsAfiacao {
  assinatura: string;
  numero: string | null;
  /** Follow-up do #4068: observação (`cObsOS`, com o horário da coleta) que FOI na OS confirmada.
   *  Fora da assinatura de propósito (mudá-la não justifica 2ª OS) — serve só para AVISAR que a OS
   *  ficou com a antiga. `null`/ausente = desconhecida (OS reconciliada, marca antiga) → não avisa. */
  observacao?: string | null;
}

/**
 * Aviso do atalho "OS já enviada" quando a observação/horário do carrinho mudou depois da OS existir:
 * o reenvio NÃO a atualiza (a assinatura idempotente não inclui `notes` — de propósito, para não
 * duplicar a OS), e o "já enviada" seco fazia a vendedora achar que o horário novo tinha ido.
 * `null` = nada a avisar (igual, ou a observação da OS é desconhecida). Vai como AVISO não-bloqueante,
 * nunca dentro de `results` (Codex P2: `results` vira o "Nº" do cupom e a linha do WhatsApp).
 */
export function avisoOsAfiacaoDesatualizada(marca: MarcaOsAfiacao, observacaoAtual: string): string | null {
  if (typeof marca.observacao !== 'string' || marca.observacao === observacaoAtual) return null;
  const os = marca.numero ? `A OS ${marca.numero}` : 'A OS de Afiação';
  return `${os} já estava no Omie e NÃO foi atualizada: o horário/observação novos não foram para ela. Ajuste direto no Omie.`;
}

/** Assinatura estável (ordem-independente) da OS de afiação: ferramenta + serviço + quantidade por
 *  item, mais forma de pagamento e entrega (vão na OS — trocar depois deixaria o comprovante
 *  diferente do Omie; Codex P1). Observação/foto não entram: mudá-las não justifica uma 2ª OS. */
export function assinaturaServicosAfiacao(
  itens: ReadonlyArray<{ userToolId: string; codigoServico: number | string | null | undefined; quantity: number; preco?: number | null }>,
  condicoes: { pagamento: string | null | undefined; entrega: string | null | undefined },
): string {
  // Preço em centavos (Codex P1 do follow-up): o atalho "já enviada" pulava a edge mesmo com o preço
  // da afiação alterado — o comprovante sairia com um valor que a OS do Omie não tem. Marca antiga
  // (sem preço) deixa de casar → afiacao_divergente: fail-closed, o vendedor confere no Omie.
  const preco = (p: number | null | undefined) => (p === null || p === undefined || !Number.isFinite(p) ? '-' : String(Math.round(p * 100)));
  const linhas = itens.map(i => `${i.userToolId}:${i.codigoServico ?? '-'}:${i.quantity}:${preco(i.preco)}`).sort().join('|');
  return `${linhas}#pg=${condicoes.pagamento ?? '-'}#ent=${condicoes.entrega ?? '-'}`;
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

/**
 * Ciclo de vida ÚNICO envelope × rascunho (follow-up Codex do #4042). O envelope só existe enquanto
 * há um envio amarrado (o sucesso TOTAL o zera); se ele sobrevive ao descarte do rascunho, o
 * próximo pedido IDÊNTICO sai como 'reuse' ("já enviado") e não é criado. Então o descarte com
 * envelope presente pede confirmação e zera os dois; sem envelope, descarta direto.
 */
export type DescarteRascunho = 'descartar' | 'confirmar';
// PR 2.2 (rodada 3): o envelope NÃO comprometido é só a identidade do rascunho (nada foi a servidor) —
// descartá-lo não perde envio nenhum, então não pede confirmação.
export function decidirDescarteRascunho(stored: CheckoutEnvelope | null): DescarteRascunho {
  return stored?.committed ? 'confirmar' : 'descartar';
}
