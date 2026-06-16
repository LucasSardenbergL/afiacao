// src/lib/fila/telemetria.ts
// Helpers puros de instrumentação da fila. fila.exibida deve ser logada 1×/dia
// (não por render) — Codex P2. A persistência é injetada (Storage) p/ testar puro.
import type { AcaoSugerida, FonteAcao } from './types';

export function chaveDiaExibida(dia: string): string {
  return `fila_exibida_${dia}`;
}

/** Marca a chave no storage; retorna true só na 1ª vez (idempotente, fail-safe). */
export function marcarSeNovoNoDia(chave: string, storage: Storage): boolean {
  try {
    if (storage.getItem(chave)) return false;
    storage.setItem(chave, '1');
    return true;
  } catch {
    return false; // storage indisponível (modo privado etc.) → não loga, não quebra
  }
}

/** Conta ações por fonte (p/ o payload do evento fila.exibida). */
export function resumoFontes(acoes: AcaoSugerida[]): Partial<Record<FonteAcao, number>> {
  const out: Partial<Record<FonteAcao, number>> = {};
  for (const a of acoes) out[a.fonte] = (out[a.fonte] ?? 0) + 1;
  return out;
}
