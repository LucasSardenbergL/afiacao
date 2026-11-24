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
import type { CheckoutEnvelope, IdsPorConta } from './checkout-envelope';

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

export const identifica = (c: IdentidadeCliente | null | undefined): c is IdentidadeCliente =>
  !!c && (idDe(c.local_user_id) !== null || idDe(c.codigo_cliente) !== null || idDe(c.codigo_cliente_colacor) !== null);

/**
 * Rodada do Codex no delta (P0 #1): o cliente chega em PEDAÇOS (o 360 entrega o `local_user_id` antes do
 * código Colacor). "Mesmo cliente" exigia um campo em comum e derrubava o nonce no render intermediário →
 * 2º PV Colacor. Agora só derruba quando um campo presente NOS DOIS diverge — o cliente trocado de fato
 * acaba conflitando quando a identidade completa chega, e o id final leva o código da conta (`idsFinaisDoEnvio`).
 */
export function conflitaCliente(a: IdentidadeCliente | null | undefined, b: IdentidadeCliente | null | undefined): boolean {
  if (!a || !b) return false;
  const diverge = (x: unknown, y: unknown) => idDe(x) !== null && idDe(y) !== null && idDe(x) !== idDe(y);
  return diverge(a.local_user_id, b.local_user_id) || diverge(a.codigo_cliente, b.codigo_cliente)
    || diverge(a.codigo_cliente_colacor, b.codigo_cliente_colacor);
}

/**
 * O prefixo do cliente na impressão digital. Rodada do Codex no delta (P0 #2): `local_user_id || código Oben`
 * dava '' para DOIS clientes só-Colacor (Oben 0) — mesma fp → `reuse` entregava a um os ids do outro.
 * Cai no código Colacor só quando os dois de antes faltam: quem já tinha prefixo mantém o MESMO (legado).
 */
export function chaveDoCliente(c: IdentidadeCliente | null | undefined): string {
  if (!c) return '';
  const colacor = idDe(c.codigo_cliente_colacor);
  return idDe(c.local_user_id) ?? idDe(c.codigo_cliente) ?? (colacor ? `colacor:${colacor}` : '');
}

/** Junta as identidades do MESMO cliente sem que um campo vazio de `b` apague o preenchido de `a`. */
export function mesclarIdentidade(a: IdentidadeCliente | null | undefined, b: IdentidadeCliente | null | undefined): IdentidadeCliente | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const um = <T,>(x: T, y: T): T => (idDe(y) !== null ? y : x);
  return {
    local_user_id: um(a.local_user_id, b.local_user_id),
    codigo_cliente: um(a.codigo_cliente, b.codigo_cliente),
    codigo_cliente_colacor: um(a.codigo_cliente_colacor, b.codigo_cliente_colacor),
  };
}

/**
 * Restaurar o rascunho: a QUEM o nonce dele fica ligado (null = não adota — o carrinho ganha nonce novo).
 * P0 do Codex no PR 2.2: o rascunho com código Oben 0 é aplicado ANTES de o cliente carregar e o nonce se
 * perdia → id novo → 2º PV Colacor. Agora o rascunho grava o DONO do nonce (`doRascunho`), e o nonce é
 * adotado ligado a ele mesmo sem cliente na tela; o efeito de troca de cliente (`conflitaCliente`) o
 * derruba se o cliente que chegar for outro. Sem dono gravado e sem cliente na tela → não adota (nunca um nonce
 * sem dono, que daria "já enviado" com o PV de outro cliente).
 */
export function clienteParaAdotarNonce(
  nonce: unknown,
  doRascunho: unknown,
  atual: IdentidadeCliente | null | undefined,
): IdentidadeCliente | null {
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  // O rascunho vem do disco (JSON sem esquema): só os três campos de identidade, e só se identificam.
  const r = doRascunho && typeof doRascunho === 'object' ? doRascunho as Record<string, unknown> : null;
  const lido: IdentidadeCliente | null = r ? {
    local_user_id: typeof r.local_user_id === 'string' ? r.local_user_id : null,
    codigo_cliente: typeof r.codigo_cliente === 'number' || typeof r.codigo_cliente === 'string' ? r.codigo_cliente : null,
    codigo_cliente_colacor: typeof r.codigo_cliente_colacor === 'number' || typeof r.codigo_cliente_colacor === 'string' ? r.codigo_cliente_colacor : null,
  } : null;
  const dono = identifica(lido) ? lido : null;
  if (!identifica(atual)) return dono;
  if (dono && conflitaCliente(dono, atual)) return null;
  return mesclarIdentidade(dono, atual);
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

/** Um item de produto como entra no id por conta: o da impressão digital MAIS a cor (tingimento). */
export interface ItemDoId {
  account: string; omie_codigo_produto: number | string; quantity: number; unit_price: number;
  tint_cor_id?: string | null; tint_formula_id?: string | null;
}

/**
 * As linhas que derivam os ids por conta (`<conta>:<sku>:<qtd>:<preço>:cor=<cor>/<fórmula>`). Rodada do
 * Codex no delta (P0 #6): a impressão digital não tem a cor — vermelho→azul do mesmo SKU/qtd/preço dava o
 * MESMO id Oben e o reenvio respondia "já enviado" com a cor errada no Omie.
 */
export function linhasDoId(itens: ReadonlyArray<ItemDoId>): string {
  return itens.map(i => `${i.account}:${i.omie_codigo_produto}:${i.quantity}:${i.unit_price.toFixed(2)}:cor=${i.tint_cor_id ?? '-'}/${i.tint_formula_id ?? '-'}`)
    .sort().join('|');
}

/** As linhas de UMA conta (`<conta>:<sku>:...`, com ou sem prefixo `<cliente>#`), em ordem estável. */
function itensDaConta(fingerprint: string, conta: 'oben' | 'colacor'): string {
  const sig = assinaturaItens(fingerprint);
  return sig ? sig.split('|').filter(l => l.startsWith(`${conta}:`)).sort().join('|') : '';
}

/**
 * As BASES dos ids por conta, congeladas num envelope NOVO: SHA(nonce, conta, itens DAQUELA conta) — as
 * linhas vêm de `linhasDoId` (com cor) ou de uma impressão digital. P0 do Codex no PR 2.2: com um id só
 * sobre o carrinho inteiro, a aba B que mudava só a quantidade Colacor mudava também o id Oben → 2º PV
 * Oben idêntico. Só o nonce não basta: engoliria um 2º pedido legítimo de outra aba. A base da OS é só
 * (nonce): a assinatura dos serviços entra no ENVIO (`idsFinaisDoEnvio`), não congelada.
 */
export async function idsDoEnvio(nonce: string, linhas: string): Promise<IdsPorConta> {
  if (!nonce) throw new Error('idsDoEnvio: nonce vazio');
  const [oben, colacor, afiacao] = await Promise.all([
    hashUuid(`checkout-v2|${nonce}|oben|${itensDaConta(linhas, 'oben')}`),
    hashUuid(`checkout-v2|${nonce}|colacor|${itensDaConta(linhas, 'colacor')}`),
    hashUuid(`checkout-v2|${nonce}|afiacao`),
  ]);
  return { oben, colacor, afiacao };
}

const ehId = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

export type IdsDoEnvio =
  | { estado: 'legado' | 'ok'; ids: IdsPorConta }
  | { estado: 'corrompido' };

/**
 * Os ids que VÃO ao servidor, calculados NO ENVIO (depois do autocadastro, com o cliente efetivo):
 *  - envelope legado (sem `idsPorConta`) → o `checkoutId` em todas, como a main enviava;
 *  - `idsPorConta` presente mas inválido, ou sem o nonce → `corrompido`: BARRA o envio (P0 #4 — cair no
 *    `checkoutId` trocava também a conta íntegra e a Oben já enviada saía de novo);
 *  - ok → cada base + o código do cliente NAQUELA conta (P0 #2/#3: dois clientes com o mesmo carrinho
 *    e nonce nunca recebem o "já enviado" um do outro); a OS = (nonce, cliente, assinatura ATUAL dos
 *    serviços) — P0 #7: congelada, a ferramenta acrescentada depois de uma falha parcial dava 2 OS.
 */
export async function idsFinaisDoEnvio(
  e: CheckoutEnvelope,
  cliente: IdentidadeCliente | null | undefined,
  assinaturaAfiacao: string,
): Promise<IdsDoEnvio> {
  const ids = e.idsPorConta;
  if (ids === undefined || ids === null) {
    return { estado: 'legado', ids: { oben: e.checkoutId, colacor: e.checkoutId, afiacao: e.checkoutId } };
  }
  if (typeof ids !== 'object' || !ehId(ids.oben) || !ehId(ids.colacor) || !ehId(ids.afiacao) || !ehId(e.nonce)) {
    return { estado: 'corrompido' };
  }
  const [oben, colacor, afiacao] = await Promise.all([
    hashUuid(`checkout-v2-cli|${ids.oben}|${idDe(cliente?.codigo_cliente) ?? '-'}`),
    hashUuid(`checkout-v2-cli|${ids.colacor}|${idDe(cliente?.codigo_cliente_colacor) ?? '-'}`),
    hashUuid(`checkout-v2-os|${ids.afiacao}|${chaveDoCliente(cliente) || '-'}|${assinaturaAfiacao}`),
  ]);
  return { estado: 'ok', ids: { oben, colacor, afiacao } };
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
  /** `idsDoEnvio(nonce, fingerprint, assinaturaAfiacao)` — o que vai ao servidor num envelope novo. */
  idsCalculados: IdsPorConta;
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
  const envelope = {
    ...criar(p.idCalculado), checkoutId: p.idCalculado, idsPorConta: p.idsCalculados, fingerprint: p.fingerprint, committed: true,
  };
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
