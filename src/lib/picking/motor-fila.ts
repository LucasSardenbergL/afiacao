// Motor da fila de leituras — UM por aba, fora do ciclo de vida dos componentes (Codex Fase 1):
// sair da tarefa, voltar à lista ou recarregar não interrompe o envio; a lente "Ver como" PAUSA
// (nada é enviado com a identidade errada, nem depois); só o usuário REAL envia as leituras que ele
// capturou; entre abas, o envio e as barreiras de concluir/falta passam pelo Web Locks.
import {
  abrirArmazemIndexedDB,
  type ArmazemFila,
  backoffMs,
  type Comando,
  enviarRodada,
  type ItemFila,
  type ResultadoEnvio,
} from "./scanner/fila";

type Ouvinte = () => void;

interface Locks {
  request<T>(nome: string, opts: { mode?: "exclusive" | "shared"; ifAvailable?: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T>;
}

function locks(): Locks | null {
  const n = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: Locks }).locks : undefined;
  return n ?? null;
}

/** Exclusivo por nome entre abas (Web Locks); sem suporte, roda direto (a fila já é atômica). */
export async function comTrava<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  const l = locks();
  return l ? l.request(nome, { mode: "exclusive" }, () => fn()) : fn();
}

export const travaDaTarefa = (tarefaId: string) => `picking-v2-tarefa:${tarefaId}`;

interface EstadoMotor {
  pronto: boolean;
  erroArmazem: string | null;
  itens: ItemFila[];
  pausado: boolean;
}

export interface Motor {
  estado(): EstadoMotor;
  assinar(o: Ouvinte): () => void;
  /** Identidade real e se a lente está ativa. Chamar a cada render da página. */
  configurar(operador: string | null, lente: boolean): void;
  armazem(): ArmazemFila | null;
  recarregar(): Promise<ItemFila[]>;
  /** Pede um envio já (ex.: depois de enfileirar). */
  cutucar(): void;
  /** Envia até não sobrar pendente da tarefa ou cair em erro transitório. true = drenou. */
  drenar(tarefaId: string): Promise<boolean>;
}

export function criarMotor(
  enviar: (c: Comando) => Promise<ResultadoEnvio>,
  abrir: () => Promise<ArmazemFila> = abrirArmazemIndexedDB,
  aoResolver: (resolvidos: ItemFila[]) => void = () => {},
): Motor {
  let armazem: ArmazemFila | null = null;
  let est: EstadoMotor = { pronto: false, erroArmazem: null, itens: [], pausado: true };
  let operador: string | null = null;
  let lente = false;
  let rodando = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ouvintes = new Set<Ouvinte>();
  const avisar = () => ouvintes.forEach((o) => o());
  const set = (p: Partial<EstadoMotor>) => {
    est = { ...est, ...p };
    avisar();
  };

  void abrir().then(
    async (a) => {
      armazem = a;
      set({ pronto: true, itens: await a.todos() });
      cutucar();
    },
    (e: unknown) => set({ erroArmazem: e instanceof Error ? e.message : String(e) }),
  );

  async function recarregar(): Promise<ItemFila[]> {
    if (!armazem) return [];
    const itens = await armazem.todos();
    set({ itens });
    return itens;
  }

  async function rodada(): Promise<{ transitorio: boolean; tentativas: number; resolvidos: number }> {
    if (!armazem || !operador || lente) return { transitorio: false, tentativas: 0, resolvidos: 0 };
    const a = armazem;
    const op = operador;
    const r = await comTrava("picking-v2-emissor", () => enviarRodada(a, enviarSePermitido, op));
    if (r.resolvidos.length) aoResolver(r.resolvidos);
    await recarregar();
    return { transitorio: r.transitorio, tentativas: r.maxTentativas, resolvidos: r.resolvidos.length };
  }

  /** A lente pode ter ligado no meio de uma rodada: nada sai com ela ativa. */
  function enviarSePermitido(c: Comando): Promise<ResultadoEnvio> {
    if (lente) return Promise.resolve({ tipo: "transitorio", erro: "lente Ver como ativa — envio pausado" });
    return enviar(c);
  }

  async function laco() {
    if (rodando) return;
    rodando = true;
    try {
      for (;;) {
        const r = await rodada();
        if (r.transitorio) {
          timer = setTimeout(() => {
            timer = null;
            void laco();
          }, backoffMs(r.tentativas));
          return;
        }
        if (r.resolvidos === 0) return;
      }
    } catch {
      timer = setTimeout(() => {
        timer = null;
        void laco();
      }, 5_000);
    } finally {
      rodando = false;
    }
  }

  function cutucar() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void laco();
  }

  if (typeof window !== "undefined") window.addEventListener("online", () => cutucar());

  return {
    estado: () => est,
    assinar: (o) => {
      ouvintes.add(o);
      return () => ouvintes.delete(o);
    },
    configurar(op, comLente) {
      const mudou = op !== operador || comLente !== lente;
      operador = op;
      lente = comLente;
      if (mudou) {
        set({ pausado: !op || comLente });
        if (op && !comLente) cutucar();
      }
    },
    armazem: () => armazem,
    recarregar,
    cutucar,
    async drenar(tarefaId) {
      for (let i = 0; i < 50; i++) {
        const pend = (await recarregar()).filter((x) => x.comando.tarefa_id === tarefaId && x.estado === "pendente");
        if (pend.length === 0) return true;
        if (!operador || lente || pend.some((x) => x.operador_id !== operador)) return false;
        const r = await rodada();
        if (r.transitorio) return false;
      }
      return false;
    },
  };
}
