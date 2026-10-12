// Motor da fila de leituras — UM por aba, fora do ciclo de vida dos componentes (Codex Fase 1):
// sair da tarefa, voltar à lista ou recarregar não interrompe o envio; a lente "Ver como" PAUSA
// (nada é enviado com a identidade errada, nem depois); só o usuário REAL envia as leituras que ele
// capturou; entre abas, o envio e as barreiras de concluir/falta passam pelo Web Locks.
//
// Identidade e lente são lidas do AMBIENTE a cada envio (sessão do Supabase e guard global da
// lente), nunca de uma configuração feita pela página (Codex Fase 1 r2): com a página desmontada,
// logout/login ou desligar a lente continuam valendo. Pausa é transitória — o laço volta sozinho.
import {
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
}

/** De onde o motor tira, NA HORA de cada envio, quem está logado e se a lente está ativa. */
export interface AmbienteMotor {
  sessao(): Promise<string | null>;
  lente(): boolean;
}

export interface Motor {
  estado(): EstadoMotor;
  assinar(o: Ouvinte): () => void;
  armazem(): ArmazemFila | null;
  recarregar(): Promise<ItemFila[]>;
  /** Pede um envio já (ex.: depois de enfileirar). */
  cutucar(): void;
  /** Envia até não sobrar pendente da tarefa ou cair em erro transitório. true = drenou. */
  drenar(tarefaId: string): Promise<boolean>;
}

export function criarMotor(
  /** Envia autenticado como `dono` — o transporte TEM de usar o token dessa sessão. */
  enviar: (c: Comando, dono: string) => Promise<ResultadoEnvio>,
  abrir: () => Promise<ArmazemFila>,
  aoResolver: (resolvidos: ItemFila[]) => void,
  ambiente: AmbienteMotor,
): Motor {
  let armazem: ArmazemFila | null = null;
  let est: EstadoMotor = { pronto: false, erroArmazem: null, itens: [] };
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

  /** Pausa (sem sessão ou sob a lente) volta como transitória: o laço tenta de novo sozinho. */
  const PAUSA = { transitorio: true, tentativas: 4, resolvidos: 0 } as const;

  async function rodada(): Promise<{ transitorio: boolean; tentativas: number; resolvidos: number }> {
    if (!armazem) return { transitorio: false, tentativas: 0, resolvidos: 0 };
    const a = armazem;
    const r = await comTrava("picking-v2-emissor", async () => {
      // Lido DENTRO da trava: a espera pelo Web Lock não pode envelhecer a identidade.
      const op = ambiente.lente() ? null : await ambiente.sessao();
      if (!op) return null;
      return enviarRodada(a, (c) => enviarSePermitido(c, op), op);
    });
    if (!r) return PAUSA;
    if (r.resolvidos.length) aoResolver(r.resolvidos);
    await recarregar();
    return { transitorio: r.transitorio, tentativas: r.maxTentativas, resolvidos: r.resolvidos.length };
  }

  /** A lente pode ter ligado (ou a sessão trocado) no meio da rodada: nada sai com outra identidade. */
  async function enviarSePermitido(c: Comando, dono: string): Promise<ResultadoEnvio> {
    if (ambiente.lente()) return { tipo: "transitorio", erro: "lente Ver como ativa — envio pausado" };
    if ((await ambiente.sessao()) !== dono) return { tipo: "transitorio", erro: "sessão de outro usuário — envio pausado" };
    return enviar(c, dono);
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
    armazem: () => armazem,
    recarregar,
    cutucar,
    async drenar(tarefaId) {
      for (let i = 0; i < 50; i++) {
        const pend = (await recarregar()).filter((x) => x.comando.tarefa_id === tarefaId && x.estado === "pendente");
        if (pend.length === 0) return true;
        const op = ambiente.lente() ? null : await ambiente.sessao();
        if (!op || pend.some((x) => x.operador_id !== op)) return false;
        const r = await rodada();
        if (r.transitorio) return false;
      }
      return false;
    },
  };
}

// Época da tarefa entre abas (Codex Fase 1 r2/r3): concluir/falta ABRE a barreira (época ímpar)
// e a FECHA (par) dentro da trava da tarefa, depois da RPC. Captura só com a barreira fechada; a
// captura feita numa época e gravada noutra (esperou a trava enquanto outra aba mudava a tarefa) é
// recusada. Barreira aberta há mais de BARREIRA_MAX_MS = aba que morreu no meio: não trava ninguém
// para sempre (a nova época ainda invalida as capturas antigas). Sem localStorage tudo fica em 0:
// vale só a trava + releitura da própria aba.
const chaveEpoca = (tarefaId: string) => `picking-v2:epoca:${tarefaId}`;
const BARREIRA_MAX_MS = 120_000;

export interface Epoca {
  n: number;
  aberta: boolean;
}

/** Época ímpar que ESTA aba já viu expirar, por tarefa: expirou, não reabre (Codex r6). */
const expiradas = new Map<string, number>();

export function lerEpoca(tarefaId: string, agora = Date.now()): Epoca {
  try {
    const [n, desde] = (localStorage.getItem(chaveEpoca(tarefaId)) ?? "0:0").split(":").map(Number);
    const num = Number.isInteger(n) && n > 0 ? n : 0;
    if (num % 2 === 0 || expiradas.get(tarefaId) === num) return { n: num, aberta: false };
    // Entre abas não há relógio monotônico comum: |diferença| limita a espera também quando a
    // hora do aparelho recua; vista expirada uma vez, a época fica expirada nesta aba.
    if (Math.abs(agora - (desde || 0)) < BARREIRA_MAX_MS) return { n: num, aberta: true };
    expiradas.set(tarefaId, num);
    return { n: num, aberta: false };
  } catch {
    return { n: 0, aberta: false };
  }
}

function gravarEpoca(tarefaId: string, n: number): Epoca {
  try {
    localStorage.setItem(chaveEpoca(tarefaId), `${n}:${Date.now()}`);
  } catch {
    // sem armazenamento local: ver comentário acima
  }
  return lerEpoca(tarefaId);
}

/** Abre a barreira: próxima época ímpar. */
export function abrirBarreira(tarefaId: string): Epoca {
  const { n } = lerEpoca(tarefaId);
  return gravarEpoca(tarefaId, n % 2 === 0 ? n + 1 : n + 2);
}

/** Fecha a barreira: próxima época par. */
export function fecharBarreira(tarefaId: string): Epoca {
  const { n } = lerEpoca(tarefaId);
  return gravarEpoca(tarefaId, n % 2 === 1 ? n + 1 : n + 2);
}

export const ehChaveEpoca = (chave: string | null, tarefaId: string) => chave === chaveEpoca(tarefaId);
