// Protocolo de leitura do leitor Zebra por teclado (DataWedge em KEYSTROKE) — PURO, sem DOM.
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §5 (desenho da Fase 1).
//
// O DataWedge envia: `~~` + AIM symbology id opcional (ex.: `]E0`) + código + ENTER.
// Sem heurística de velocidade de digitação: quem arma a captura é o prefixo `~~` (2º `~` em até
// `armarMs` do 1º); a leitura termina no ENTER; sem tecla nova por `truncarMs` = leitura TRUNCADA
// (descartada com aviso — nunca vira código parcial). O mesmo código de novo em até
// `duplicataMs` = double-decode do leitor, ignorado (unidade legítima exige 2 puxadas).
//
// Digitação manual NÃO passa por aqui: vai pelo campo dedicado. O único custo do protocolo para
// quem digita é um `~` isolado, que é engolido (na tela de separação não há texto livre).

export const PADRAO_PROTOCOLO = {
  armarMs: 50,
  truncarMs: 300,
  duplicataMs: 250,
  maxCaracteres: 80,
  /** Depois de truncada/estourada, o resto do quadro (inclusive o ENTER atrasado) é engolido
   *  por este tempo — não pode cair no campo focado nem acionar botão (Codex Fase 1 P2-12). */
  descarteMs: 1_000,
} as const;

export type OpcoesProtocolo = { [K in keyof typeof PADRAO_PROTOCOLO]: number };

const VALIDO = /^(\][A-Za-z0-9]{2})?[0-9A-Za-z\-.]{1,64}$/;

export type EstadoProtocolo =
  | { fase: "ocioso"; ultima: { codigo: string; t: number } | null }
  | { fase: "prefixo"; t0: number; ultima: { codigo: string; t: number } | null }
  | { fase: "capturando"; t0: number; tUltima: number; buffer: string; ultima: { codigo: string; t: number } | null }
  | { fase: "descartando"; ate: number; ultima: { codigo: string; t: number } | null };

export const ESTADO_INICIAL: EstadoProtocolo = { fase: "ocioso", ultima: null };

export type Entrada = { tipo: "tecla"; key: string; t: number } | { tipo: "tempo"; t: number };

export type Saida =
  /** Leitura completa e válida. `t0` = 1º `~` (para medir latência captura → feedback). */
  | { tipo: "leitura"; codigo: string; simbologia: string | null; t0: number; t: number }
  /** Faltou o ENTER: a leitura foi cortada no meio — descartada. */
  | { tipo: "truncada"; parcial: string; t: number }
  /** Mesmo código dentro da janela de double-decode — ignorado. */
  | { tipo: "duplicata"; codigo: string; t: number }
  /** Chegou o ENTER mas o conteúdo não é um código (caractere fora do alfabeto, vazio, longo). */
  | { tipo: "invalida"; bruto: string; t: number };

export interface Passo {
  estado: EstadoProtocolo;
  saidas: Saida[];
  /** A tecla pertence a uma leitura: quem captura deve impedir que ela chegue ao campo focado. */
  engolir: boolean;
}

/** Separa o AIM symbology id (`]E0`) do código. */
export function separarSimbologia(bruto: string): { codigo: string; simbologia: string | null } {
  return bruto.startsWith("]") && bruto.length > 3
    ? { simbologia: bruto.slice(0, 3), codigo: bruto.slice(3) }
    : { simbologia: null, codigo: bruto };
}

function concluir(
  estado: Extract<EstadoProtocolo, { fase: "capturando" }>,
  t: number,
  opts: OpcoesProtocolo,
): Passo {
  const bruto = estado.buffer;
  if (!VALIDO.test(bruto)) {
    return { estado: { fase: "ocioso", ultima: estado.ultima }, saidas: [{ tipo: "invalida", bruto, t }], engolir: true };
  }
  const { codigo, simbologia } = separarSimbologia(bruto);
  const u = estado.ultima;
  if (u && u.codigo === codigo && estado.t0 - u.t <= opts.duplicataMs) {
    // A janela conta do fim da leitura anterior ao início desta; a referência NÃO anda —
    // uma rajada de double-decodes não se estende indefinidamente.
    return { estado: { fase: "ocioso", ultima: u }, saidas: [{ tipo: "duplicata", codigo, t }], engolir: true };
  }
  return {
    estado: { fase: "ocioso", ultima: { codigo, t } },
    saidas: [{ tipo: "leitura", codigo, simbologia, t0: estado.t0, t }],
    engolir: true,
  };
}

/** Avança o relógio: vence o prefixo solto e trunca a captura sem ENTER. */
function vencer(estado: EstadoProtocolo, t: number, opts: OpcoesProtocolo): { estado: EstadoProtocolo; saidas: Saida[] } {
  if (estado.fase === "prefixo" && t - estado.t0 > opts.armarMs) {
    return { estado: { fase: "ocioso", ultima: estado.ultima }, saidas: [] };
  }
  if (estado.fase === "capturando" && t - estado.tUltima > opts.truncarMs) {
    return {
      estado: { fase: "descartando", ate: t + opts.descarteMs, ultima: estado.ultima },
      saidas: [{ tipo: "truncada", parcial: estado.buffer, t }],
    };
  }
  if (estado.fase === "descartando" && t >= estado.ate) {
    return { estado: { fase: "ocioso", ultima: estado.ultima }, saidas: [] };
  }
  return { estado, saidas: [] };
}

export function passo(estado: EstadoProtocolo, entrada: Entrada, opts: OpcoesProtocolo = PADRAO_PROTOCOLO): Passo {
  const v = vencer(estado, entrada.t, opts);
  if (entrada.tipo === "tempo") return { estado: v.estado, saidas: v.saidas, engolir: false };

  const e = v.estado;
  const { key, t } = entrada;
  switch (e.fase) {
    case "ocioso":
      if (key === "~") return { estado: { fase: "prefixo", t0: t, ultima: e.ultima }, saidas: v.saidas, engolir: true };
      return { estado: e, saidas: v.saidas, engolir: false };
    case "prefixo":
      if (key === "~") {
        return { estado: { fase: "capturando", t0: e.t0, tUltima: t, buffer: "", ultima: e.ultima }, saidas: v.saidas, engolir: true };
      }
      // Não era leitura: o `~` já foi engolido; a tecla atual segue para o campo.
      return { estado: { fase: "ocioso", ultima: e.ultima }, saidas: v.saidas, engolir: false };
    case "descartando":
      // Resto de um quadro cortado: engole até o ENTER dele (ou até o tempo vencer). Um `~` é o
      // começo de uma leitura NOVA.
      if (key === "~") return { estado: { fase: "prefixo", t0: t, ultima: e.ultima }, saidas: v.saidas, engolir: true };
      if (key === "Enter") return { estado: { fase: "ocioso", ultima: e.ultima }, saidas: v.saidas, engolir: true };
      return { estado: e, saidas: v.saidas, engolir: true };
    case "capturando": {
      if (key === "Enter") {
        const fim = concluir(e, t, opts);
        return { ...fim, saidas: [...v.saidas, ...fim.saidas] };
      }
      if (key.length !== 1) {
        // Shift e afins chegam entre os caracteres: não entram no código nem chegam ao campo.
        return { estado: { ...e, tUltima: t }, saidas: v.saidas, engolir: true };
      }
      const buffer = e.buffer + key;
      if (buffer.length > opts.maxCaracteres) {
        return {
          estado: { fase: "descartando", ate: t + opts.descarteMs, ultima: e.ultima },
          saidas: [...v.saidas, { tipo: "invalida", bruto: buffer, t }],
          engolir: true,
        };
      }
      return { estado: { ...e, tUltima: t, buffer }, saidas: v.saidas, engolir: true };
    }
  }
}

/** Quando o próximo `tempo` precisa chegar para vencer prefixo/captura; `null` = nada pendente. */
export function proximoVencimento(estado: EstadoProtocolo, opts: OpcoesProtocolo = PADRAO_PROTOCOLO): number | null {
  if (estado.fase === "prefixo") return estado.t0 + opts.armarMs + 1;
  if (estado.fase === "capturando") return estado.tUltima + opts.truncarMs + 1;
  if (estado.fase === "descartando") return estado.ate;
  return null;
}
