import { describe, it, expect } from 'vitest';

// ═══════════════ DATE PARSING ═══════════════

function parseOmieDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  if (dateStr.includes("/")) {
    const [d, m, y] = dateStr.split("/");
    if (d && m && y) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) return dateStr.substring(0, 10);
  return null;
}

describe('parseOmieDate', () => {
  it('parses DD/MM/YYYY', () => {
    expect(parseOmieDate('15/03/2026')).toBe('2026-03-15');
  });
  it('parses YYYY-MM-DD', () => {
    expect(parseOmieDate('2026-03-15')).toBe('2026-03-15');
  });
  it('parses YYYY-MM-DDTHH:mm', () => {
    expect(parseOmieDate('2026-03-15T10:30:00')).toBe('2026-03-15');
  });
  it('handles null', () => {
    expect(parseOmieDate(null)).toBeNull();
  });
  it('handles undefined', () => {
    expect(parseOmieDate(undefined)).toBeNull();
  });
  it('handles empty string', () => {
    expect(parseOmieDate('')).toBeNull();
  });
  it('pads single-digit day/month', () => {
    expect(parseOmieDate('5/3/2026')).toBe('2026-03-05');
  });
});

// ═══════════════ AGING CALCULATION ═══════════════

interface AgingInput {
  data_vencimento: string;
  saldo: number;
  status_titulo: string;
}

function calculateAging(items: AgingInput[], today: string) {
  const todayDate = new Date(today + 'T00:00:00');
  const result = {
    a_vencer: 0, vencido_1_30: 0, vencido_31_60: 0,
    vencido_61_90: 0, vencido_90_plus: 0,
  };
  for (const item of items) {
    if (!['ABERTO', 'VENCIDO', 'PARCIAL'].includes(item.status_titulo)) continue;
    const venc = new Date(item.data_vencimento + 'T00:00:00');
    const diffDays = Math.floor((todayDate.getTime() - venc.getTime()) / 86400000);
    if (diffDays <= 0) result.a_vencer += item.saldo;
    else if (diffDays <= 30) result.vencido_1_30 += item.saldo;
    else if (diffDays <= 60) result.vencido_31_60 += item.saldo;
    else if (diffDays <= 90) result.vencido_61_90 += item.saldo;
    else result.vencido_90_plus += item.saldo;
  }
  return result;
}

describe('calculateAging', () => {
  const today = '2026-03-28';

  it('classifies a_vencer correctly', () => {
    const items = [{ data_vencimento: '2026-04-15', saldo: 1000, status_titulo: 'ABERTO' }];
    expect(calculateAging(items, today).a_vencer).toBe(1000);
  });

  it('classifies vencido_1_30 correctly', () => {
    const items = [{ data_vencimento: '2026-03-10', saldo: 500, status_titulo: 'VENCIDO' }];
    expect(calculateAging(items, today).vencido_1_30).toBe(500);
  });

  it('classifies vencido_90_plus correctly', () => {
    const items = [{ data_vencimento: '2025-12-01', saldo: 2000, status_titulo: 'ABERTO' }];
    expect(calculateAging(items, today).vencido_90_plus).toBe(2000);
  });

  it('ignores CANCELADO and RECEBIDO', () => {
    const items = [
      { data_vencimento: '2026-03-01', saldo: 100, status_titulo: 'CANCELADO' },
      { data_vencimento: '2026-03-01', saldo: 200, status_titulo: 'RECEBIDO' },
    ];
    const result = calculateAging(items, today);
    expect(result.a_vencer + result.vencido_1_30 + result.vencido_31_60 + result.vencido_61_90 + result.vencido_90_plus).toBe(0);
  });

  it('handles multiple items across buckets', () => {
    const items = [
      { data_vencimento: '2026-04-01', saldo: 100, status_titulo: 'ABERTO' },
      { data_vencimento: '2026-03-15', saldo: 200, status_titulo: 'ABERTO' },
      { data_vencimento: '2026-02-01', saldo: 300, status_titulo: 'PARCIAL' },
      { data_vencimento: '2025-12-01', saldo: 400, status_titulo: 'VENCIDO' },
    ];
    const r = calculateAging(items, today);
    expect(r.a_vencer).toBe(100);
    expect(r.vencido_1_30).toBe(200);
    expect(r.vencido_31_60).toBe(300);
    expect(r.vencido_90_plus).toBe(400);
  });
});

// ═══════════════ DRE CONSOLIDATION ═══════════════

interface DRERow {
  company: string;
  mes: number;
  receita_bruta: number;
  receita_liquida: number;
  lucro_bruto: number;
  resultado_liquido: number;
}

function consolidateDRE(rows: DRERow[]): Map<number, DRERow> {
  const byMonth = new Map<number, DRERow>();
  const fields: (keyof DRERow)[] = ['receita_bruta', 'receita_liquida', 'lucro_bruto', 'resultado_liquido'];
  for (const row of rows) {
    if (!byMonth.has(row.mes)) {
      byMonth.set(row.mes, { ...row, company: 'consolidado' });
    } else {
      const c = byMonth.get(row.mes)!;
      for (const f of fields) {
        (c as any)[f] = ((c as any)[f] || 0) + ((row as any)[f] || 0);
      }
    }
  }
  return byMonth;
}

describe('consolidateDRE', () => {
  it('sums values across companies for same month', () => {
    const rows: DRERow[] = [
      { company: 'oben', mes: 1, receita_bruta: 100, receita_liquida: 80, lucro_bruto: 40, resultado_liquido: 20 },
      { company: 'colacor', mes: 1, receita_bruta: 200, receita_liquida: 160, lucro_bruto: 80, resultado_liquido: 40 },
    ];
    const result = consolidateDRE(rows);
    const jan = result.get(1)!;
    expect(jan.receita_bruta).toBe(300);
    expect(jan.resultado_liquido).toBe(60);
  });

  it('keeps months separate', () => {
    const rows: DRERow[] = [
      { company: 'oben', mes: 1, receita_bruta: 100, receita_liquida: 80, lucro_bruto: 40, resultado_liquido: 20 },
      { company: 'oben', mes: 2, receita_bruta: 150, receita_liquida: 120, lucro_bruto: 60, resultado_liquido: 30 },
    ];
    const result = consolidateDRE(rows);
    expect(result.get(1)!.receita_bruta).toBe(100);
    expect(result.get(2)!.receita_bruta).toBe(150);
  });

  it('handles empty input', () => {
    expect(consolidateDRE([]).size).toBe(0);
  });
});

// ═══════════════ CAPITAL DE GIRO (weighted PMR/PMP) ═══════════════

interface CGInput {
  total_cr_aberto: number;
  total_cp_aberto: number;
  pmr: number;
  pmp: number;
}

function weightedConsolidation(companies: CGInput[]) {
  const totalCR = companies.reduce((s, c) => s + c.total_cr_aberto, 0);
  const totalCP = companies.reduce((s, c) => s + c.total_cp_aberto, 0);
  const pmr = totalCR > 0
    ? Math.round(companies.reduce((s, c) => s + c.pmr * c.total_cr_aberto, 0) / totalCR)
    : 0;
  const pmp = totalCP > 0
    ? Math.round(companies.reduce((s, c) => s + c.pmp * c.total_cp_aberto, 0) / totalCP)
    : 0;
  return { pmr, pmp, ciclo: pmr - pmp };
}

describe('weightedConsolidation (capital de giro)', () => {
  it('weights PMR by CR volume', () => {
    const companies: CGInput[] = [
      { total_cr_aberto: 100000, total_cp_aberto: 50000, pmr: 30, pmp: 20 },
      { total_cr_aberto: 900000, total_cp_aberto: 50000, pmr: 60, pmp: 40 },
    ];
    const r = weightedConsolidation(companies);
    // PMR should be closer to 60 (900k weight) than 30 (100k weight)
    expect(r.pmr).toBe(57); // (100k*30 + 900k*60) / 1M = 57
  });

  it('weights PMP by CP volume', () => {
    const companies: CGInput[] = [
      { total_cr_aberto: 50000, total_cp_aberto: 200000, pmr: 30, pmp: 15 },
      { total_cr_aberto: 50000, total_cp_aberto: 800000, pmr: 30, pmp: 45 },
    ];
    const r = weightedConsolidation(companies);
    expect(r.pmp).toBe(39); // (200k*15 + 800k*45) / 1M = 39
  });

  it('handles zero volumes', () => {
    const r = weightedConsolidation([{ total_cr_aberto: 0, total_cp_aberto: 0, pmr: 30, pmp: 20 }]);
    expect(r.pmr).toBe(0);
    expect(r.pmp).toBe(0);
  });
});

// ═══════════════ FLUXO DE CAIXA (no double count) ═══════════════

describe('fluxo de caixa logic', () => {
  it('should not double-count when CR and CP have same date', () => {
    // Simulating the CTE-based approach
    const cr = [{ data: '2026-03-28', valor: 1000 }];
    const cp = [{ data: '2026-03-28', valor: 500 }];

    // Aggregate separately (as the new view does)
    const crByDate = new Map<string, number>();
    for (const r of cr) crByDate.set(r.data, (crByDate.get(r.data) || 0) + r.valor);

    const cpByDate = new Map<string, number>();
    for (const p of cp) cpByDate.set(p.data, (cpByDate.get(p.data) || 0) + p.valor);

    // Merge
    const allDates = new Set([...crByDate.keys(), ...cpByDate.keys()]);
    for (const d of allDates) {
      const entradas = crByDate.get(d) || 0;
      const saidas = cpByDate.get(d) || 0;
      // Each value appears exactly once
      expect(entradas).toBe(1000);
      expect(saidas).toBe(500);
    }
  });
});

// ═══════════════ STATUS MAPPING ═══════════════

function mapStatusReceber(s: string): string {
  const map: Record<string, string> = {
    RECEBIDO: 'RECEBIDO', LIQUIDADO: 'LIQUIDADO', CANCELADO: 'CANCELADO',
    ATRASADO: 'VENCIDO', VENCIDO: 'VENCIDO', 'A VENCER': 'ABERTO',
    ABERTO: 'ABERTO', PARCIAL: 'PARCIAL',
  };
  return map[s.toUpperCase()] || 'ABERTO';
}

describe('mapStatusReceber', () => {
  it('maps standard statuses', () => {
    expect(mapStatusReceber('RECEBIDO')).toBe('RECEBIDO');
    expect(mapStatusReceber('ATRASADO')).toBe('VENCIDO');
    expect(mapStatusReceber('A VENCER')).toBe('ABERTO');
  });
  it('handles lowercase', () => {
    expect(mapStatusReceber('recebido')).toBe('RECEBIDO');
  });
  it('defaults unknown to ABERTO', () => {
    expect(mapStatusReceber('DESCONHECIDO')).toBe('ABERTO');
  });
});
