// Feedback do bipe (picking v2): som + vibração em <50 ms, para o operador NÃO precisar olhar a
// tela quando deu certo. Sons sintetizados uma vez em AudioBuffers (sem arquivo, sem rede) no
// destravamento — o navegador só libera áudio depois de um toque (o de "pegar tarefa").

export type TipoFeedback =
  | "correta"
  | "linha_completa"
  | "pedido_completo"
  | "fora_do_pedido"
  | "excesso"
  | "desconhecido"
  | "duplicata"
  | "truncada"
  | "divergencia"
  | "falha_sync";

/** Nota: frequência (Hz) e duração (ms); `0` Hz = pausa. */
type Nota = readonly [number, number];

export interface Padrao {
  notas: readonly Nota[];
  /** `navigator.vibrate`: vibra/pausa/vibra… em ms. */
  vibracao: readonly number[];
  /** Cor de tela cheia na UI "olhar só se der erro". */
  cor: "verde" | "vermelho" | "ambar" | null;
}

const AGUDO = 2_400;
const GRAVE = 300;

export const PADROES: Record<TipoFeedback, Padrao> = {
  correta: { notas: [[AGUDO, 70]], vibracao: [40], cor: "verde" },
  linha_completa: { notas: [[1_800, 80], [2_600, 120]], vibracao: [40, 60, 40], cor: "verde" },
  pedido_completo: { notas: [[1_600, 100], [2_000, 100], [2_600, 220]], vibracao: [400], cor: "verde" },
  fora_do_pedido: { notas: [[GRAVE, 600]], vibracao: [400], cor: "vermelho" },
  excesso: { notas: [[GRAVE, 120], [0, 60], [GRAVE, 120], [0, 60], [GRAVE, 120]], vibracao: [80, 60, 80, 60, 80], cor: "ambar" },
  desconhecido: { notas: [[GRAVE, 150], [0, 200], [GRAVE, 150]], vibracao: [150, 200, 150], cor: "vermelho" },
  duplicata: { notas: [[900, 40]], vibracao: [], cor: null },
  truncada: { notas: [[600, 80], [0, 50], [600, 80]], vibracao: [60, 50, 60], cor: "ambar" },
  divergencia: { notas: [[1_200, 150], [500, 300]], vibracao: [200, 100, 200], cor: "vermelho" },
  falha_sync: { notas: [[700, 200]], vibracao: [100], cor: null },
};

/** Motivo de rejeição (servidor ou previsão) → feedback. Motivo desconhecido = vermelho. */
export function feedbackDoMotivo(motivo: string): TipoFeedback {
  switch (motivo) {
    case "codigo_fora_do_pedido":
    case "unidade_incompativel":
      return "fora_do_pedido";
    case "excesso":
      return "excesso";
    case "codigo_desconhecido":
    case "codigo_pendente_aprovacao":
    case "codigo_ambiguo":
      return "desconhecido";
    default:
      return "fora_do_pedido";
  }
}

const TAXA = 22_050;

function sintetizar(ctx: BaseAudioContext, notas: readonly Nota[]): AudioBuffer {
  const total = notas.reduce((s, [, ms]) => s + ms, 0);
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil((total / 1000) * TAXA)), TAXA);
  const dados = buf.getChannelData(0);
  let i = 0;
  for (const [hz, ms] of notas) {
    const n = Math.ceil((ms / 1000) * TAXA);
    for (let k = 0; k < n && i < dados.length; k++, i++) {
      // Envelope curto nas bordas para não estalar.
      const env = Math.min(1, k / 80, (n - k) / 80);
      dados[i] = hz === 0 ? 0 : 0.5 * env * Math.sin((2 * Math.PI * hz * k) / TAXA);
    }
  }
  return buf;
}

export interface Tocador {
  /** Chame dentro de um gesto do usuário (toque). Idempotente. */
  destravar(): void;
  tocar(tipo: TipoFeedback): void;
}

/** Tocador real: Web Audio + `navigator.vibrate`. Sem suporte → silencioso (a cor ainda aparece). */
export function criarTocador(): Tocador {
  let ctx: AudioContext | null = null;
  const buffers = new Map<TipoFeedback, AudioBuffer>();
  return {
    destravar() {
      if (ctx) {
        void ctx.resume();
        return;
      }
      const Ctor = typeof window !== "undefined" ? window.AudioContext : undefined;
      if (!Ctor) return;
      ctx = new Ctor();
      void ctx.resume();
      for (const [tipo, p] of Object.entries(PADROES) as [TipoFeedback, Padrao][]) buffers.set(tipo, sintetizar(ctx, p.notas));
    },
    tocar(tipo) {
      const p = PADROES[tipo];
      if (p.vibracao.length > 0 && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate([...p.vibracao]);
      }
      const buf = buffers.get(tipo);
      if (!ctx || !buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    },
  };
}
