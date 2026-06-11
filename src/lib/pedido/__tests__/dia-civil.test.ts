import { describe, it, expect } from 'vitest';
import { endOfDay, format, startOfDay } from 'date-fns';
import { janelaQueryDiaCivil, pedidoNoDiaCivil, horaExibicaoPedido } from '../dia-civil';

// Convenção dos cenários (TZ-agnóstico — roda igual em BRT local e UTC do CI):
// - pedido do SYNC Omie: created_at data-pura = meia-noite UTC exata (ISO com Z);
// - pedido do WIZARD: created_at real construído em hora LOCAL via new Date(y,m,d,h,min).
const dia09 = new Date(2026, 5, 9);
const dia10 = new Date(2026, 5, 10);
const dia11 = new Date(2026, 5, 11);

describe('janelaQueryDiaCivil', () => {
  it('cobre a união dos dois regimes: sync (meia-noite UTC) e wizard (bordas do dia local)', () => {
    const { inicioIso, fimIso } = janelaQueryDiaCivil(dia10);
    const dentro = (iso: string) => inicioIso <= iso && iso <= fimIso;

    // Pedido do sync de 10/06 (era o bug: ficava FORA da janela local em BRT)
    expect(dentro('2026-06-10T00:00:00.000Z')).toBe(true);
    // Pedidos do wizard nas bordas do dia local
    expect(dentro(new Date(2026, 5, 10, 0, 1).toISOString())).toBe(true);
    expect(dentro(new Date(2026, 5, 10, 23, 59).toISOString())).toBe(true);
  });

  it('é exatamente [min(início local, início UTC), max(fim local, fim UTC)] — sem folga além da necessária', () => {
    const { inicioIso, fimIso } = janelaQueryDiaCivil(dia10);
    const inicioUtc = Date.UTC(2026, 5, 10, 0, 0, 0, 0);
    const fimUtc = Date.UTC(2026, 5, 10, 23, 59, 59, 999);
    expect(inicioIso).toBe(new Date(Math.min(startOfDay(dia10).getTime(), inicioUtc)).toISOString());
    expect(fimIso).toBe(new Date(Math.max(endOfDay(dia10).getTime(), fimUtc)).toISOString());
  });
});

describe('pedidoNoDiaCivil', () => {
  it('pedido do sync de hoje (meia-noite UTC) aparece HOJE — não no dia anterior', () => {
    const syncHoje = '2026-06-10T00:00:00.000Z';
    expect(pedidoNoDiaCivil(syncHoje, dia10)).toBe(true);
    // Era o bug: em BRT esse instante é 09/06 21:00 local e caía na lista de ontem
    expect(pedidoNoDiaCivil(syncHoje, dia09)).toBe(false);
    expect(pedidoNoDiaCivil(syncHoje, dia11)).toBe(false);
  });

  it('pedido do wizard às 23h30 local não vaza pro dia seguinte', () => {
    const wizardNoite = new Date(2026, 5, 10, 23, 30).toISOString();
    expect(pedidoNoDiaCivil(wizardNoite, dia10)).toBe(true);
    // Em BRT esse instante entra na JANELA DE QUERY do dia 11 (overlap da união) —
    // é este re-filtro client-side que impede a duplicação.
    expect(pedidoNoDiaCivil(wizardNoite, dia11)).toBe(false);
  });

  it('sem duplicação na borda: cada pedido pertence a exatamente 1 dia civil', () => {
    const pedidos = [
      '2026-06-10T00:00:00.000Z', // sync de 10/06
      '2026-06-11T00:00:00.000Z', // sync de 11/06 (entra na janela de query do dia 10 em BRT)
      new Date(2026, 5, 10, 23, 30).toISOString(), // wizard noite de 10/06
      new Date(2026, 5, 11, 0, 5).toISOString(), // wizard madrugada de 11/06
    ];
    const dias = [dia09, dia10, dia11, new Date(2026, 5, 12)];
    for (const createdAt of pedidos) {
      const aparicoes = dias.filter(d => pedidoNoDiaCivil(createdAt, d)).length;
      expect(aparicoes).toBe(1);
    }
  });

  it('created_at inválido → false (não polui nenhuma lista)', () => {
    expect(pedidoNoDiaCivil('lixo', dia10)).toBe(false);
    expect(pedidoNoDiaCivil('', dia10)).toBe(false);
  });
});

describe('horaExibicaoPedido', () => {
  it('data-pura do sync → "—" (não existe hora real; HH:mm local fabricaria "21:00")', () => {
    expect(horaExibicaoPedido('2026-06-10T00:00:00.000Z')).toBe('—');
  });

  it('timestamp real do wizard → HH:mm local (comportamento atual preservado)', () => {
    const iso = new Date(2026, 5, 10, 9, 30).toISOString();
    expect(horaExibicaoPedido(iso)).toBe(format(new Date(iso), 'HH:mm'));
  });

  it('entrada inválida → "—"', () => {
    expect(horaExibicaoPedido('lixo')).toBe('—');
  });
});
