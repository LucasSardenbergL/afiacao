import { describe, it, expect } from 'vitest';
import { janelaQueryDiaCivil } from '@/lib/pedido/dia-civil';
import { agregarVendasPorDiaCivil, janelaQueryHojeOntem } from '../vendas-dia-civil';

// Convenção dos cenários (TZ-agnóstico — roda igual em BRT local e UTC do CI):
// - pedido do SYNC Omie: created_at data-pura = meia-noite UTC exata (ISO com Z);
// - pedido do WIZARD: created_at real construído em hora LOCAL via new Date(y,m,d,h,min).
// "hoje" com hora do meio do dia: o hook chama com new Date() ao vivo, nunca à meia-noite.
const hoje = new Date(2026, 5, 10, 14, 30);
const dia09 = new Date(2026, 5, 9);
const dia10 = new Date(2026, 5, 10);

describe('janelaQueryHojeOntem', () => {
  it('é a união exata das janelas de dia civil de ONTEM e de HOJE', () => {
    const { inicioIso, fimIso } = janelaQueryHojeOntem(hoje);
    expect(inicioIso).toBe(janelaQueryDiaCivil(dia09).inicioIso);
    expect(fimIso).toBe(janelaQueryDiaCivil(dia10).fimIso);
  });

  it('contém os pedidos do sync (meia-noite UTC) de ontem e de hoje + as bordas locais dos 2 dias', () => {
    const { inicioIso, fimIso } = janelaQueryHojeOntem(hoje);
    const dentro = (iso: string) => inicioIso <= iso && iso <= fimIso;
    expect(dentro('2026-06-09T00:00:00.000Z')).toBe(true); // sync de ontem (era o bug: fora da janela local em BRT)
    expect(dentro('2026-06-10T00:00:00.000Z')).toBe(true); // sync de hoje
    expect(dentro(new Date(2026, 5, 9, 0, 1).toISOString())).toBe(true); // wizard abertura de ontem
    expect(dentro(new Date(2026, 5, 10, 23, 59).toISOString())).toBe(true); // wizard fechamento de hoje
  });

  it('atravessa virada de mês: hoje = dia 1º → ontem = último dia do mês anterior', () => {
    const primeiroJulho = new Date(2026, 6, 1, 9, 0);
    const { inicioIso, fimIso } = janelaQueryHojeOntem(primeiroJulho);
    expect(inicioIso).toBe(janelaQueryDiaCivil(new Date(2026, 5, 30)).inicioIso);
    expect(fimIso).toBe(janelaQueryDiaCivil(new Date(2026, 6, 1)).fimIso);
  });
});

describe('agregarVendasPorDiaCivil', () => {
  it('pedido do sync de HOJE (meia-noite UTC) conta em HOJE — não infla ontem (o bug do cockpit)', () => {
    const agg = agregarVendasPorDiaCivil(
      [{ created_at: '2026-06-10T00:00:00.000Z', total: 1500 }],
      hoje,
    );
    expect(agg).toEqual({ faturadoHoje: 1500, pedidosHoje: 1, faturadoOntem: 0 });
  });

  it('pedido do sync de ONTEM conta em faturadoOntem e não em hoje', () => {
    const agg = agregarVendasPorDiaCivil(
      [{ created_at: '2026-06-09T00:00:00.000Z', total: 700 }],
      hoje,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 700 });
  });

  it('wizard de hoje conta hoje; wizard de ontem à noite conta ontem (mesmo caindo no dia UTC de hoje em BRT)', () => {
    const agg = agregarVendasPorDiaCivil(
      [
        { created_at: new Date(2026, 5, 10, 9, 15).toISOString(), total: 200 },
        { created_at: new Date(2026, 5, 9, 23, 30).toISOString(), total: 50 },
      ],
      hoje,
    );
    expect(agg).toEqual({ faturadoHoje: 200, pedidosHoje: 1, faturadoOntem: 50 });
  });

  it('fora dos 2 dias (anteontem, amanhã) não conta em nenhum — mesmo que a janela larga os traga', () => {
    const agg = agregarVendasPorDiaCivil(
      [
        { created_at: '2026-06-08T00:00:00.000Z', total: 999 }, // sync anteontem
        { created_at: '2026-06-11T00:00:00.000Z', total: 999 }, // sync amanhã (entra na janela de query em BRT)
        { created_at: new Date(2026, 5, 8, 10, 0).toISOString(), total: 999 }, // wizard anteontem
      ],
      hoje,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 0 });
  });

  it('cada pedido conta em exatamente 1 dia: Σ(hoje+ontem) nunca duplica um pedido da borda', () => {
    const rows = [
      { created_at: '2026-06-09T00:00:00.000Z', total: 100 }, // sync ontem
      { created_at: '2026-06-10T00:00:00.000Z', total: 100 }, // sync hoje
      { created_at: new Date(2026, 5, 9, 23, 59).toISOString(), total: 100 }, // wizard borda ontem
      { created_at: new Date(2026, 5, 10, 0, 1).toISOString(), total: 100 }, // wizard borda hoje
    ];
    const agg = agregarVendasPorDiaCivil(rows, hoje);
    expect(agg.faturadoHoje + agg.faturadoOntem).toBe(400);
    expect(agg).toEqual({ faturadoHoje: 200, pedidosHoje: 2, faturadoOntem: 200 });
  });

  it('total como string numérica (numeric do Postgres) e null/ausente somam como o hook antigo', () => {
    const agg = agregarVendasPorDiaCivil(
      [
        { created_at: '2026-06-10T00:00:00.000Z', total: '150.5' },
        { created_at: '2026-06-10T00:00:00.000Z', total: null },
        { created_at: '2026-06-10T00:00:00.000Z' },
      ],
      hoje,
    );
    expect(agg).toEqual({ faturadoHoje: 150.5, pedidosHoje: 3, faturadoOntem: 0 });
  });

  it('created_at inválido não conta em dia nenhum', () => {
    const agg = agregarVendasPorDiaCivil([{ created_at: 'lixo', total: 100 }], hoje);
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 0 });
  });
});
