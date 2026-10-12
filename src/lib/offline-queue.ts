/**
 * Fila offline de mutações (scaffold para #20 do roadmap UX).
 *
 * O que esta v1 entrega:
 *  - API estável (`enqueue`, `flush`, `getOfflineQueueDepth`, `subscribeToOfflineQueue`)
 *  - Persistência simples em localStorage (será migrada para IndexedDB quando #20 for executado a fundo)
 *  - Subscription pra UI reagir a mudanças no depth
 *
 * DONO de cada item (2026-10-12): a fila é do APARELHO, mas cada mutação é de QUEM a fez.
 * Sem dono, o flush enviava a mutação de A com a sessão de B (A sai, B entra no mesmo coletor, a
 * rede volta): a escrita ia atribuída a B, ou a RLS recusava e o item ficava preso. Agora:
 *  - `enqueue` exige o `userId` da identidade REAL (`useAuth().user`, nunca o display da lente);
 *  - `flush` relê, ANTES de cada item, a credencial que vai ASSINAR as requisições e entrega ao
 *    handler essa MESMA credencial (o handler monta um cliente vinculado a ela — ver
 *    `offline-cliente-do-dono.ts`); só envia o que é do dono dela. O resto fica RETIDO intacto
 *    (sem attempts++) e visível no contador;
 *  - item legado sem dono (gravado antes desta versão, na chave v1) NUNCA é adotado por quem
 *    estiver logado — adotar é exatamente o bug. É movido para a v2 SEM dono: retido e visível;
 *  - uma rodada de flush por vez (no módulo e, com Web Locks, entre abas): duas rodadas
 *    simultâneas despachavam o mesmo item duas vezes.
 * Nenhum caminho daqui APAGA item de outro dono.
 *
 * Chave v2: aba/PWA de build ANTIGO lê só a v1 e ignoraria o dono — itens novos ficam fora do
 * alcance dela. Build antigo ainda aberto segue vulnerável para o que ELE enfileira até o
 * operador aceitar a atualização (o SW só troca no clique) — limite do cliente, só o servidor fecha.
 *
 * O que NÃO está aqui ainda (por design):
 *  - Conflict resolution
 *  - Background sync via service worker (precisa workbox config)
 *  - Retry exponencial granular por tipo de mutação
 *
 * Hoje: o `NetworkStatusIndicator` lê depth para mostrar contador. Páginas críticas (Picking,
 * RecebimentoConferencia, UnifiedOrder) podem começar a usar `enqueue()` em onError de mutações
 * quando offline; o flush manual é exposto pra ser disparado quando a conexão voltar.
 */

import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const STORAGE_KEY = 'offline_queue_v2';
/** Chave dos builds sem dono. Lida só para MIGRAR (itens viram sem dono = retidos). */
const STORAGE_KEY_LEGADO = 'offline_queue_v1';

export interface QueuedMutation<TVars = unknown> {
  id: string;
  /** Identificador da operação (ex: "picking.confirm", "recebimento.scan-lote"). */
  kind: string;
  variables: TVars;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
  /**
   * Quem enfileirou (auth.uid). Opcional no TIPO só porque itens gravados antes do M-10 não
   * têm — `enqueue` sempre grava. Ausente = sem dono = retido para sempre (ver `donoDe`).
   */
  userId?: string;
}

/** Contagem da fila do aparelho, do ponto de vista de um usuário. `meus + retidos` = total. */
export interface ContagemFila {
  /** Itens deste usuário — os únicos que o flush dele envia. */
  meus: number;
  /** `deOutros + semDono`: nunca enviados por este usuário. */
  retidos: number;
  /** De outra pessoa: saem quando ELA entrar de novo neste aparelho. */
  deOutros: number;
  /** Legado sem identificação: nenhum login os envia — só tratamento manual. */
  semDono: number;
}

/** Erro de `enqueue` sem dono: a mutação NÃO foi salva offline. */
export class FilaOfflineSemDonoError extends Error {
  constructor() {
    super('fila-offline: enqueue sem usuário — a ação não foi salva offline');
    this.name = 'FilaOfflineSemDonoError';
  }
}

/** Dono do item, ou `null` (legado / corrompido). `null` nunca casa com ninguém. */
function donoDe(m: QueuedMutation): string | null {
  return typeof m.userId === 'string' && m.userId.length > 0 ? m.userId : null;
}

function ehDe(m: QueuedMutation, userId: string | null): boolean {
  const dono = donoDe(m);
  return dono !== null && userId !== null && dono === userId;
}

type Listener = (depth: number) => void;
const listeners = new Set<Listener>();

function emit(depth: number) {
  listeners.forEach((l) => {
    try {
      l(depth);
    } catch {
      // ignora handler com bug
    }
  });
}

function lerChave(chave: string): QueuedMutation[] {
  try {
    const raw = localStorage.getItem(chave);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedMutation[]) : [];
  } catch {
    return [];
  }
}

/**
 * Move os itens da v1 para a v2 SEM dono (fail-closed: nenhum build antigo atestou dono, então
 * nenhum `userId` vindo de lá é aceito). Roda a cada leitura: um build antigo aberto noutra aba
 * pode voltar a escrever na v1.
 */
function migrarLegado(): void {
  const legado = lerChave(STORAGE_KEY_LEGADO);
  if (localStorage.getItem(STORAGE_KEY_LEGADO) === null) return;
  const semDono = legado.map(({ userId: _descartado, ...resto }) => resto as QueuedMutation);
  const atuais = lerChave(STORAGE_KEY);
  const ids = new Set(atuais.map((m) => m.id));
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...atuais, ...semDono.filter((m) => !ids.has(m.id))]));
  localStorage.removeItem(STORAGE_KEY_LEGADO);
  if (semDono.length > 0) track('offline.legado_sem_dono_migrado', { itens: semDono.length });
}

function readQueue(): QueuedMutation[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    migrarLegado();
  } catch {
    // storage cheio/bloqueado: a v1 fica onde está (nada é apagado) e a v2 segue legível
  }
  return lerChave(STORAGE_KEY);
}

function writeQueue(items: QueuedMutation[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  emit(items.length);
}

export async function enqueue<TVars>(kind: string, variables: TVars, userId: string): Promise<string> {
  // Fail-closed: item sem dono não teria quem o enviasse — o caller trata como erro, e a UI
  // NÃO diz "salvo offline".
  if (typeof userId !== 'string' || userId.length === 0) throw new FilaOfflineSemDonoError();
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items = readQueue();
  items.push({
    id,
    kind,
    variables,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    userId,
  });
  writeQueue(items);
  track('offline.queued', { kind, queue_depth: items.length });
  return id;
}

/** Total de itens no APARELHO (de todos os donos). */
export async function getOfflineQueueDepth(): Promise<number> {
  return readQueue().length;
}

/** Fila do aparelho dividida entre os itens de `userId` e os retidos (outro dono / sem dono). */
export function contarFila(userId: string | null): ContagemFila {
  const items = readQueue();
  const meus = items.filter((m) => ehDe(m, userId)).length;
  const semDono = items.filter((m) => donoDe(m) === null).length;
  return { meus, retidos: items.length - meus, deOutros: items.length - meus - semDono, semDono };
}

/**
 * Mutações de um kind ENFILEIRADAS POR `userId` (na ordem de enfileiramento). Item de outro
 * dono não entra: o overlay otimista do picking não pode mostrar como "confirmado" o que outra
 * pessoa confirmou e que só ela pode enviar.
 */
export function getQueuedByKind<TVars = unknown>(kind: string, userId: string | null): QueuedMutation<TVars>[] {
  return readQueue().filter((m): m is QueuedMutation<TVars> => m.kind === kind && ehDe(m, userId));
}

export interface ResultadoFlush {
  success: number;
  failed: number;
  retidos: number;
  /** Outra rodada (desta aba ou de outra) já estava em curso — esta não despachou nada. */
  emCurso?: boolean;
}

let rodadaEmCurso = false;

type WebLocks = {
  request: (nome: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

/** Uma rodada por vez: no módulo (sobrevive a remontagem do hook) e, com Web Locks, entre abas. */
async function comExclusao(rodar: () => Promise<ResultadoFlush>): Promise<ResultadoFlush> {
  const emCurso: ResultadoFlush = { success: 0, failed: 0, retidos: 0, emCurso: true };
  if (rodadaEmCurso) return emCurso;
  rodadaEmCurso = true;
  try {
    const locks = (typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: WebLocks }).locks
      : undefined);
    if (!locks?.request) return await rodar();
    let resultado: ResultadoFlush = emCurso;
    await locks.request('offline_queue_flush', { ifAvailable: true }, async (lock) => {
      if (lock) resultado = await rodar();
    });
    return resultado;
  } finally {
    rodadaEmCurso = false;
  }
}

/**
 * Tenta processar as mutações da fila DO DONO DA CREDENCIAL ATUAL usando o handler fornecido.
 * Handler retorna `true` em sucesso (item é removido da fila) ou `false` (mantém com attempts++).
 * Handler que dispara erro também mantém com attempts++.
 *
 * `credencialAtual` é relida ANTES DE CADA item, e a MESMA credencial conferida é entregue ao
 * handler — que deve assinar com ela (cliente vinculado), não com a sessão do aparelho: o SDK
 * relê a sessão a cada requisição, então conferir e depois usar o singleton deixa a janela
 * aberta. Se a sessão troca no meio do flush, os itens seguintes param ali. Falha ao ler a
 * credencial = ninguém = nada é enviado. Item cujo dono ≠ credencial atual (ou sem dono) é
 * RETIDO intacto: sem handler, sem attempts++.
 */
export async function flush<C extends { userId: string }>(
  handler: (mutation: QueuedMutation, credencial: C) => Promise<boolean>,
  credencialAtual: () => Promise<C | null>,
): Promise<ResultadoFlush> {
  return comExclusao(() => rodarFlush(handler, credencialAtual));
}

async function rodarFlush<C extends { userId: string }>(
  handler: (mutation: QueuedMutation, credencial: C) => Promise<boolean>,
  credencialAtual: () => Promise<C | null>,
): Promise<ResultadoFlush> {
  const items = readQueue();
  const succeeded = new Set<string>();
  const failedById = new Map<string, QueuedMutation>();
  let success = 0;
  let failed = 0;
  let retidos = 0;
  for (const item of items) {
    let credencial: C | null;
    try {
      credencial = await credencialAtual();
    } catch {
      credencial = null;
    }
    if (credencial === null || !ehDe(item, credencial.userId)) {
      retidos++;
      continue;
    }
    try {
      const ok = await handler(item, credencial);
      if (ok) {
        succeeded.add(item.id);
        success++;
      } else {
        failedById.set(item.id, { ...item, attempts: item.attempts + 1 });
        failed++;
      }
    } catch (e) {
      failedById.set(item.id, {
        ...item,
        attempts: item.attempts + 1,
        lastError: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
      failed++;
    }
  }
  // Re-lê a fila ATUAL em vez de sobrescrever com o snapshot: `enqueue()` pode ter
  // rodado durante os awaits do handler (rede intermitente do galpão). Remove só os
  // processados com sucesso (por id), aplica attempts++ nos que falharam, e preserva
  // intactos os que chegaram durante o flush.
  const remaining = readQueue()
    .filter((m) => !succeeded.has(m.id))
    .map((m) => failedById.get(m.id) ?? m);
  writeQueue(remaining);
  track('offline.flushed', { success, failed, retidos, remaining: remaining.length });
  return { success, failed, retidos };
}

export function subscribeToOfflineQueue(listener: Listener): () => void {
  listeners.add(listener);
  // dispara estado atual imediatamente
  listener(readQueue().length);
  return () => {
    listeners.delete(listener);
  };
}
