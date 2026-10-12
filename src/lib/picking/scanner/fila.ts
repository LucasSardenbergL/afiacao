// Fila de leituras do picking v2: FIFO durável (IndexedDB) com envio em ordem de `seq`, uma
// leitura em voo por tarefa, para `picking_registrar_leitura`. O `leitura_id` nasce NA CAPTURA
// e é a idempotência do servidor: reenviar é sempre seguro (mesmo comando → mesmo resultado).
//
// Contratos (Codex Fase 1):
//   - durável ou nada: sem IndexedDB a separação NÃO começa (memória perderia leitura no reload);
//   - a leitura só conta como capturada depois do COMMIT da transação (`oncomplete`);
//   - `seq` é alocado na MESMA transação readwrite que grava o item (IndexedDB serializa as
//     transações readwrite do mesmo store → duas capturas nunca pegam o mesmo seq);
//   - cada item tem DONO (`operador_id`): só a sessão do mesmo usuário envia — outra identidade
//     transformaria as leituras em `atribuicao_antiga` definitiva;
//   - rejeição de leitura prevista como aceita fica marcada até o operador ver.

type TipoLeitura = "bipe" | "manual" | "estorno";

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

type EstadoItem = "pendente" | "aceita" | "rejeitada" | "falhou";

export interface ItemFila {
  seq: number;
  comando: Comando;
  /** Usuário REAL que capturou (nunca o da lente). Só ele envia. */
  operador_id: string;
  estado: EstadoItem;
  tentativas: number;
  /** Resposta do servidor (aceita/rejeitada) ou mensagem do erro permanente (falhou). */
  motivo: string | null;
  linha_id: string | null;
  unidades: number | null;
  /** Previsão local no momento da captura (validacao-local) — conta no progresso até o servidor responder. */
  previsto: { linha_id: string; unidades: number } | null;
  /** Servidor discordou da previsão (ou falhou) e o operador ainda não viu. */
  divergente_nao_visto: boolean;
}

/** Armazenamento da fila — IndexedDB no app, memória no teste. Toda escrita resolve no COMMIT. */
export interface ArmazemFila {
  todos(): Promise<ItemFila[]>;
  gravar(item: ItemFila): Promise<void>;
  /** Aloca o próximo `seq` e grava, atomicamente. Rejeita UUID repetido. */
  enfileirar(novo: Omit<ItemFila, "seq">): Promise<ItemFila>;
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
 * Motivos que significam "esta atribuição não vale mais": a captura tem de parar. `ausente_do_omie`
 * fica de fora de propósito: é temporário (o pedido pode voltar à etapa) e quem decide é a
 * releitura da tarefa (`ausente_rodadas`), não a rejeição histórica (Codex Fase 1 r2).
 */
export const MOTIVOS_PERDA_DE_AUTORIZACAO: ReadonlySet<string> = new Set([
  "atribuicao_antiga",
  "revisao_antiga",
  "tarefa_fora_de_separacao",
]);

/** Sentido da divergência entre a previsão local e o servidor — o aviso diz o que de fato houve. */
export type SentidoDivergencia = "recusada_apos_ok" | "aceita_apos_recusa" | "falhou";

export function sentidoDivergencia(item: ItemFila): SentidoDivergencia {
  if (item.estado === "falhou") return "falhou";
  return item.estado === "aceita" ? "aceita_apos_recusa" : "recusada_apos_ok";
}

/**
 * Próximos a enviar: o 1º `pendente` de cada tarefa, em ordem de `seq`, só do `operador`. Item
 * pendente de OUTRO operador na frente trava a tarefa (a ordem não pode ser furada).
 */
export function proximosEnvios(itens: ItemFila[], operador: string): ItemFila[] {
  const porTarefa = new Map<string, ItemFila | null>();
  for (const it of [...itens].sort((a, b) => a.seq - b.seq)) {
    if (it.estado !== "pendente") continue;
    const t = it.comando.tarefa_id;
    if (porTarefa.has(t)) continue;
    porTarefa.set(t, it.operador_id === operador ? it : null);
  }
  return [...porTarefa.values()].filter((i): i is ItemFila => i !== null);
}

/** Aplica o resultado de um envio ao item; transitório e `pendente` do servidor mantêm o item pendente. */
export function aplicarResultado(item: ItemFila, r: ResultadoEnvio): ItemFila {
  if (r.tipo === "transitorio") return { ...item, tentativas: item.tentativas + 1, motivo: r.erro };
  if (r.tipo === "permanente") {
    return { ...item, estado: "falhou", tentativas: item.tentativas + 1, motivo: r.erro, divergente_nao_visto: true };
  }
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
    divergente_nao_visto: (item.previsto !== null) !== res.ok,
  };
}

/** Espera antes da próxima tentativa: 1 s, 2 s, 4 s … até 30 s. */
export function backoffMs(tentativas: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, tentativas - 1));
}

/**
 * Todos os UUIDs emitidos numa atribuição — o que `picking_concluir` exige. Inclui rejeitadas (o
 * servidor as gravou). `prontas` só com todas respondidas; `falhou` impede concluir.
 * Chame com a fila RELIDA do armazém, nunca com um retrato de tela.
 */
export function leiturasDaAtribuicao(itens: ItemFila[], atribuicaoId: string): { ids: string[]; prontas: boolean } {
  const da = itens.filter((i) => i.comando.atribuicao_id === atribuicaoId).sort((a, b) => a.seq - b.seq);
  return {
    ids: da.map((i) => i.comando.leitura_id),
    prontas: da.every((i) => i.estado === "aceita" || i.estado === "rejeitada"),
  };
}

/**
 * Uma volta do laço de envio: manda o próximo de cada tarefa (em paralelo entre tarefas, em série
 * dentro da tarefa) e grava o resultado. Devolve os resolvidos e se houve transitório.
 */
export async function enviarRodada(
  armazem: ArmazemFila,
  enviar: (c: Comando) => Promise<ResultadoEnvio>,
  operador: string,
): Promise<{ resolvidos: ItemFila[]; transitorio: boolean; maxTentativas: number }> {
  const proximos = proximosEnvios(await armazem.todos(), operador);
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

function proximoSeq(itens: ItemFila[]): number {
  return itens.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
}

/** Armazém em memória — SÓ para teste (não é fallback: memória perde leitura no reload). */
export function armazemMemoria(inicial: ItemFila[] = []): ArmazemFila {
  const m = new Map(inicial.map((i) => [i.comando.leitura_id, i]));
  return {
    todos: () => Promise.resolve([...m.values()]),
    gravar: (i) => {
      m.set(i.comando.leitura_id, i);
      return Promise.resolve();
    },
    enfileirar: (novo) => {
      // Ler e gravar no mesmo tique: atômico no event loop.
      if (m.has(novo.comando.leitura_id)) return Promise.reject(new Error(`fila: leitura ${novo.comando.leitura_id} já enfileirada`));
      const item: ItemFila = { ...novo, seq: proximoSeq([...m.values()]) };
      m.set(item.comando.leitura_id, item);
      return Promise.resolve(item);
    },
  };
}

const DB = "picking-v2";
const STORE = "leituras";

/** Armazém IndexedDB: chave = `leitura_id`; toda escrita resolve no `oncomplete` da transação. */
export function abrirArmazemIndexedDB(): Promise<ArmazemFila> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = (ev) => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "comando.leitura_id" });
        return;
      }
      // v1 → v2: itens da versão anterior não têm dono. Ninguém pode enviá-los com segurança
      // (a identidade é desconhecida) e, pendentes, travariam a tarefa para sempre: viram falha
      // VISÍVEL, que impede concluir e manda chamar o supervisor (Codex Fase 1 r2).
      if (ev.oldVersion < 2 && req.transaction) {
        const cursor = req.transaction.objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const it = c.value as Partial<ItemFila>;
          if (!it.operador_id) {
            c.update({
              ...it,
              operador_id: "",
              estado: it.estado === "pendente" ? "falhou" : it.estado,
              motivo: it.estado === "pendente" ? "sem_dono_versao_anterior" : (it.motivo ?? null),
              divergente_nao_visto: it.estado === "pendente" ? true : (it.divergente_nao_visto ?? false),
            });
          }
          c.continue();
        };
      }
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB não abriu"));
    req.onsuccess = () => {
      const db = req.result;
      const transacao = <T,>(
        modo: IDBTransactionMode,
        corpo: (s: IDBObjectStore, fim: (v: T) => void, falha: (e: Error) => void) => void,
      ) =>
        new Promise<T>((res, rej) => {
          const tx = db.transaction(STORE, modo);
          let valor: T | undefined;
          let erro: Error | null = null;
          corpo(tx.objectStore(STORE), (v) => (valor = v), (e) => {
            erro = e;
            tx.abort();
          });
          tx.oncomplete = () => (erro ? rej(erro) : res(valor as T));
          tx.onerror = () => rej(erro ?? tx.error ?? new Error("IndexedDB: transação falhou"));
          tx.onabort = () => rej(erro ?? tx.error ?? new Error("IndexedDB: transação abortada"));
        });
      resolve({
        todos: () =>
          transacao<ItemFila[]>("readonly", (s, fim) => {
            const r = s.getAll();
            r.onsuccess = () => fim(r.result as ItemFila[]);
          }),
        gravar: (item) =>
          transacao<void>("readwrite", (s, fim) => {
            s.put(item);
            fim(undefined);
          }),
        enfileirar: (novo) =>
          transacao<ItemFila>("readwrite", (s, fim, falha) => {
            const r = s.getAll();
            r.onsuccess = () => {
              const itens = r.result as ItemFila[];
              if (itens.some((i) => i.comando.leitura_id === novo.comando.leitura_id)) {
                falha(new Error(`fila: leitura ${novo.comando.leitura_id} já enfileirada`));
                return;
              }
              const item: ItemFila = { ...novo, seq: proximoSeq(itens) };
              s.add(item);
              fim(item);
            };
          }),
      });
    };
  });
}
