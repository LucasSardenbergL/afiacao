// Onde o envelope de envio do Novo Pedido mora, e como o envio o reserva SEM duplicar PV entre abas
// (PR 2.2, rodada 3 do Novo Pedido — P0).
//
// O defeito: o envelope {checkoutId, fingerprint, committed} ficava numa chave FIXA do localStorage, sem
// dono, e o `checkoutId` nascia no clique de enviar a partir do que a ABA tinha em memória. Duas abas com o
// mesmo carrinho (ou um refresh que perdesse o envelope) criavam dois checkoutIds → dois PVs no Omie. E num
// computador compartilhado, o vendedor B herdava o envelope do vendedor A.
//
// O desenho (revisto com o Codex, que achou 4 P0 na 1ª versão):
//  1. Chave por USUÁRIO + CLIENTE (`chaveEnvelope`). Cada par tem no máximo um envelope.
//  2. O identificador NASCE com o rascunho (`garantirIdentidadeRascunho`, `committed:false`) e a ABA o guarda
//     (e o rascunho em disco também): é "o id desta cópia do pedido".
//  3. LÁPIDE por usuário (`marcarConcluido`): o sucesso total registra o id. Uma cópia cujo id já foi
//     concluído (outra aba enviou e limpou) NÃO ganha id novo no clique — é recusada (`ja_concluido`).
//  4. O envio RELÊ o armazém e decide/grava numa seção crítica entre abas (`reservarEnvio` dentro de
//     `comTravaEntreAbas`). Leitura ILEGÍVEL (JSON quebrado, exceção) é `indeterminado` e barra o envio:
//     só AUSÊNCIA comprovada autoriza id novo.
//  5. Toda mutação fora da reserva (identidade, sucesso, descarte, marcas da OS) confere o id esperado.
//
// Troca aceita conscientemente: dois pedidos NOVOS idênticos (mesmo vendedor, cliente, itens e preços)
// abertos ao mesmo tempo viram UM ("já enviado" no 2º). Distinguir "restaurei este rascunho" de "montei outro
// igual" exigiria id por aba, que reabre o P0 (o mesmo rascunho em duas abas = dois PVs). Duplicar PV é pior.
//
// Migração para o servidor (Onda 3, rascunhos no servidor): o envelope é a identidade do RASCUNHO — o
// `checkoutId` vira o id da linha do rascunho no servidor, `committed` vira "enviado" e a lápide vira
// "concluído". O `ArmazemEnvelope` é a costura: hoje é o localStorage; depois, um adaptador da linha.
import { decideCheckoutEnvelope, type CheckoutEnvelope } from './checkout-envelope';

/** Subconjunto do `Storage` que o envelope usa — injetável nos testes (duas "abas" num armazém só). */
export interface ArmazemEnvelope {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

export const PREFIXO_ENVELOPE = 'unified_order_checkout_env:v2:';
export const PREFIXO_CONCLUIDOS = 'unified_order_checkout_concluidos:v2:';
/** A chave fixa de antes (sem dono). Nunca é migrada: só reaproveitada no retry EXATO do mesmo carrinho. */
export const CHAVE_ENVELOPE_LEGADA = 'unified_order_checkout_env';
/** Lápides guardadas por usuário (as mais recentes). Um pedido não fica aberto em outra aba por 200 envios. */
export const MAX_CONCLUIDOS = 200;

/**
 * Identidade do cliente na chave — a MAIS ESTÁVEL primeiro: o usuário local (não muda), depois Oben,
 * depois Colacor. O autocadastro pode acrescentar um código Omie no meio do envio; a ordem evita que a
 * chave mude por isso (e o hook move o envelope se mudar mesmo assim — Codex P0).
 */
export function chaveClienteEnvelope(c: {
  codigo_cliente?: number | string | null;
  codigo_cliente_colacor?: number | string | null;
  local_user_id?: string | null;
} | null | undefined): string | null {
  if (!c) return null;
  if (c.local_user_id) return `local:${c.local_user_id}`;
  if (c.codigo_cliente) return `oben:${c.codigo_cliente}`;
  if (c.codigo_cliente_colacor) return `colacor:${c.codigo_cliente_colacor}`;
  return null;
}

export function chaveEnvelope(userId: string, chaveCliente: string): string {
  return `${PREFIXO_ENVELOPE}${userId}:${chaveCliente}`;
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

/** Ausência COMPROVADA ≠ falha de leitura (Codex P0): só `ausente` autoriza criar id novo. */
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
  return l.estado === 'presente' ? l.envelope : null;
}

/** true = gravado (ou removido). false = o armazém recusou (quota/privado) — quem chama NÃO envia. */
export function gravarEnvelope(arm: ArmazemEnvelope, chave: string, e: CheckoutEnvelope | null): boolean {
  try {
    if (e) arm.setItem(chave, JSON.stringify(e)); else arm.removeItem(chave);
    return true;
  } catch { return false; }
}

/** Grava SÓ se o que está guardado ainda é o envelope `idEsperado` (ou nada, quando `idEsperado` é null). */
export function gravarSeAindaFor(
  arm: ArmazemEnvelope, chave: string, idEsperado: string | null, e: CheckoutEnvelope | null,
): boolean {
  const l = lerEnvelopeEstrito(arm, chave);
  if (l.estado === 'ilegivel') return false;
  const atual = l.estado === 'presente' ? l.envelope.checkoutId : null;
  if (atual !== idEsperado) return false;
  return gravarEnvelope(arm, chave, e);
}

// ─── Lápide: ids já concluídos (sucesso total) por usuário ───

function chaveConcluidos(userId: string): string {
  return `${PREFIXO_CONCLUIDOS}${userId}`;
}

/** Lista de ids concluídos; `null` = ilegível (o chamador trata como indeterminado). */
function lerConcluidos(arm: ArmazemEnvelope, userId: string): string[] | null {
  let r: string | null;
  try { r = arm.getItem(chaveConcluidos(userId)); } catch { return null; }
  if (r === null) return [];
  try {
    const v: unknown = JSON.parse(r);
    return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null;
  } catch { return null; }
}

/** true | false | 'ilegivel'. */
export function estaConcluido(arm: ArmazemEnvelope, userId: string, id: string): boolean | 'ilegivel' {
  const l = lerConcluidos(arm, userId);
  return l === null ? 'ilegivel' : l.includes(id);
}

/** Registra o id como concluído (idempotente, guarda os MAX_CONCLUIDOS mais recentes). false = não gravou. */
export function marcarConcluido(arm: ArmazemEnvelope, userId: string, id: string): boolean {
  const atual = lerConcluidos(arm, userId) ?? []; // ilegível: recomeça a lista — perder lápides velhas < não ter a nova
  const prox = [...atual.filter(x => x !== id), id].slice(-MAX_CONCLUIDOS);
  try { arm.setItem(chaveConcluidos(userId), JSON.stringify(prox)); return true; } catch { return false; }
}

/**
 * Sucesso TOTAL: lápide primeiro, depois remove o envelope SE ainda for o deste envio (uma aba não apaga
 * o envelope que outra gravou depois). true = a lápide foi gravada — com ela o id nunca mais é reusado,
 * mesmo que a remoção falhe (Codex P1: remoção falha → próximo pedido idêntico virava "já enviado").
 */
export function concluirEnvio(arm: ArmazemEnvelope, userId: string, chave: string, checkoutId: string): boolean {
  const lapide = marcarConcluido(arm, userId, checkoutId);
  gravarSeAindaFor(arm, chave, checkoutId, null);
  return lapide;
}

/**
 * O identificador nasce com o RASCUNHO: se o par ainda não tem envelope, grava um não-comprometido. O id
 * preferido é o que a aba já carrega (`idDaAba`, vindo do rascunho restaurado) — desde que não esteja
 * concluído. Idempotente — se já existe (desta aba ou de outra), devolve o que está lá. Rode sob a trava.
 */
export function garantirIdentidadeRascunho(
  arm: ArmazemEnvelope,
  userId: string,
  chave: string,
  idDaAba: string | null,
  gerarId: () => string,
): CheckoutEnvelope | null {
  const l = lerEnvelopeEstrito(arm, chave);
  if (l.estado === 'presente') {
    if (estaConcluido(arm, userId, l.envelope.checkoutId) !== true) return l.envelope;
    // envelope cujo id já foi concluído (a remoção falhou): é lixo, não identidade.
  } else if (l.estado === 'ilegivel') {
    return null;
  }
  const reusar = idDaAba && estaConcluido(arm, userId, idDaAba) === false ? idDaAba : null;
  const novo: CheckoutEnvelope = { checkoutId: reusar ?? gerarId(), fingerprint: '', committed: false };
  return gravarEnvelope(arm, chave, novo) ? novo : null;
}

export type ReservaEnvio =
  | { decisao: 'conflict'; envelope: CheckoutEnvelope }
  | { decisao: 'indeterminado' }
  | { decisao: 'ja_concluido'; checkoutId: string }
  | { decisao: 'new' | 'reuse'; envelope: CheckoutEnvelope; gravou: boolean };

export interface PedidoDeReserva {
  userId: string;
  chave: string;
  fingerprint: string;
  /** O id desta cópia do pedido (aba/rascunho). null = a aba não tem. */
  idDaAba: string | null;
}

/**
 * A reserva do envio: LÊ o armazém (não a memória da aba), decide e grava o envelope comprometido.
 * `criar(id)` monta o envelope novo (metadata da ponte) com o id a usar (null = gere um). Rode dentro de
 * `comTravaEntreAbas` para que ler→gravar seja atômico entre abas.
 */
export function reservarEnvio(
  arm: ArmazemEnvelope,
  p: PedidoDeReserva,
  criar: (id: string | null) => CheckoutEnvelope,
): ReservaEnvio {
  // A cópia desta aba já foi concluída em outra aba (que enviou e limpou): id novo aqui = 2º PV.
  if (p.idDaAba) {
    const c = estaConcluido(arm, p.userId, p.idDaAba);
    if (c === 'ilegivel') return { decisao: 'indeterminado' };
    if (c) return { decisao: 'ja_concluido', checkoutId: p.idDaAba };
  }
  const l = lerEnvelopeEstrito(arm, p.chave);
  if (l.estado === 'ilegivel') return { decisao: 'indeterminado' };
  let guardado = l.estado === 'presente' ? l.envelope : null;
  if (guardado) {
    const c = estaConcluido(arm, p.userId, guardado.checkoutId);
    if (c === 'ilegivel') return { decisao: 'indeterminado' };
    if (c) guardado = null; // sobra de uma remoção que falhou — a lápide manda
  }
  // Retry EXATO de um envelope legado (antes deste PR): mesmo cliente+itens+preços → reaproveita o id.
  if (!guardado) {
    const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
    if (leg.estado === 'presente' && leg.envelope.committed && leg.envelope.fingerprint === p.fingerprint
      && estaConcluido(arm, p.userId, leg.envelope.checkoutId) === false) {
      guardado = leg.envelope;
    }
  }
  const decisao = decideCheckoutEnvelope(guardado, p.fingerprint);
  if (decisao === 'conflict') return { decisao, envelope: guardado as CheckoutEnvelope };
  const envelope: CheckoutEnvelope = decisao === 'reuse'
    ? { ...(guardado as CheckoutEnvelope), committed: true }
    // O id desta CÓPIA vence o do rascunho guardado: a aba que restaurou X e a que abriu U para o mesmo
    // carrinho convergem pelo 'reuse' acima (quem chegar 2º vê o commit do 1º).
    : { ...criar(p.idDaAba ?? (guardado && !guardado.committed ? guardado.checkoutId : null)), fingerprint: p.fingerprint, committed: true };
  return { decisao, envelope, gravou: gravarEnvelope(arm, p.chave, envelope) };
}

/**
 * O cliente ganhou outra chave no meio do pedido (autocadastro trouxe um código): leva o envelope do par
 * antigo para o novo, se o novo estiver livre. Sem isto, restaurar o carrinho após um envio sem resposta
 * cairia na chave nova vazia e o retry geraria outro PV (Codex P0).
 */
export function moverEnvelope(arm: ArmazemEnvelope, de: string, para: string): boolean {
  if (de === para) return true;
  const origem = lerEnvelopeEstrito(arm, de);
  if (origem.estado !== 'presente') return origem.estado === 'ausente';
  const destino = lerEnvelopeEstrito(arm, para);
  if (destino.estado !== 'ausente') return false;
  return gravarEnvelope(arm, para, origem.envelope) && gravarEnvelope(arm, de, null);
}

/** Descartar o rascunho também solta o envelope legado DESTE cliente (senão o retry exato o ressuscita). */
export function descartarLegadoDoCliente(arm: ArmazemEnvelope, prefixosFp: string[]): void {
  const leg = lerEnvelopeEstrito(arm, CHAVE_ENVELOPE_LEGADA);
  if (leg.estado !== 'presente') return;
  if (prefixosFp.some(p => p && leg.envelope.fingerprint.startsWith(`${p}#`))) {
    gravarEnvelope(arm, CHAVE_ENVELOPE_LEGADA, null);
  }
}

interface TravasWeb {
  request<T>(nome: string, opcoes: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Seção crítica entre ABAS da mesma origem (Web Locks — Chrome 69+, Safari 15.4+). Sem a API, roda direto:
 * resta a janela de um getItem→setItem síncrono entre duas abas (risco residual registrado no histórico).
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
export type MudancaOutraAba = 'enviou' | 'liberou' | 'editando' | null;

export function classificarMudancaOutraAba(novoValor: string | null, meuCheckoutId: string | null): MudancaOutraAba {
  if (novoValor === null) return meuCheckoutId ? 'liberou' : null;
  let e: unknown;
  try { e = JSON.parse(novoValor); } catch { return null; }
  if (!valido(e)) return null;
  return e.committed ? 'enviou' : 'editando';
}
