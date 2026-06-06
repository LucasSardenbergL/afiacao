// src/lib/caca/telemetria.ts
// Helpers puros de instrumentação da fila de caça (Frente B).
// `caca.exibida` deve ser logada 1×/dia (não por render) — espelha o padrão da
// fila da Frente A. O dedupe por dia reusa `marcarSeNovoNoDia` de lib/fila/telemetria
// (helper genérico chave+Storage). Aqui ficam só a chave e o resumo por sabor.
import type { CacaCandidatoDisplay, SaborCaca } from './types';

export function chaveDiaExibidaCaca(dia: string): string {
  return `caca_exibida_${dia}`;
}

/** Conta candidatos por sabor (p/ o payload do evento caca.exibida). */
export function resumoSabores(
  candidatos: CacaCandidatoDisplay[],
): Partial<Record<SaborCaca, number>> {
  const out: Partial<Record<SaborCaca, number>> = {};
  for (const c of candidatos) out[c.sabor] = (out[c.sabor] ?? 0) + 1;
  return out;
}
