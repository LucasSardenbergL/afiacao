// Onde o envelope de envio do Novo Pedido mora, e como o envio o reserva SEM duplicar PV entre abas
// (PR 2.2, rodada 3 do Novo Pedido — P0).
//
// O defeito: o envelope {checkoutId, fingerprint, committed} ficava numa chave FIXA do localStorage, sem
// dono, e o `checkoutId` nascia no clique de enviar a partir do que a ABA tinha em memória. Duas abas com o
// mesmo carrinho (ou um refresh que perdesse o envelope) criavam dois checkoutIds → dois PVs no Omie. E num
// computador compartilhado, o vendedor B herdava o envelope do vendedor A.
//
// O desenho:
//  1. Chave por USUÁRIO + CLIENTE (`chaveEnvelope`). Cada par tem no máximo um envelope.
//  2. O identificador NASCE com o rascunho (`garantirIdentidadeRascunho`, `committed:false`): ainda não foi
//     a servidor nenhum, então reaproveitá-lo no envio é seguro.
//  3. O envio RELÊ o armazenamento e decide/grava numa seção crítica entre abas (`reservarEnvio` dentro de
//     `comTravaEntreAbas`): a aba com memória velha enxerga o envelope comprometido pela outra e reusa o MESMO
//     checkoutId (mesmo carrinho) ou cai em conflito (outro carrinho) — nunca cria um id novo por engano.
//
// Migração para o servidor (Onda 3, rascunhos no servidor): o envelope é a identidade do RASCUNHO — o
// `checkoutId` vira o id da linha do rascunho no servidor e `committed` vira o estado "enviado". O
// `ArmazemEnvelope` é a costura: hoje é o localStorage; depois, um adaptador que lê/grava a linha.
import { decideCheckoutEnvelope, type CheckoutDecision, type CheckoutEnvelope } from './checkout-envelope';

/** Subconjunto do `Storage` que o envelope usa — injetável nos testes (duas "abas" num armazém só). */
export interface ArmazemEnvelope {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

export const PREFIXO_ENVELOPE = 'unified_order_checkout_env:v2:';
/** A chave fixa de antes (sem dono). Só é LIDA para migrar o envelope em voo no dia do deploy. */
export const CHAVE_ENVELOPE_LEGADA = 'unified_order_checkout_env';

/** Identidade do cliente na chave. Omie Oben primeiro, depois Colacor, depois o usuário local. */
export function chaveClienteEnvelope(c: {
  codigo_cliente?: number | string | null;
  codigo_cliente_colacor?: number | string | null;
  local_user_id?: string | null;
} | null | undefined): string | null {
  if (!c) return null;
  if (c.codigo_cliente) return `oben:${c.codigo_cliente}`;
  if (c.codigo_cliente_colacor) return `colacor:${c.codigo_cliente_colacor}`;
  if (c.local_user_id) return `local:${c.local_user_id}`;
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

export function lerEnvelope(arm: ArmazemEnvelope, chave: string): CheckoutEnvelope | null {
  try {
    const r = arm.getItem(chave);
    if (!r) return null;
    const e: unknown = JSON.parse(r);
    return valido(e) ? e : null;
  } catch { return null; }
}

/** true = gravado (ou removido). false = o armazém recusou (quota/privado) — quem chama NÃO envia. */
export function gravarEnvelope(arm: ArmazemEnvelope, chave: string, e: CheckoutEnvelope | null): boolean {
  try {
    if (e) arm.setItem(chave, JSON.stringify(e)); else arm.removeItem(chave);
    return true;
  } catch { return false; }
}

/**
 * Remove o envelope SÓ se ainda for o deste envio. Sucesso total numa aba não pode apagar um envelope
 * que outra aba gravou depois (outro checkoutId) — esse é um envio pendente de verdade.
 */
export function removerEnvelopeSeFor(arm: ArmazemEnvelope, chave: string, checkoutId: string): boolean {
  const atual = lerEnvelope(arm, chave);
  if (atual && atual.checkoutId !== checkoutId) return true;
  return gravarEnvelope(arm, chave, null);
}

/**
 * Traz o envelope da chave LEGADA para a chave do par (usuário, cliente) — uma vez, no dia do deploy.
 * Só migra se a impressão digital é deste cliente (`<customerKeyFp>#…`) e o par ainda não tem envelope;
 * envelope legado de OUTRO cliente fica onde está (será migrado quando aquele cliente for aberto).
 * Fail-closed de propósito: perder o envelope em voo = PV duplicado no reenvio; herdá-lo = no máximo um
 * "já enviado"/conflito, que tem saída na tela.
 */
export function migrarEnvelopeLegado(arm: ArmazemEnvelope, chave: string, customerKeyFp: string): void {
  if (!customerKeyFp) return;
  const legado = lerEnvelope(arm, CHAVE_ENVELOPE_LEGADA);
  if (!legado || !legado.fingerprint.startsWith(`${customerKeyFp}#`)) return;
  if (lerEnvelope(arm, chave)) return;
  if (gravarEnvelope(arm, chave, legado)) gravarEnvelope(arm, CHAVE_ENVELOPE_LEGADA, null);
}

/**
 * O identificador nasce com o RASCUNHO: se o par ainda não tem envelope, grava um não-comprometido com
 * id novo. Idempotente — se já existe (desta aba ou de outra), devolve o que está lá.
 */
export function garantirIdentidadeRascunho(
  arm: ArmazemEnvelope,
  chave: string,
  gerarId: () => string,
): CheckoutEnvelope | null {
  const atual = lerEnvelope(arm, chave);
  if (atual) return atual;
  const novo: CheckoutEnvelope = { checkoutId: gerarId(), fingerprint: '', committed: false };
  return gravarEnvelope(arm, chave, novo) ? novo : null;
}

export type ReservaEnvio =
  | { decisao: 'conflict'; envelope: CheckoutEnvelope }
  | { decisao: Exclude<CheckoutDecision, 'conflict'>; envelope: CheckoutEnvelope; gravou: boolean };

/**
 * A reserva do envio: LÊ o armazém (não a memória da aba), decide e grava o envelope comprometido.
 * `criar(idDoRascunho)` monta o envelope novo; recebe o id do rascunho não-comprometido para reaproveitar
 * (null = não havia → gere um). Rode dentro de `comTravaEntreAbas` para que ler→gravar seja atômico.
 */
export function reservarEnvio(
  arm: ArmazemEnvelope,
  chave: string,
  fingerprint: string,
  criar: (idDoRascunho: string | null) => CheckoutEnvelope,
): ReservaEnvio {
  const guardado = lerEnvelope(arm, chave);
  const decisao = decideCheckoutEnvelope(guardado, fingerprint);
  if (decisao === 'conflict') return { decisao, envelope: guardado as CheckoutEnvelope };
  const envelope: CheckoutEnvelope = decisao === 'reuse'
    ? { ...(guardado as CheckoutEnvelope), committed: true }
    : { ...criar(guardado && !guardado.committed ? guardado.checkoutId : null), fingerprint, committed: true };
  return { decisao, envelope, gravou: gravarEnvelope(arm, chave, envelope) };
}

interface TravasWeb {
  request<T>(nome: string, opcoes: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * Seção crítica entre ABAS da mesma origem (Web Locks). Sem a API (navegador antigo, jsdom), roda direto:
 * a janela de corrida é a de um getItem→setItem síncrono, e o reenvio continua protegido pela releitura.
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

/**
 * Classifica o `storage` event da chave deste par para o aviso "pedido aberto em outra aba".
 * `meuCheckoutId`: o envelope que esta aba conhece (null = nenhum).
 */
export function classificarMudancaOutraAba(novoValor: string | null, meuCheckoutId: string | null): MudancaOutraAba {
  if (novoValor === null) return meuCheckoutId ? 'liberou' : null;
  let e: unknown;
  try { e = JSON.parse(novoValor); } catch { return null; }
  if (!valido(e)) return null;
  return e.committed ? 'enviou' : 'editando';
}
