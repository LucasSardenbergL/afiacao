// Onde o envelope de envio do Novo Pedido mora, e de onde vem o `checkoutId` — sem PV duplicado entre abas
// nem pedido perdido como "já enviado" (PR 2.2, rodada 3 do Novo Pedido — P0).
//
// O defeito: o envelope {checkoutId, fingerprint, committed} ficava numa chave FIXA do localStorage, sem
// dono, e o `checkoutId` era SORTEADO no clique de enviar a partir da memória da aba. Duas abas com o mesmo
// carrinho (ou um refresh que perdesse o envelope) sorteavam dois ids → dois PVs. Num computador
// compartilhado, o vendedor B herdava o envelope do vendedor A.
//
// O desenho (3ª versão — o Codex derrubou duas versões com "lápide" local):
//  1. O id é DERIVADO, não sorteado: `idDoEnvio(nonce, itens)`. O `nonce` nasce com o RASCUNHO (1º item no
//     carrinho), viaja no rascunho em disco e é o que duas abas/um refresh compartilham ao restaurar.
//     Mesma cópia + mesmo carrinho ⇒ MESMO id ⇒ o servidor responde "já enviado" (`sales_orders.checkout_id`
//     + conta; OS por `cCodIntOS`). Carrinho diferente ⇒ id diferente ⇒ pedido novo — nunca um pedido
//     legítimo é engolido como "já enviado". A "lápide" é o próprio servidor.
//  2. O envelope COMPROMETIDO (um envio saiu) fica na chave por USUÁRIO + CLIENTE e trava o carrinho: depois
//     de um envio parcial, editar e reenviar é conflito (senão a conta já enviada sairia de novo com id novo).
//     O envio RELÊ essa chave e grava sob trava entre abas (`reservarEnvio` em `comTravaEntreAbas`); leitura
//     ILEGÍVEL é `indeterminado` e barra o envio — só ausência comprovada libera.
//  3. O nonce gira no fim do ciclo (sucesso total, descarte, troca de cliente, "Novo pedido"): o próximo
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

export const PREFIXO_ENVELOPE = 'unified_order_checkout_env:v2:';
/** A chave fixa de antes (sem dono). Nunca migrada: só reaproveitada no retry EXATO do mesmo carrinho. */
export const CHAVE_ENVELOPE_LEGADA = 'unified_order_checkout_env';

export interface IdentidadeCliente {
  local_user_id?: string | null;
  codigo_cliente?: number | string | null;
  codigo_cliente_colacor?: number | string | null;
}

/** Chave do cliente no armazém — a identidade MAIS ESTÁVEL primeiro (usuário local, Oben, Colacor). */
export function chaveClienteEnvelope(c: IdentidadeCliente | null | undefined): string | null {
  if (!c) return null;
  if (c.local_user_id) return `local:${c.local_user_id}`;
  if (c.codigo_cliente) return `oben:${c.codigo_cliente}`;
  if (c.codigo_cliente_colacor) return `colacor:${c.codigo_cliente_colacor}`;
  return null;
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
  const iguais = (x: unknown, y: unknown) => x != null && x !== '' && y != null && y !== '' && String(x) === String(y);
  return iguais(a.local_user_id, b.local_user_id) || iguais(a.codigo_cliente, b.codigo_cliente)
    || iguais(a.codigo_cliente_colacor, b.codigo_cliente_colacor);
}

/** Itens da impressão digital SEM o prefixo do cliente (`<cliente>#<itens>`): o prefixo muda quando o
 *  cliente ganha usuário local, e isso não pode virar "outro carrinho" (Codex P1). */
export function assinaturaItens(fingerprint: string): string {
  const i = fingerprint.indexOf('#');
  return i < 0 ? fingerprint : fingerprint.slice(i + 1);
}

/**
 * O `checkoutId` do envio: SHA-256 de (nonce do rascunho, itens) no formato UUID (o banco guarda `uuid`).
 * Determinístico — a mesma cópia do pedido com o mesmo carrinho dá sempre o mesmo id, em qualquer aba.
 */
export async function idDoEnvio(nonce: string, fingerprint: string): Promise<string> {
  if (!nonce) throw new Error('idDoEnvio: nonce vazio');
  const dados = new TextEncoder().encode(`checkout-v1|${nonce}|${assinaturaItens(fingerprint)}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', dados)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80; // versão 8 (RFC 9562: formato livre)
  h[8] = (h[8] & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

/** Para EXIBIR (diálogo, aviso). Nunca para decidir envio — use `lerEnvelopeEstrito`. */
export function lerEnvelope(arm: ArmazemEnvelope, chave: string): CheckoutEnvelope | null {
  const l = lerEnvelopeEstrito(arm, chave);
  return l.estado === 'presente' && l.envelope.committed ? l.envelope : null;
}

/** true = gravado (ou removido). false = o armazém recusou (quota/privado) — quem chama NÃO envia. */
export function gravarEnvelope(arm: ArmazemEnvelope, chave: string, e: CheckoutEnvelope | null): boolean {
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

export type ReservaEnvio =
  | { decisao: 'conflict'; envelope: CheckoutEnvelope }
  | { decisao: 'indeterminado' }
  | { decisao: 'new' | 'reuse'; envelope: CheckoutEnvelope; gravou: boolean };

export interface PedidoDeReserva {
  chave: string;
  fingerprint: string;
  /** `idDoEnvio(nonce, fingerprint)` — calculado antes da trava (é assíncrono). */
  idCalculado: string;
  /** customerKey de antes do PR 2.2 deste cliente (prefixo da fingerprint legada). */
  prefixosLegado: string[];
}

/**
 * A reserva do envio, sob `comTravaEntreAbas`: lê a chave do par (não a memória da aba), decide e grava o
 * envelope COMPROMETIDO. `criar(id)` monta o envelope novo com a metadata da ponte.
 *  - par com envio comprometido do MESMO carrinho → `reuse` (o id guardado; o servidor diz "já enviado")
 *  - par com envio comprometido de OUTRO carrinho → `conflict` (a conta já enviada não sai de novo)
 *  - par ilegível → `indeterminado`
 *  - senão, retry EXATO de um envelope legado → `reuse` do id legado; senão `new` com o id calculado.
 */
export function reservarEnvio(arm: ArmazemEnvelope, p: PedidoDeReserva, criar: (id: string) => CheckoutEnvelope): ReservaEnvio {
  const l = lerEnvelopeEstrito(arm, p.chave);
  if (l.estado === 'ilegivel') return { decisao: 'indeterminado' };
  const itens = assinaturaItens(p.fingerprint);
  const guardado = l.estado === 'presente' && l.envelope.committed ? l.envelope : null;
  if (guardado) {
    if (assinaturaItens(guardado.fingerprint) !== itens) return { decisao: 'conflict', envelope: guardado };
    const envelope = { ...guardado, fingerprint: p.fingerprint, committed: true };
    return { decisao: 'reuse', envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
  }
  const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
  if (leg.estado === 'presente' && leg.envelope.committed && assinaturaItens(leg.envelope.fingerprint) === itens
    && p.prefixosLegado.some(px => px && leg.envelope.fingerprint.startsWith(`${px}#`))) {
    const envelope = { ...leg.envelope, fingerprint: p.fingerprint, committed: true };
    return { decisao: 'reuse', envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
  }
  const envelope = { ...criar(p.idCalculado), checkoutId: p.idCalculado, fingerprint: p.fingerprint, committed: true };
  return { decisao: 'new', envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
}

/** Sucesso TOTAL: solta o envelope deste envio (e o legado, se era ele). false = não conseguiu apagar. */
export function concluirEnvio(arm: ArmazemEnvelope, chave: string, checkoutId: string): boolean {
  const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
  if (leg.estado === 'presente' && leg.envelope.checkoutId === checkoutId) gravarEnvelope(arm, CHAVE_ENVELOPE_LEGADA, null);
  const l = lerEnvelopeEstrito(arm, chave);
  if (l.estado === 'ausente') return true;
  if (l.estado === 'presente' && l.envelope.checkoutId !== checkoutId) return true; // de outra aba: fica
  return gravarEnvelope(arm, chave, null);
}

/**
 * O MESMO cliente ganhou outra chave no meio do pedido: leva o envelope comprometido para a chave nova (a
 * trava do carrinho segue o cliente). Destino com OUTRO envio comprometido não é sobrescrito → false.
 */
export function moverEnvelope(arm: ArmazemEnvelope, de: string, para: string): boolean {
  if (de === para) return true;
  const origem = lerEnvelopeEstrito(arm, de);
  if (origem.estado !== 'presente') return origem.estado === 'ausente';
  const destino = lerEnvelopeEstrito(arm, para);
  if (destino.estado === 'ilegivel') return false;
  if (destino.estado === 'presente' && destino.envelope.committed
    && destino.envelope.checkoutId !== origem.envelope.checkoutId) return false;
  return gravarEnvelope(arm, para, origem.envelope) && gravarEnvelope(arm, de, null);
}

/** Descartar o rascunho também solta o envelope legado DESTE carrinho (prefixo do cliente + itens). */
export function descartarLegadoDoCliente(arm: ArmazemEnvelope, prefixosFp: string[], fingerprintDoRascunho: string | null): void {
  const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
  if (leg.estado !== 'presente' || !fingerprintDoRascunho) return;
  if (assinaturaItens(leg.envelope.fingerprint) !== assinaturaItens(fingerprintDoRascunho)) return;
  if (prefixosFp.some(p => p && leg.envelope.fingerprint.startsWith(`${p}#`))) gravarEnvelope(arm, CHAVE_ENVELOPE_LEGADA, null);
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

/** O que a OUTRA aba fez com o envelope deste par, visto por um evento `storage`. */
export type MudancaOutraAba = 'enviou' | 'liberou' | null;

export function classificarMudancaOutraAba(novoValor: string | null, meuCheckoutId: string | null): MudancaOutraAba {
  if (novoValor === null) return meuCheckoutId ? 'liberou' : null;
  let e: unknown;
  try { e = JSON.parse(novoValor); } catch { return null; }
  if (!valido(e)) return null;
  return e.committed ? 'enviou' : null;
}
