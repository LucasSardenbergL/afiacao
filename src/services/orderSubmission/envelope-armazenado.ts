// Onde o envelope de envio do Novo Pedido mora, e de onde vem o `checkoutId` — sem PV duplicado entre abas
// nem pedido perdido como "já enviado" (PR 2.2, rodada 3 do Novo Pedido — P0).
//
// O defeito: o envelope {checkoutId, fingerprint, committed} ficava numa chave FIXA do localStorage, sem
// dono, e o `checkoutId` era SORTEADO no clique de enviar a partir da memória da aba. Duas abas com o mesmo
// carrinho (ou um refresh que perdesse o envelope) sorteavam dois ids → dois PVs. Num computador
// compartilhado, o vendedor B herdava o envelope do vendedor A.
//
// O desenho (4ª versão — o Codex derrubou duas versões com "lápide" local e achou 6 bordas na 3ª):
//  1. O id é DERIVADO, não sorteado: `idDoEnvio(nonce, itens)`. O `nonce` nasce com o RASCUNHO (1º item no
//     carrinho), viaja no rascunho em disco e é o que duas abas/um refresh compartilham ao restaurar.
//     Mesma cópia + mesmo carrinho ⇒ MESMO id ⇒ o servidor responde "já enviado" (`sales_orders.checkout_id`
//     + conta; OS por `cCodIntOS`). Carrinho diferente ⇒ id diferente ⇒ pedido novo — nunca um pedido
//     legítimo é engolido como "já enviado". A "lápide" é o próprio servidor.
//  2. O envelope COMPROMETIDO (um envio saiu) é gravado na chave do par (usuário, cliente NO NASCIMENTO do
//     nonce — a chave viaja no rascunho; nada é movido de chave). Para DECIDIR, o envio lê TODAS as chaves
//     do cliente (usuário local, Oben, Colacor) e a chave legada de antes do PR 2.2 cujo prefixo casa com
//     ele: qualquer envio pendente do cliente trava o carrinho. Leitura ILEGÍVEL é `indeterminado` e barra
//     o envio — só ausência comprovada libera.
//  3. Envio pendente do MESMO carrinho feito por OUTRA cópia: quem decide é o vendedor ("É o mesmo pedido"
//     adota o nonce do pendente; "É outro pedido" segue com o id desta cópia, `ignorarPendente`).
//  4. O nonce gira no fim do ciclo (sucesso total, descarte, troca de cliente, "Novo pedido"): o próximo
//     pedido idêntico é NOVO.
//
// Migração para o servidor (Onda 3, rascunhos no servidor): o `nonce` vira o id da linha do rascunho e o
// envelope comprometido vira o estado "enviado" dela; `idDoEnvio` não muda. `ArmazemEnvelope` é a costura.
import type { CheckoutEnvelope } from './checkout-envelope';

/** Subconjunto do `Storage` que o envelope usa — injetável nos testes (duas "abas" num armazém só). */
export interface ArmazemEnvelope {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

const PREFIXO_ENVELOPE = 'unified_order_checkout_env:v2:';
/** Nonce que carrega um checkoutId LITERAL (envio de outra cópia sem nonce — o legado) PRESO aos itens:
 *  `id:<checkoutId>:<assinatura dos itens>`. Com outros itens, não vale o literal (Codex P0, rodada 4). */
const PREFIXO_NONCE_LITERAL = 'id:';

/** A chave fixa de antes (sem dono). Nunca migrada: lida como pendente do cliente cujo prefixo casa. */
export const CHAVE_ENVELOPE_LEGADA = 'unified_order_checkout_env';

/** Itens da impressão digital SEM o prefixo do cliente (`<cliente>#<itens>`): o prefixo muda quando o
 *  cliente ganha usuário local, e isso não pode virar "outro carrinho" (Codex P1). */
export function assinaturaItens(fingerprint: string): string {
  const i = fingerprint.indexOf('#');
  return i < 0 ? fingerprint : fingerprint.slice(i + 1);
}

/** O nonce que retoma o envio `e` nesta cópia: o dele, ou o id literal PRESO aos itens dele (legado). */
export function nonceParaAssumir(e: CheckoutEnvelope): string {
  return e.nonce || `${PREFIXO_NONCE_LITERAL}${e.checkoutId}:${assinaturaItens(e.fingerprint)}`;
}

export interface IdentidadeCliente {
  local_user_id?: string | null;
  codigo_cliente?: number | string | null;
  codigo_cliente_colacor?: number | string | null;
}

// Código Omie 0 não identifica ninguém (cliente sem cadastro naquela conta) — Codex P1.
const idDe = (x: unknown) => (x == null || x === '' || x === 0 || x === '0' ? null : String(x));

/** Chave do cliente no armazém — a identidade MAIS ESTÁVEL primeiro (usuário local, Oben, Colacor). */
export function chaveClienteEnvelope(c: IdentidadeCliente | null | undefined): string | null {
  if (!c) return null;
  const l = idDe(c.local_user_id); if (l) return `local:${l}`;
  const o = idDe(c.codigo_cliente); if (o) return `oben:${o}`;
  const k = idDe(c.codigo_cliente_colacor); if (k) return `colacor:${k}`;
  return null;
}

/** TODAS as chaves-de-cliente deste cliente (cada identidade não-vazia). O envio lê todas: a chave em que
 *  outra cópia gravou depende de quais códigos o cliente tinha quando o nonce DELA nasceu. */
export function chavesClienteEnvelope(c: IdentidadeCliente | null | undefined): string[] {
  if (!c) return [];
  const r: string[] = [];
  const l = idDe(c.local_user_id); if (l) r.push(`local:${l}`);
  const o = idDe(c.codigo_cliente); if (o) r.push(`oben:${o}`);
  const k = idDe(c.codigo_cliente_colacor); if (k) r.push(`colacor:${k}`);
  return r;
}

/** Prefixos da fingerprint LEGADA (`customerKey` de antes: usuário local, senão código Oben) que este
 *  cliente pode ter tido — os dois, porque o cliente pode ter ganhado o usuário local depois (Codex P0). */
export function prefixosLegadoDoCliente(c: IdentidadeCliente | null | undefined): string[] {
  if (!c) return [];
  return [idDe(c.local_user_id), idDe(c.codigo_cliente)].filter((x): x is string => x !== null);
}

export function chaveEnvelope(userId: string, chaveCliente: string): string {
  return `${PREFIXO_ENVELOPE}${userId}:${chaveCliente}`;
}

/**
 * O MESMO cliente com mais um código (o autocadastro trouxe o Colacor, o app ganhou o usuário local)
 * compartilha ao menos uma identidade não-vazia; cliente trocado não compartilha nenhuma.
 */
export function mesmoCliente(a: IdentidadeCliente | null | undefined, b: IdentidadeCliente | null | undefined): boolean {
  if (!a || !b) return false;
  const iguais = (x: unknown, y: unknown) => idDe(x) !== null && idDe(x) === idDe(y);
  return iguais(a.local_user_id, b.local_user_id) || iguais(a.codigo_cliente, b.codigo_cliente)
    || iguais(a.codigo_cliente_colacor, b.codigo_cliente_colacor);
}

async function hashUuid(texto: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80; // versão 8 (RFC 9562: formato livre)
  h[8] = (h[8] & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * O `checkoutId` do envio: SHA-256 de (nonce do rascunho, itens) no formato UUID (o banco guarda `uuid`).
 * Determinístico — a mesma cópia do pedido com o mesmo carrinho dá sempre o mesmo id, em qualquer aba.
 * Nonce LITERAL (`id:<id>:<assinatura>`): o id literal só com OS MESMOS itens; com outros, o nonce é um
 * nonce como outro qualquer e deriva um id novo (outra quantidade = outro pedido, nunca "já enviado").
 */
export async function idDoEnvio(nonce: string, fingerprint: string): Promise<string> {
  if (!nonce) throw new Error('idDoEnvio: nonce vazio');
  const itens = assinaturaItens(fingerprint);
  if (nonce.startsWith(PREFIXO_NONCE_LITERAL)) {
    const resto = nonce.slice(PREFIXO_NONCE_LITERAL.length);
    const sep = resto.indexOf(':');
    if (sep > 0 && resto.slice(sep + 1) === itens) return resto.slice(0, sep);
  }
  return hashUuid(`checkout-v1|${nonce}|${itens}`);
}

function valido(x: unknown): x is CheckoutEnvelope {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return typeof e.checkoutId === 'string' && e.checkoutId.length > 0
    && typeof e.fingerprint === 'string' && typeof e.committed === 'boolean';
}

export type LeituraEnvelope =
  | { estado: 'ausente' }
  | { estado: 'presente'; envelope: CheckoutEnvelope }
  | { estado: 'ilegivel' };

/** Ausência COMPROVADA ≠ falha de leitura (Codex P0): só `ausente` autoriza um envio sem trava. */
export function lerEnvelopeEstrito(arm: ArmazemEnvelope, chave: string): LeituraEnvelope {
  let r: string | null;
  try { r = arm.getItem(chave); } catch { return { estado: 'ilegivel' }; }
  if (r === null) return { estado: 'ausente' };
  try {
    const e: unknown = JSON.parse(r);
    return valido(e) ? { estado: 'presente', envelope: e } : { estado: 'ilegivel' };
  } catch { return { estado: 'ilegivel' }; }
}

/** true = gravado (ou removido). false = o armazém recusou (quota/privado) — quem chama NÃO envia. */
function gravarEnvelope(arm: ArmazemEnvelope, chave: string, e: CheckoutEnvelope | null): boolean {
  try {
    if (e) arm.setItem(chave, JSON.stringify(e)); else arm.removeItem(chave);
    return true;
  } catch { return false; }
}

/** Grava SÓ se o que está guardado ainda é o envelope `idEsperado` — nunca atropela o de outra aba. */
export function gravarSeAindaFor(arm: ArmazemEnvelope, chave: string, idEsperado: string, e: CheckoutEnvelope | null): boolean {
  const l = lerEnvelopeEstrito(arm, chave);
  if (l.estado !== 'presente' || l.envelope.checkoutId !== idEsperado) return false;
  return gravarEnvelope(arm, chave, e);
}

/** Onde procurar envio pendente de um cliente: as chaves dele (a de gravação PRIMEIRO) + o legado. */
export interface AlvoPendente {
  /** Chaves completas (`chaveEnvelope`) do cliente; a 1ª é a de gravação desta cópia. */
  chaves: string[];
  /** `prefixosLegadoDoCliente` — o legado só conta se a fingerprint dele começar por um destes. */
  prefixosLegado: string[];
}

export interface Pendente { chave: string; envelope: CheckoutEnvelope }

type LeituraPendentes = { estado: 'ilegivel' } | { estado: 'ok'; pendentes: Pendente[] };

/** Todo envio COMPROMETIDO deste cliente, em qualquer chave dele ou no legado. Ilegível em qualquer uma →
 *  `ilegivel` (nunca "não há pendente"). O legado ilegível também barra: não dá para saber de quem é. */
function lerPendentesDoCliente(arm: ArmazemEnvelope, alvo: AlvoPendente): LeituraPendentes {
  const pendentes: Pendente[] = [];
  for (const chave of Array.from(new Set(alvo.chaves))) {
    const l = lerEnvelopeEstrito(arm, chave);
    if (l.estado === 'ilegivel') return { estado: 'ilegivel' };
    if (l.estado === 'presente' && l.envelope.committed) pendentes.push({ chave, envelope: l.envelope });
  }
  const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
  if (leg.estado === 'ilegivel') return { estado: 'ilegivel' };
  if (leg.estado === 'presente' && leg.envelope.committed
    && alvo.prefixosLegado.some(px => px && leg.envelope.fingerprint.startsWith(`${px}#`))) {
    pendentes.push({ chave: CHAVE_ENVELOPE_LEGADA, envelope: leg.envelope });
  }
  return { estado: 'ok', pendentes };
}

/** Para EXIBIR e para os guards (orçamento, "novo pedido", diálogo de descarte): o 1º envio pendente do
 *  cliente, `undefined` se a leitura falhou (quem chama trata como pendente — fail-closed). */
export function pendenteDoCliente(arm: ArmazemEnvelope, alvo: AlvoPendente): Pendente | null | undefined {
  const l = lerPendentesDoCliente(arm, alvo);
  return l.estado === 'ilegivel' ? undefined : (l.pendentes[0] ?? null);
}

export type ReservaEnvio =
  | { decisao: 'conflict'; envelope: CheckoutEnvelope }
  /** Envio pendente do MESMO carrinho feito por OUTRA cópia (outra aba, rascunho perdido, legado). Pode ser
   *  o mesmo pedido OU um pedido novo idêntico — a máquina não distingue, o VENDEDOR decide (Codex P0 ×2:
   *  reusar sozinho engolia o pedido novo; ignorar duplicava o mesmo). */
  | { decisao: 'outra_copia'; pendente: Pendente }
  | { decisao: 'indeterminado' }
  | { decisao: 'new' | 'reuse'; envelope: CheckoutEnvelope; gravou: boolean };

export interface PedidoDeReserva extends AlvoPendente {
  fingerprint: string;
  /** `idDoEnvio(nonce, fingerprint)` — calculado antes da trava (é assíncrono). */
  idCalculado: string;
  /** checkoutId do pendente que o VENDEDOR disse ser OUTRO pedido ("É outro pedido") — só ele é ignorado. */
  ignorarPendente?: string | null;
}

/**
 * A reserva do envio, sob `comTravaEntreAbas`: lê as chaves do cliente (não a memória da aba), decide e
 * grava o envelope COMPROMETIDO na chave de gravação (`chaves[0]`). `criar(id)` monta o envelope novo com a
 * metadata da ponte (e o nonce).
 *  - alguma chave ilegível → `indeterminado`
 *  - envio pendente com o MESMO id (esta cópia, mesmo carrinho) → `reuse` (o servidor diz "já enviado")
 *  - envio pendente de OUTRO carrinho → `conflict` (a conta já enviada não sai de novo)
 *  - envio pendente do MESMO carrinho com OUTRO id (não ignorado) → `outra_copia`
 *  - senão → `new` com o id calculado.
 */
export function reservarEnvio(arm: ArmazemEnvelope, p: PedidoDeReserva, criar: (id: string) => CheckoutEnvelope): ReservaEnvio {
  const chave = p.chaves[0];
  if (!chave) return { decisao: 'indeterminado' };
  const l = lerPendentesDoCliente(arm, p);
  if (l.estado === 'ilegivel') return { decisao: 'indeterminado' };
  const itens = assinaturaItens(p.fingerprint);
  // O retry do PRÓPRIO envio vem primeiro: mesmo id = o servidor deduplica, nunca é 2º PV — e um pendente
  // de outro carrinho (o legado, outra cópia) não pode travar o retry de um parcial desta cópia.
  const meu = l.pendentes.find(x => x.envelope.checkoutId === p.idCalculado);
  if (meu) {
    const envelope = { ...meu.envelope, fingerprint: p.fingerprint, committed: true };
    return { decisao: 'reuse', envelope, gravou: gravarEnvelope(arm, chave, envelope) };
  }
  const outroCarrinho = l.pendentes.find(x => assinaturaItens(x.envelope.fingerprint) !== itens);
  if (outroCarrinho) return { decisao: 'conflict', envelope: outroCarrinho.envelope };
  const outra = l.pendentes.find(x => x.envelope.checkoutId !== p.ignorarPendente);
  if (outra) return { decisao: 'outra_copia', pendente: outra };
  const envelope = { ...criar(p.idCalculado), checkoutId: p.idCalculado, fingerprint: p.fingerprint, committed: true };
  return { decisao: 'new', envelope, gravou: gravarEnvelope(arm, chave, envelope) };
}

/** Sucesso TOTAL: solta o envelope deste envio em TODA chave do cliente e no legado. false = alguma remoção
 *  falhou (o que sobra tem este id; um pedido novo idêntico tem outro → `outra_copia`, nunca calado). */
export function concluirEnvio(arm: ArmazemEnvelope, chaves: string[], checkoutId: string): boolean {
  let ok = true;
  for (const chave of Array.from(new Set([...chaves, CHAVE_ENVELOPE_LEGADA]))) {
    const l = lerEnvelopeEstrito(arm, chave);
    if (l.estado === 'presente' && l.envelope.checkoutId === checkoutId) ok = gravarEnvelope(arm, chave, null) && ok;
    else if (l.estado === 'ilegivel' && chave === chaves[0]) ok = false;
  }
  return ok;
}

/** "Trocar e limpar" com leitura ilegível: a chave ilegível não é de ninguém que se possa ler — o vendedor
 *  pediu explicitamente para recomeçar, então ela sai (senão o cliente ficaria travado para sempre). */
export function limparIlegiveis(arm: ArmazemEnvelope, alvo: AlvoPendente): void {
  for (const chave of Array.from(new Set([...alvo.chaves, CHAVE_ENVELOPE_LEGADA]))) {
    if (lerEnvelopeEstrito(arm, chave).estado === 'ilegivel') gravarEnvelope(arm, chave, null);
  }
}

interface TravasWeb {
  request<T>(nome: string, opcoes: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Seção crítica entre ABAS da mesma origem (Web Locks — Chrome 69+, Safari 15.4+). Sem a API, roda direto:
 * resta a janela de um getItem→setItem síncrono; o id derivado segue impedindo o PV duplicado do mesmo
 * carrinho (o servidor deduplica pelo id), então o que sobra é só a trava de edição pós-parcial.
 */
export async function comTravaEntreAbas<T>(
  nome: string,
  fn: () => T,
  travas: TravasWeb | undefined = (typeof navigator !== 'undefined'
    ? (navigator as unknown as { locks?: TravasWeb }).locks
    : undefined),
): Promise<T> {
  if (!travas || typeof travas.request !== 'function') return fn();
  return travas.request(nome, { mode: 'exclusive' }, fn);
}

/** Uma trava por USUÁRIO (não por chave de cliente): as chaves de um mesmo cliente podem ser várias. */
export function nomeDaTrava(userId: string): string {
  return `checkout:${userId}`;
}

/** O que a OUTRA aba fez com o envelope deste par, visto por um evento `storage`. */
export type MudancaOutraAba = 'enviou' | 'liberou' | null;

export function classificarMudancaOutraAba(novoValor: string | null, meuCheckoutId: string | null): MudancaOutraAba {
  if (novoValor === null) return meuCheckoutId ? 'liberou' : null;
  let e: unknown;
  try { e = JSON.parse(novoValor); } catch { return null; }
  if (!valido(e)) return null;
  return e.committed ? 'enviou' : null;
}

/**
 * A pergunta "é o mesmo pedido?" fica PENDENTE NA ABA até o vendedor responder (Codex P0, rodada 4: sem
 * isso, o clique seguinte sem escolha caía em `new` assim que o pendente sumisse). Vale enquanto o
 * contexto em que foi feita (cliente, nonce desta cópia, itens) for o mesmo; mudou → a pergunta caducou.
 */
export interface PerguntaOutraCopia {
  pendente: Pendente;
  cliente: IdentidadeCliente | null;
  nonce: string;
  assinatura: string;
}

export function perguntaAindaVale(
  q: PerguntaOutraCopia | null,
  agora: { cliente: IdentidadeCliente | null; nonce: string | null; fingerprint: string },
): boolean {
  return !!q && !!agora.nonce && q.nonce === agora.nonce
    && mesmoCliente(q.cliente, agora.cliente) && q.assinatura === assinaturaItens(agora.fingerprint);
}

/** O cliente-da-chave (`oben:123`) de uma chave completa deste usuário; o legado → null. */
export function chaveClienteDaChave(chave: string, userId: string): string | null {
  const px = `${PREFIXO_ENVELOPE}${userId}:`;
  return chave.startsWith(px) ? chave.slice(px.length) : null;
}
