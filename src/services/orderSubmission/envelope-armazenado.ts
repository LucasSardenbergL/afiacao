// Onde o envelope de envio do Novo Pedido mora, e de onde vem o `checkoutId` — sem PV duplicado entre abas
// nem envelope herdado de outro vendedor (PR 2.2, rodada 3 do Novo Pedido — P0).
//
// O defeito: o envelope {checkoutId, fingerprint, committed} ficava numa chave FIXA do localStorage, sem
// dono, lido UMA vez na montagem da aba, e o `checkoutId` era SORTEADO no clique de enviar. Duas abas com
// o mesmo carrinho sorteavam dois ids → dois PVs. Num computador compartilhado, o vendedor B herdava o
// envelope (e o "conflito") do vendedor A.
//
// O NÚCLEO (5ª versão — decisão do founder após a 5ª rodada do Codex não convergir: a pergunta "é o mesmo
// pedido?", as chaves por cliente e a adoção do legado foram para a Onda 3, rascunho no servidor):
//  1. Uma chave por USUÁRIO (`chaveEnvelope`), com a MESMA regra da main: carrinho igual a um envio
//     pendente → reusa o id dele (o servidor responde "já enviado"); carrinho diferente com envio pendente
//     → conflito (a conta já enviada não sai de novo). Só que a decisão LÊ O ARMAZÉM sob uma trava entre
//     abas (`comTravaEntreAbas`), não a memória da aba — a 2ª aba vê o commit da 1ª.
//  2. Envelope novo: o id é DERIVADO (`idDoEnvio(nonce, itens)`), não sorteado. O `nonce` nasce com o
//     rascunho e viaja nele: um envelope perdido (refresh com o armazém limpo, outra aba que restaurou o
//     rascunho) com o mesmo carrinho deriva o MESMO id → o servidor deduplica. O nonce gira no fim do
//     ciclo (sucesso total, descarte, troca de cliente, "Novo pedido").
//  3. A chave fixa de antes (`CHAVE_ENVELOPE_LEGADA`) é lida como envio pendente SÓ do cliente cujo
//     prefixo da impressão digital casa — nunca migrada; sai quando o envio dela conclui ou no "Trocar e
//     limpar" desse cliente. Ilegível no legado = ausente (como a main lia).
//  4. A chave do usuário ILEGÍVEL barra o envio (`indeterminado`) — só ausência comprovada libera; o
//     "Trocar e limpar" a apaga.
//
// Migração para o servidor (Onda 3): o `nonce` vira o id da linha do rascunho e o envelope comprometido
// vira o estado "enviado" dela; `idDoEnvio` não muda. `ArmazemEnvelope` é a costura.
import type { CheckoutEnvelope } from './checkout-envelope';

/** Subconjunto do `Storage` que o envelope usa — injetável nos testes (duas "abas" num armazém só). */
export interface ArmazemEnvelope {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

const PREFIXO_ENVELOPE = 'unified_order_checkout_env:v2:';

/** A chave fixa de antes (sem dono). Nunca migrada: lida como pendente do cliente cujo prefixo casa. */
export const CHAVE_ENVELOPE_LEGADA = 'unified_order_checkout_env';

/** A chave do envelope deste USUÁRIO — o vendedor B nunca lê o envelope do vendedor A. */
export function chaveEnvelope(userId: string): string {
  return `${PREFIXO_ENVELOPE}${userId}`;
}

/** Itens da impressão digital SEM o prefixo do cliente (`<cliente>#<itens>`): o id derivado não muda
 *  quando o cliente ganha usuário local no meio do pedido. */
function assinaturaItens(fingerprint: string): string {
  const i = fingerprint.indexOf('#');
  return i < 0 ? fingerprint : fingerprint.slice(i + 1);
}

export interface IdentidadeCliente {
  local_user_id?: string | null;
  codigo_cliente?: number | string | null;
  codigo_cliente_colacor?: number | string | null;
}

// Código Omie 0 não identifica ninguém (cliente sem cadastro naquela conta) — Codex P1.
const idDe = (x: unknown) => (x == null || x === '' || x === 0 || x === '0' ? null : String(x));

/**
 * O MESMO cliente com mais um código (o autocadastro trouxe o Colacor, o app ganhou o usuário local)
 * compartilha ao menos uma identidade não-vazia; cliente trocado não compartilha nenhuma. Decide se o
 * nonce sobrevive a uma mudança do cliente selecionado.
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
 * O `checkoutId` de um envelope NOVO: SHA-256 de (nonce do rascunho, itens) no formato UUID (o banco
 * guarda `uuid`). Determinístico — a mesma cópia do pedido com o mesmo carrinho dá sempre o mesmo id.
 */
export async function idDoEnvio(nonce: string, fingerprint: string): Promise<string> {
  if (!nonce) throw new Error('idDoEnvio: nonce vazio');
  return hashUuid(`checkout-v1|${nonce}|${assinaturaItens(fingerprint)}`);
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

/** O prefixo da impressão digital (`customerKey` — usuário local, senão código Oben); '' = nenhum. */
export function prefixoCliente(fingerprint: string): string {
  const i = fingerprint.indexOf('#');
  return i < 0 ? '' : fingerprint.slice(0, i);
}

interface Pendente { chave: string; envelope: CheckoutEnvelope }

export type LeituraPendente = { estado: 'ilegivel' } | { estado: 'ok'; pendente: Pendente | null };

/**
 * O envio COMPROMETIDO deste usuário: o da chave dele, senão o legado — SÓ se o prefixo da impressão
 * digital do legado for o do cliente (`prefixo`, '' = nenhum cliente → legado ignorado). A chave do
 * usuário ilegível → `ilegivel` (nunca "não há pendente"); o legado ilegível conta como ausente.
 */
export function lerPendente(arm: ArmazemEnvelope, chave: string, prefixo: string): LeituraPendente {
  const l = lerEnvelopeEstrito(arm, chave);
  if (l.estado === 'ilegivel') return { estado: 'ilegivel' };
  if (l.estado === 'presente' && l.envelope.committed) return { estado: 'ok', pendente: { chave, envelope: l.envelope } };
  if (prefixo) {
    const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
    if (leg.estado === 'presente' && leg.envelope.committed && prefixoCliente(leg.envelope.fingerprint) === prefixo) {
      return { estado: 'ok', pendente: { chave: CHAVE_ENVELOPE_LEGADA, envelope: leg.envelope } };
    }
  }
  return { estado: 'ok', pendente: null };
}

export type ReservaEnvio =
  | { decisao: 'conflict'; envelope: CheckoutEnvelope }
  | { decisao: 'indeterminado' }
  | { decisao: 'new' | 'reuse'; envelope: CheckoutEnvelope; gravou: boolean };

export interface PedidoDeReserva {
  /** `chaveEnvelope(userId)` — onde o commit é gravado. */
  chave: string;
  fingerprint: string;
  /** `idDoEnvio(nonce, fingerprint)` — calculado antes da trava (é assíncrono). */
  idCalculado: string;
}

/**
 * A reserva do envio, sob `comTravaEntreAbas`: lê o armazém (não a memória da aba), decide com a regra da
 * main e grava o envelope COMPROMETIDO na chave do usuário. `criar(id)` monta o envelope novo com a
 * metadata da ponte (e o nonce).
 *  - chave do usuário ilegível → `indeterminado`
 *  - envio pendente com a MESMA impressão digital → `reuse` com o id DELE (o servidor diz "já enviado")
 *  - envio pendente com OUTRA impressão digital → `conflict`
 *  - senão → `new` com o id derivado.
 */
export function reservarEnvio(arm: ArmazemEnvelope, p: PedidoDeReserva, criar: (id: string) => CheckoutEnvelope): ReservaEnvio {
  const l = lerPendente(arm, p.chave, prefixoCliente(p.fingerprint));
  if (l.estado === 'ilegivel') return { decisao: 'indeterminado' };
  if (l.pendente) {
    if (l.pendente.envelope.fingerprint !== p.fingerprint) return { decisao: 'conflict', envelope: l.pendente.envelope };
    // reuse: o MESMO checkoutId e a metadata da ponte CONGELADA na criação (o spread preserva).
    const envelope = { ...l.pendente.envelope, committed: true };
    return { decisao: 'reuse', envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
  }
  const envelope = { ...criar(p.idCalculado), checkoutId: p.idCalculado, fingerprint: p.fingerprint, committed: true };
  return { decisao: 'new', envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
}

/** Sucesso TOTAL: solta o envelope DESTE envio na chave do usuário e no legado (só se ainda for ele — o
 *  commit de outra aba fica). false = alguma remoção falhou. */
export function concluirEnvio(arm: ArmazemEnvelope, chave: string, checkoutId: string): boolean {
  let ok = true;
  for (const k of [chave, CHAVE_ENVELOPE_LEGADA]) {
    const l = lerEnvelopeEstrito(arm, k);
    if (l.estado === 'presente' && l.envelope.checkoutId === checkoutId) ok = gravarEnvelope(arm, k, null) && ok;
  }
  return ok;
}

/** "Trocar e limpar" com a chave do usuário ilegível: o vendedor pediu para recomeçar — ela sai (senão o
 *  usuário ficaria travado para sempre). Envelope legível nunca é apagado por aqui. */
export function limparSeIlegivel(arm: ArmazemEnvelope, chave: string): void {
  if (lerEnvelopeEstrito(arm, chave).estado === 'ilegivel') gravarEnvelope(arm, chave, null);
}

interface TravasWeb {
  request<T>(nome: string, opcoes: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Seção crítica entre ABAS da mesma origem (Web Locks — Chrome 69+, Safari 15.4+). Sem a API, roda direto:
 * resta a janela de um getItem→setItem síncrono; o id derivado segue impedindo o PV duplicado do mesmo
 * rascunho (o servidor deduplica pelo id).
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

export function nomeDaTrava(userId: string): string {
  return `checkout:${userId}`;
}

/** O que a OUTRA aba fez com o envelope deste usuário, visto por um evento `storage`. */
export type MudancaOutraAba = 'enviou' | 'liberou' | null;

export function classificarMudancaOutraAba(novoValor: string | null, meuCheckoutId: string | null): MudancaOutraAba {
  if (novoValor === null) return meuCheckoutId ? 'liberou' : null;
  let e: unknown;
  try { e = JSON.parse(novoValor); } catch { return null; }
  if (!valido(e)) return null;
  return e.committed ? 'enviou' : null;
}
