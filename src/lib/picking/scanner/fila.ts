// Fila de leituras do picking v2: FIFO durável (IndexedDB) com envio em ordem de `seq`, uma
// leitura em voo por tarefa, para `picking_registrar_leitura`. O `leitura_id` nasce NA CAPTURA
// e é a idempotência do servidor: reenviar é sempre seguro (mesmo comando → mesmo resultado).
//
// Não usa o `offline-queue` (localStorage, genérico): aqui a ordem por tarefa e a lista de UUIDs
// da atribuição (que `picking_concluir` exige) são o contrato.

export type TipoLeitura = "bipe" | "manual" | "estorno";

export interface Comando {
  leitura_id: string;
  account: string;
  tarefa_id: string;
  atribuicao_id: string;
  tarefa_revisao: number;
  tipo: TipoLeitura;
  codigo_lido?: string;
  linha_id?: string;
  quantidade?: number;
  estorna_leitura_id?: string;
  lido_em: string;
}

export type EstadoItem = "pendente" | "aceita" | "rejeitada" | "falhou";

export interface ItemFila {
  seq: number;
  comando: Comando;
  estado: EstadoItem;
  tentativas: number;
  /** Resposta do servidor (aceita/rejeitada) ou mensagem do erro permanente (falhou). */
  motivo: string | null;
  linha_id: string | null;
  unidades: number | null;
}

/** Armazenamento da fila — IndexedDB no app, memória no teste. */
export interface ArmazemFila {
  todos(): Promise<ItemFila[]>;
  gravar(item: ItemFila): Promise<void>;
}

/** Resposta de `picking_registrar_leitura` (jsonb). */
export interface RespostaLeitura {
  ok: boolean;
  motivo: string | null;
  linha_id: string | null;
  unidades: number | null;
  pendente?: boolean;
}

/** Resultado do envio: resposta do servidor, erro transitório (rede) ou erro permanente (SQLSTATE). */
export type ResultadoEnvio =
  | { tipo: "resposta"; resposta: RespostaLeitura }
  | { tipo: "transitorio"; erro: string }
  | { tipo: "permanente"; erro: string };

/**
 * Próximos a enviar: o 1º `pendente` de cada tarefa, em ordem de `seq`. Um estorno cujo
 * original da MESMA tarefa ainda está pendente espera — a ordem por tarefa já garante isso.
 */
export function proximosEnvios(itens: ItemFila[]): ItemFila[] {
  const porTarefa = new Map<string, ItemFila>();
  for (const it of [...itens].sort((a, b) => a.seq - b.seq)) {
    if (it.estado !== "pendente") continue;
    if (!porTarefa.has(it.comando.tarefa_id)) porTarefa.set(it.comando.tarefa_id, it);
  }
  return [...porTarefa.values()];
}

/** Aplica o resultado de um envio ao item; transitório e `pendente` do servidor mantêm o item pendente. */
export function aplicarResultado(item: ItemFila, r: ResultadoEnvio): ItemFila {
  if (r.tipo === "transitorio") return { ...item, tentativas: item.tentativas + 1, motivo: r.erro };
  if (r.tipo === "permanente") return { ...item, estado: "falhou", tentativas: item.tentativas + 1, motivo: r.erro };
  const res = r.resposta;
  // `original_nao_recebido` (pendente): o servidor NÃO gravou — continua pendente.
  if (res.pendente) return { ...item, tentativas: item.tentativas + 1, motivo: res.motivo };
  return {
    ...item,
    estado: res.ok ? "aceita" : "rejeitada",
    tentativas: item.tentativas + 1,
    motivo: res.motivo,
    linha_id: res.linha_id,
    unidades: res.unidades,
  };
}

/** Espera antes da próxima tentativa: 1 s, 2 s, 4 s … até 30 s. */
export function backoffMs(tentativas: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, tentativas - 1));
}

/**
 * Todos os UUIDs emitidos pelo aparelho numa atribuição — o que `picking_concluir` exige.
 * Inclui rejeitadas (o servidor as gravou). `falhou` impede concluir: o servidor não tem o UUID.
 */
export function leiturasDaAtribuicao(itens: ItemFila[], atribuicaoId: string): { ids: string[]; prontas: boolean } {
  const da = itens.filter((i) => i.comando.atribuicao_id === atribuicaoId).sort((a, b) => a.seq - b.seq);
  return {
    ids: da.map((i) => i.comando.leitura_id),
    prontas: da.every((i) => i.estado === "aceita" || i.estado === "rejeitada"),
  };
}

/** Uma leitura nova na fila (seq = maior + 1). */
export async function enfileirar(armazem: ArmazemFila, comando: Comando): Promise<ItemFila> {
  const itens = await armazem.todos();
  if (itens.some((i) => i.comando.leitura_id === comando.leitura_id)) {
    throw new Error(`fila: leitura ${comando.leitura_id} já enfileirada`);
  }
  const seq = itens.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
  const item: ItemFila = { seq, comando, estado: "pendente", tentativas: 0, motivo: null, linha_id: null, unidades: null };
  await armazem.gravar(item);
  return item;
}

/**
 * Uma volta do laço de envio: manda o próximo de cada tarefa (em paralelo entre tarefas, em série
 * dentro da tarefa) e grava o resultado. Devolve quantos saíram da fila e se houve transitório
 * (quem chama espera o backoff antes da próxima volta).
 */
export async function enviarRodada(
  armazem: ArmazemFila,
  enviar: (c: Comando) => Promise<ResultadoEnvio>,
): Promise<{ resolvidos: ItemFila[]; transitorio: boolean; maxTentativas: number }> {
  const proximos = proximosEnvios(await armazem.todos());
  const resolvidos: ItemFila[] = [];
  let transitorio = false;
  let maxTentativas = 0;
  await Promise.all(
    proximos.map(async (it) => {
      const novo = aplicarResultado(it, await enviar(it.comando));
      await armazem.gravar(novo);
      if (novo.estado === "pendente") {
        transitorio = true;
        maxTentativas = Math.max(maxTentativas, novo.tentativas);
      } else resolvidos.push(novo);
    }),
  );
  return { resolvidos, transitorio, maxTentativas };
}

/** Armazém em memória (testes e fallback quando o IndexedDB não abre). */
export function armazemMemoria(inicial: ItemFila[] = []): ArmazemFila {
  const m = new Map(inicial.map((i) => [i.comando.leitura_id, i]));
  return {
    todos: () => Promise.resolve([...m.values()]),
    gravar: (i) => {
      m.set(i.comando.leitura_id, i);
      return Promise.resolve();
    },
  };
}

const DB = "picking-v2";
const STORE = "leituras";

/** Armazém IndexedDB: chave = `leitura_id`. Rejeita se o IndexedDB não abrir (quem chama decide). */
export function abrirArmazemIndexedDB(): Promise<ArmazemFila> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "comando.leitura_id" });
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB não abriu"));
    req.onsuccess = () => {
      const db = req.result;
      const tx = <T,>(modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
        new Promise<T>((res, rej) => {
          const r = fn(db.transaction(STORE, modo).objectStore(STORE));
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error ?? new Error("IndexedDB: operação falhou"));
        });
      resolve({
        todos: () => tx<ItemFila[]>("readonly", (s) => s.getAll() as IDBRequest<ItemFila[]>),
        gravar: async (item) => {
          await tx("readwrite", (s) => s.put(item));
        },
      });
    };
  });
}
