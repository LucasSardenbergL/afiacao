import { CityKey } from './route-city';

export interface ContactCandidate {
  customerUserId: string;
  farmerId: string | null;          // dono (vendedora) p/ agrupar a fila
  cityKey: CityKey;
  pConverte: number;                // [0,1] proxy do score (visit/churn normalizado)
  ticketEsperado: number;           // R$ (ticket_medio_90d / fallback de carteira)
  margemPerc: number;               // [0,1]
  diasDesdeUltima: number | null;
  intervaloMedioDias: number | null;
  isColdStart: boolean;
  optOut: boolean;
  contatadoHaDias: number | null;   // dias desde o último contato proativo (route_contact_log)
  fechouHoje: boolean;
  janela24hAberta: boolean;
  margemNegativaConhecida: boolean; // cockpit de valor (v1: false)
}

/** prontidão de recompra ∈ [0,1] a partir de dias/intervalo. v1: linear até o ciclo, satura em 1. */
export function prontidaoRecompra(diasDesdeUltima: number | null, intervaloMedio: number | null): number {
  if (diasDesdeUltima == null || intervaloMedio == null || intervaloMedio <= 0) return 0.5; // neutro
  const ratio = diasDesdeUltima / intervaloMedio;
  if (ratio >= 1) return 1;
  if (ratio <= 0.2) return 0.2;
  return ratio; // mapeia [0.2,1] → [0.2,1] linear
}

export function valorDaLigacao(c: ContactCandidate): number {
  const pront = prontidaoRecompra(c.diasDesdeUltima, c.intervaloMedioDias);
  return c.pConverte * c.ticketEsperado * c.margemPerc * pront;
}

export interface ContactConfig {
  winBackReservaPct: number;  // 0.20 → piso de slots p/ win-back
  coldStartPisoDia: number;   // piso de slots p/ novos clientes
  capacidadeLigacoes: number; // quantos cabem no dia (v1: contagem; codex → tempo)
  cadenciaMinDias: number;    // piso absoluto entre contatos proativos
}
export type Bucket = 'top' | 'winback' | 'coldstart';
export interface ScoredCandidate extends ContactCandidate {
  valorDaLigacao: number;
  prontidao: number;
  motivoGate: string | null;     // null = passou
  bucket: Bucket | null;
}
export interface ContactListResult {
  callQueue: ScoredCandidate[];     // ligação (vendedora), ordenada, capada, com reservas
  whatsappQueue: ScoredCandidate[]; // accept-a-proposal (IA)
  excluidos: ScoredCandidate[];     // com motivoGate
}

const LIMIAR_PRONTIDAO_BAIXA = 0.3;
const LIMIAR_P_BAIXA = 0.3;
const LIMIAR_WINBACK = 1.5; // dias/intervalo >= 1.5 → cliente sumindo/churn

function score(c: ContactCandidate): ScoredCandidate {
  return {
    ...c,
    valorDaLigacao: valorDaLigacao(c),
    prontidao: prontidaoRecompra(c.diasDesdeUltima, c.intervaloMedioDias),
    motivoGate: null,
    bucket: null,
  };
}

function gate(s: ScoredCandidate, cfg: ContactConfig): string | null {
  if (s.optOut) return 'opt_out';
  if (s.fechouHoje) return 'fechou_hoje';
  if (s.margemNegativaConhecida) return 'margem_negativa';
  if (s.valorDaLigacao <= 0) return 'valor_nao_paga';
  if (s.contatadoHaDias != null && s.contatadoHaDias < cfg.cadenciaMinDias) return 'cadencia';
  if (s.prontidao <= LIMIAR_PRONTIDAO_BAIXA && s.pConverte <= LIMIAR_P_BAIXA) return 'jit_prematuro';
  return null;
}

function isWinback(s: ScoredCandidate): boolean {
  if (s.diasDesdeUltima == null || s.intervaloMedioDias == null || s.intervaloMedioDias <= 0) return false;
  return s.diasDesdeUltima / s.intervaloMedioDias >= LIMIAR_WINBACK;
}

export function buildContactList(candidates: ContactCandidate[], cfg: ContactConfig): ContactListResult {
  const scored = candidates.map(score);
  const excluidos: ScoredCandidate[] = [];
  const vivos: ScoredCandidate[] = [];
  for (const s of scored) {
    const m = gate(s, cfg);
    if (m) { excluidos.push({ ...s, motivoGate: m }); } else { vivos.push(s); }
  }
  vivos.sort((a, b) => b.valorDaLigacao - a.valorDaLigacao);

  // --- callQueue com reservas (piso) aplicadas ANTES do corte por capacidade ---
  const cap = Math.max(0, Math.floor(cfg.capacidadeLigacoes));
  const winbackSlots = Math.round(cap * cfg.winBackReservaPct);
  const usados = new Set<string>();
  const pick = (pool: ScoredCandidate[], n: number, bucket: Bucket): ScoredCandidate[] => {
    const out: ScoredCandidate[] = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (usados.has(c.customerUserId)) continue;
      usados.add(c.customerUserId);
      out.push({ ...c, bucket });
    }
    return out;
  };

  const coldPool = vivos.filter(s => s.isColdStart);
  const cold = pick(coldPool, Math.min(cfg.coldStartPisoDia, cap), 'coldstart');
  const winbackPool = vivos.filter(isWinback).sort((a, b) =>
    (b.diasDesdeUltima! / b.intervaloMedioDias!) - (a.diasDesdeUltima! / a.intervaloMedioDias!));
  const winback = pick(winbackPool, Math.min(winbackSlots, cap - cold.length), 'winback');
  const top = pick(vivos, cap - cold.length - winback.length, 'top'); // vivos já ordenado por valor

  const callQueue = [...top, ...winback, ...cold]; // top primeiro; reservas garantidas

  // --- whatsappQueue (accept-a-proposal): recompra previsível; fora cold-start/sem-hist/janela aberta ---
  const whatsappQueue = vivos.filter(s => !s.isColdStart && s.intervaloMedioDias != null && !s.janela24hAberta);

  return { callQueue, whatsappQueue, excluidos };
}
