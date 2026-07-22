// Dia operacional do negócio (BRT), para janelas de idempotência.
//
// Lógica PURA extraída para caber no `--no-remote` do `test:edges`.
// Testes em dia-operacional_test.ts.
//
// POR QUE EXISTE — incidente 2026-07-21/22. A idempotência do generate-tactical-plan
// perguntava "já gerei hoje?" com `created_at >= 00:00 UTC`. Mas o dia de quem usa o
// sistema é BRT (UTC-3): duas execuções no MESMO dia 21 para o negócio (19:03 e 22:48
// BRT) caíram em dias UTC diferentes → a trava não pegou → 30 clientes com 2 planos.
//
// A janela UTC erra nos DOIS sentidos, não só um:
//   - run às 22:48 BRT do dia D    → não pula o que gerou às 19:03 → DUPLICATA
//   - cron às 05:00 BRT do dia D+1 → pula por causa do run da véspera → DIA SEM PLANO
//
// É a mesma classe do #1510 (schedule de pg_cron lido como BRT quando é UTC): o fuso
// entra em silêncio, o CI não vê, e o erro só aparece como dado estranho semanas depois.

/** BRT = UTC−3. Fixo: o Brasil não observa horário de verão desde 2019 (Decreto 9.772/2019). */
const OFFSET_BRT_MS = 3 * 60 * 60 * 1000;

/**
 * Instante UTC correspondente a 00:00 BRT do dia operacional que contém `agora`.
 *
 * Serve como limite inferior de janelas "já fiz isso hoje?" — use com `>=`.
 * `agora` é parâmetro (não Date.now() interno) para o comportamento ser testável
 * sem depender do relógio da máquina.
 */
export function inicioDiaOperacional(agora: Date): string {
  // Desloca para o "calendário BRT", trunca no dia, e volta para UTC.
  const emBrt = new Date(agora.getTime() - OFFSET_BRT_MS);
  const diaBrt = emBrt.toISOString().slice(0, 10); // YYYY-MM-DD no calendário BRT
  return new Date(new Date(`${diaBrt}T00:00:00Z`).getTime() + OFFSET_BRT_MS).toISOString();
}
