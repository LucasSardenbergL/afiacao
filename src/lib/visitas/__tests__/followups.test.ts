import { describe, it, expect } from 'vitest';
import { montarFollowups, type VisitaFollowupRow } from '../followups';

const HOJE = '2026-06-04';
const vazio = { agendadasPendentes: new Set<string>(), ultimoContatoPorCliente: new Map<string, string>(), hojeISO: HOJE };

function visita(p: Partial<VisitaFollowupRow> & { customer_user_id: string; result: string | null; check_in_at: string }): VisitaFollowupRow {
  return { notes: null, visit_date: p.check_in_at.slice(0, 10), revenue_generated: null, ...p };
}

describe('montarFollowups', () => {
  it('usa a visita MAIS RECENTE por cliente, filtra mornos, aplica janela por-resultado', () => {
    const r = montarFollowups({
      ...vazio,
      visitas: [
        // C1: interesse 10d atrás, depois ausente 3d atrás → estado atual = ausente (3d ≤ 21) → incluído
        visita({ customer_user_id: 'C1', result: 'interesse', check_in_at: '2026-05-25T10:00:00Z' }),
        visita({ customer_user_id: 'C1', result: 'ausente', check_in_at: '2026-06-01T10:00:00Z', notes: 'portão fechado' }),
        // C2: pedido_fechado → não-morno → dropado
        visita({ customer_user_id: 'C2', result: 'pedido_fechado', check_in_at: '2026-06-02T10:00:00Z' }),
        // C3: reagendar 34d atrás → janela 45 → incluído
        visita({ customer_user_id: 'C3', result: 'reagendar', check_in_at: '2026-05-01T10:00:00Z' }),
        // C4: interesse 34d atrás → janela 30 → dropado (frio)
        visita({ customer_user_id: 'C4', result: 'interesse', check_in_at: '2026-05-01T10:00:00Z' }),
        // C5: ausente 25d atrás → janela 21 → dropado
        visita({ customer_user_id: 'C5', result: 'ausente', check_in_at: '2026-05-10T10:00:00Z' }),
      ],
    });
    expect(r.map((i) => i.customerUserId).sort()).toEqual(['C1', 'C3']);
    const c1 = r.find((i) => i.customerUserId === 'C1')!;
    expect(c1).toMatchObject({ result: 'ausente', diasDesde: 3, notes: 'portão fechado' });
  });

  it('de-dup: dropa cliente com visita agendada pendente, ou contatado APÓS a visita (mas não ANTES)', () => {
    const r = montarFollowups({
      hojeISO: HOJE,
      agendadasPendentes: new Set(['C6']),
      ultimoContatoPorCliente: new Map([
        ['C7', '2026-06-03T09:00:00Z'], // contato 1d DEPOIS da visita → dropa
        ['C8', '2026-06-01T09:00:00Z'], // contato ANTES da visita → mantém
      ]),
      visitas: [
        visita({ customer_user_id: 'C6', result: 'reagendar', check_in_at: '2026-06-03T10:00:00Z' }),
        visita({ customer_user_id: 'C7', result: 'interesse', check_in_at: '2026-06-02T10:00:00Z' }),
        visita({ customer_user_id: 'C8', result: 'interesse', check_in_at: '2026-06-02T10:00:00Z' }),
      ],
    });
    expect(r.map((i) => i.customerUserId)).toEqual(['C8']);
  });

  it('ordena reagendar > interesse > ausente; dentro de cada, mais recente primeiro', () => {
    const r = montarFollowups({
      ...vazio,
      visitas: [
        visita({ customer_user_id: 'AUS', result: 'ausente', check_in_at: '2026-06-01T10:00:00Z' }),   // 3d
        visita({ customer_user_id: 'REAG_VELHO', result: 'reagendar', check_in_at: '2026-05-01T10:00:00Z' }), // 34d
        visita({ customer_user_id: 'INT', result: 'interesse', check_in_at: '2026-06-03T10:00:00Z' }),  // 1d
        visita({ customer_user_id: 'REAG_NOVO', result: 'reagendar', check_in_at: '2026-05-30T10:00:00Z' }), // 5d
      ],
    });
    expect(r.map((i) => i.customerUserId)).toEqual(['REAG_NOVO', 'REAG_VELHO', 'INT', 'AUS']);
  });

  it('lista vazia → []', () => {
    expect(montarFollowups({ ...vazio, visitas: [] })).toEqual([]);
  });
});
