export interface CheckoutEnvelope {
  checkoutId: string; fingerprint: string; committed: boolean;
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

/** Identidade do cliente no momento do envio — o que entra na chave do fingerprint. */
export interface IdentidadeClienteCheckout {
  /** Usuário local CONFIRMADO do cliente (8.2: o staff só envia com ele). */
  customerUserId: string | null | undefined;
  /** Vínculo vindo da linha da busca (mapa em lote) — pode faltar numa seleção e vir na outra. */
  localUserId: string | null | undefined;
  /** Código Omie (Oben) do cliente selecionado; 0 = não identifica ninguém. */
  codigoCliente: number | null | undefined;
}

const textoOuNulo = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const codigoOuNulo = (c: number | null | undefined): string | null =>
  (typeof c === 'number' && Number.isSafeInteger(c) && c > 0 ? String(c) : null);

/**
 * Chaves do cliente no fingerprint (Codex r5 do #4236, defeito 2). A chave antiga era
 * `local_user_id || codigo_cliente`: na 1ª seleção o mapa em lote podia não trazer o vínculo (o id
 * vinha depois, por mapa/documento → chave = código); numa nova seleção o mapa trazia → chave = UUID.
 * Mesmo cliente, mesmos itens → `conflict`, cuja saída (limpar o cliente) perde a proteção do 2º PV.
 *
 *  - `canonica`: a do envelope NOVO — o usuário CONFIRMADO (estável entre seleções); sem ele, a regra
 *    antiga (autoatendimento/legado).
 *  - `aliases`: as outras formas com que um envelope JÁ persistido pode ter sido gravado para ESTE
 *    cliente — o código Oben (> 0) e o `local_user_id` só quando ele É o confirmado (um vínculo
 *    divergente do confirmado não é prova de ser o mesmo cliente → não vira alias).
 * UUID e inteiro positivo não colidem entre si; código 0 nunca entra (não identifica ninguém).
 */
export function chavesClienteCheckout(id: IdentidadeClienteCheckout): { canonica: string; aliases: string[] } {
  const confirmado = textoOuNulo(id.customerUserId);
  const vinculo = textoOuNulo(id.localUserId);
  const codigo = codigoOuNulo(id.codigoCliente);
  const canonica = confirmado ?? vinculo ?? codigo ?? '';
  const aliases = [vinculo === confirmado ? vinculo : null, codigo].filter(
    (k): k is string => k !== null && k !== canonica,
  );
  return { canonica, aliases: [...new Set(aliases)] };
}

/** A parte dos ITENS da fp (`<chave>#<itens>`): chave é UUID ou inteiro, nunca contém `#`. */
const itensDaFingerprint = (fp: string): string | null => {
  const i = fp.indexOf('#');
  return i < 0 ? null : fp.slice(i + 1);
};

/**
 * Decide o envelope pelo cliente (chave estável + formato antigo). Devolve a decisão e a fp a gravar
 * num envelope NOVO (sempre a canônica). Ordem, toda fail-closed (na dúvida cai na regra de sempre:
 * `conflict` se committed — nunca reusa o checkoutId de outro cliente):
 *  1. o envelope congelou OUTRO usuário (`customerUserId` da criação ≠ o confirmado agora) → nunca
 *     reusa, nem por fp igual (Codex r1 do #4271: a chave antiga e o titular eram campos distintos);
 *  2. mesma fp canônica → reuse;
 *  3. o envelope congelou ESTE usuário e os itens batem → reuse, qualquer que seja a chave antiga (o
 *     código Oben pode faltar na seleção de agora — cliente reaberto pelo 360, PV só da Colacor);
 *  4. envelope sem usuário congelado (legado) → reuse só por alias (código Oben > 0 / vínculo igual).
 */
export function decidirEnvelopeDoCliente(
  stored: CheckoutEnvelope | null,
  id: IdentidadeClienteCheckout,
  items: Parameters<typeof computeCheckoutFingerprint>[1],
): { decision: CheckoutDecision; fingerprint: string } {
  const { canonica, aliases } = chavesClienteCheckout(id);
  const fingerprint = computeCheckoutFingerprint(canonica, items);
  if (!stored) return { decision: 'new', fingerprint };
  const semReuso: CheckoutDecision = stored.committed ? 'conflict' : 'new';
  const congelado = textoOuNulo(stored.customerUserId ?? null);
  const atual = textoOuNulo(id.customerUserId);
  if (congelado !== null && congelado !== atual) return { decision: semReuso, fingerprint };
  if (stored.fingerprint === fingerprint) return { decision: 'reuse', fingerprint };
  if (congelado !== null) {
    const mesmosItens = itensDaFingerprint(stored.fingerprint) === itensDaFingerprint(fingerprint);
    return { decision: mesmosItens ? 'reuse' : semReuso, fingerprint };
  }
  if (aliases.some(k => computeCheckoutFingerprint(k, items) === stored.fingerprint)) {
    return { decision: 'reuse', fingerprint };
  }
  return { decision: semReuso, fingerprint };
}

/**
 * Ciclo de vida ÚNICO envelope × rascunho (follow-up Codex do #4042). O envelope só existe enquanto
 * há um envio amarrado (o sucesso TOTAL o zera); se ele sobrevive ao descarte do rascunho, o
 * próximo pedido IDÊNTICO sai como 'reuse' ("já enviado") e não é criado. Então o descarte com
 * envelope presente pede confirmação e zera os dois; sem envelope, descarta direto.
 */
export type DescarteRascunho = 'descartar' | 'confirmar';
export function decidirDescarteRascunho(stored: CheckoutEnvelope | null): DescarteRascunho {
  return stored ? 'confirmar' : 'descartar';
}
