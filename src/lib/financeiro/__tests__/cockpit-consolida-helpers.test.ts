import { describe, it, expect } from 'vitest';
import { consolidarCockpit, compararCaixaInicial, parseSnapshotSemanas, type SnapshotEmpresa } from '../cockpit-consolida-helpers';

const sem = (inicio: string, ent: number, sai: number, saldo: number, saldo_inicial: number | null = null) =>
  ({ inicio, total_entradas: ent, total_saidas: sai, saldo_final: saldo, saldo_inicial });
const snap = (company: string, at: string, ncg: number | null, semanas: ReturnType<typeof sem>[], saldo_tes: number | null = 0): SnapshotEmpresa =>
  ({ company, snapshot_at: at, ncg, saldo_tesouraria: saldo_tes, semanas });
const ESP = ['oben', 'colacor', 'colacor_sc'];

describe('consolidarCockpit', () => {
  it('consolida 3 empresas mesma data: soma por semana + NCG; completa=true; não parcial', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 5, 105), sem('2026-06-02', 20, 5, 120)], 50),
      snap('colacor', '2026-05-27T10:01:00Z', 200, [sem('2026-05-26', 30, 10, 220), sem('2026-06-02', 0, 0, 220)], 80),
      snap('colacor_sc', '2026-05-27T10:02:00Z', 50, [sem('2026-05-26', 5, 1, 54), sem('2026-06-02', 5, 1, 58)], 20),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.parcial).toBe(false);
    expect(r.empresas_presentes).toEqual(ESP);
    expect(r.ncg_total).toBe(350);
    expect(r.ncg_parcial).toBe(false);
    expect(r.saldo_tesouraria_total).toBe(150);
    expect(r.projecao13).toHaveLength(2);
    expect(r.projecao13[0].inicio).toBe('2026-05-26');
    expect(r.projecao13[0].entradas_previstas).toBe(45);
    expect(r.projecao13[0].saldo_projetado).toBe(379);
    expect(r.projecao13[0].semana_label).toBe('26/05');
    expect(r.projecao13[0].completa).toBe(true);
    expect(r.projecao13[0].por_empresa).toHaveLength(3);
  });

  it('COORTE por data: snapshot stale (dia anterior) fora da soma + flag stale', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-20T10:00:00Z', 999, [sem('2026-05-19', 1, 0, 1)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.empresas_presentes).toEqual(['oben', 'colacor']);
    expect(r.empresas_stale).toEqual(['colacor_sc']);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(300);
    expect(r.projecao13[0].saldo_projetado).toBe(330);
    expect(r.projecao13[0].completa).toBe(false);
  });

  it('DEDUPE latest-wins por snapshot_at, NÃO ordem do array: mais novo vem ANTES', () => {
    const snaps = [
      snap('oben', '2026-05-27T12:00:00Z', 150, [sem('2026-05-26', 15, 0, 165)]),
      snap('oben', '2026-05-27T08:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.ncg_total).toBe(400);
    expect(r.projecao13[0].saldo_projetado).toBe(440);
    expect(r.empresas_presentes).toEqual(ESP);
  });

  it('coorte: 3 empresas no MESMO DIA com horas diferentes → todas na coorte, não parcial', () => {
    const snaps = [
      snap('oben', '2026-05-27T06:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T13:30:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T23:59:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.parcial).toBe(false);
    expect(r.empresas_presentes).toEqual(ESP);
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.ncg_total).toBe(350);
    expect(r.projecao13[0].completa).toBe(true);
  });

  it('coorte por DATA via slice (não new Date local): snapshot_at de madrugada Z não muda o dia', () => {
    const snaps = [snap('oben', '2026-05-27T01:00:00Z', 0, [sem('2026-05-01', 10, 0, 10)])];
    const r = consolidarCockpit({ esperadas: ['oben'], snapshots: snaps });
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.projecao13[0].semana_label).toBe('01/05');
  });

  it('saldo_tesouraria: 0 conta, null aciona parcial (simétrico ao ncg)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], 0),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], null),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], 30),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.saldo_tesouraria_total).toBe(30);
    expect(r.saldo_tesouraria_parcial).toBe(true);
    expect(r.projecao13[0].saldo_projetado).toBe(0);
  });

  it('stale com a MESMA semana inicio que a coorte → ainda excluído (por data)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-20T10:00:00Z', 999, [sem('2026-05-26', 99, 0, 999)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.empresas_stale).toEqual(['colacor_sc']);
    expect(r.ncg_total).toBe(300);
    expect(r.projecao13[0].saldo_projetado).toBe(330);
    expect(r.projecao13[0].por_empresa).toHaveLength(2);
  });

  it('empresa ausente (sem snapshot) → ausente + parcial; completa=false', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.empresas_ausentes).toEqual(['colacor_sc']);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(300);
    expect(r.projecao13[0].completa).toBe(false);
    expect(r.ncg_por_empresa.find(e => e.company === 'colacor_sc')).toEqual({ company: 'colacor_sc', ncg: null, presente: false });
  });

  it('ncg null ≠ ncg 0; null fora da soma + ncg_parcial', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', null, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.ncg_total).toBe(50);
    expect(r.ncg_parcial).toBe(true);
  });

  it('inícios fora de ordem → união ordenada asc; alinha por inicio', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-06-02', 20, 0, 20), sem('2026-05-26', 10, 0, 10)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 5, 0, 5), sem('2026-06-02', 7, 0, 7)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 1, 0, 1), sem('2026-06-02', 2, 0, 2)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.projecao13.map(s => s.inicio)).toEqual(['2026-05-26', '2026-06-02']);
    expect(r.projecao13[0].saldo_projetado).toBe(16);
  });

  it('semana só de uma empresa → completa=false (soma só quem tem)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 10, 0, 110), sem('2026-06-02', 5, 0, 115)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 1, 0, 1)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    const w2 = r.projecao13.find(s => s.inicio === '2026-06-02')!;
    expect(w2.saldo_projetado).toBe(115);
    expect(w2.completa).toBe(false);
    expect(w2.por_empresa).toHaveLength(1);
  });

  it('vazio → tudo ausente, parcial, projeção vazia, sem NaN', () => {
    const r = consolidarCockpit({ esperadas: ESP, snapshots: [] });
    expect(r.empresas_ausentes).toEqual(ESP);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(0);
    expect(r.projecao13).toEqual([]);
    expect(r.data_referencia).toBeNull();
  });

  it('cap nas 13 PRIMEIRAS semanas por menor inicio (não 13 quaisquer)', () => {
    const semanas = Array.from({ length: 16 }, (_, i) => sem(`2026-01-${String(i + 1).padStart(2, '0')}`, 1, 0, 1));
    const r = consolidarCockpit({ esperadas: ['oben'], snapshots: [snap('oben', '2026-05-27T10:00:00Z', 0, semanas)] });
    expect(r.projecao13).toHaveLength(13);
    expect(r.projecao13[0].inicio).toBe('2026-01-01');
    expect(r.projecao13[12].inicio).toBe('2026-01-13');
  });
});

describe('consolidarCockpit — caixa_inicial (transparência)', () => {
  it('soma saldo_inicial da semana de MENOR inicio de cada empresa presente', () => {
    const r = consolidarCockpit({ esperadas: ['oben', 'colacor'], snapshots: [
      snap('oben', '2026-05-31T10:00:00Z', 0, [sem('2026-06-01', 0, 0, 0, 1000), sem('2026-05-25', 0, 0, 0, 500)]),
      snap('colacor', '2026-05-31T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, 300)]),
    ] });
    expect(r.caixa_inicial_projecao).toBe(800); // 500 (menor inicio oben) + 300
    expect(r.caixa_inicial_parcial).toBe(false);
  });

  it('semana 0 (menor inicio) com saldo_inicial null + semana 1 válida → pega a semana 1 (menor inicio VÁLIDO)', () => {
    const r = consolidarCockpit({ esperadas: ['oben'], snapshots: [
      snap('oben', '2026-05-31T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, null), sem('2026-06-01', 0, 0, 0, 700)]),
    ] });
    expect(r.caixa_inicial_projecao).toBe(700);
    expect(r.caixa_inicial_parcial).toBe(false);
  });

  it('empresa presente sem nenhum saldo_inicial válido → caixa null + parcial', () => {
    const r = consolidarCockpit({ esperadas: ['oben', 'colacor'], snapshots: [
      snap('oben', '2026-05-31T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, 500)]),
      snap('colacor', '2026-05-31T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, null)]),
    ] });
    expect(r.caixa_inicial_projecao).toBeNull();
    expect(r.caixa_inicial_parcial).toBe(true);
  });

  it('coorte PARCIAL (1 stale) mas presentes têm saldo → expõe soma parcial, mas comparar bloqueia (cohorteCompleta=false)', () => {
    const r = consolidarCockpit({ esperadas: ['oben', 'colacor'], snapshots: [
      snap('oben', '2026-05-31T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, 500)]),
      snap('colacor', '2026-05-20T10:00:00Z', 0, [sem('2026-05-25', 0, 0, 0, 300)]), // stale (data < dataRef)
    ] });
    expect(r.parcial).toBe(true);
    expect(r.caixa_inicial_projecao).toBe(500); // só oben (coorte)
    expect(r.caixa_inicial_parcial).toBe(true); // parcial pela coorte
    expect(compararCaixaInicial({ caixaInicialProjecao: r.caixa_inicial_projecao, saldoAtualBanco: 900, cohorteCompleta: !r.parcial }).disponivel).toBe(false);
  });
});

describe('compararCaixaInicial', () => {
  it('coorte completa + caixa presente → delta = saldoAtual − caixaInicial', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: 800, saldoAtualBanco: 950, cohorteCompleta: true }))
      .toEqual({ disponivel: true, delta: 150 });
  });
  it('coorte incompleta → indisponível (maçã×laranja)', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: 800, saldoAtualBanco: 950, cohorteCompleta: false }))
      .toEqual({ disponivel: false, delta: null });
  });
  it('caixa inicial null → indisponível', () => {
    expect(compararCaixaInicial({ caixaInicialProjecao: null, saldoAtualBanco: 950, cohorteCompleta: true }))
      .toEqual({ disponivel: false, delta: null });
  });
});

describe('parseSnapshotSemanas (Number(null) não fabrica 0)', () => {
  it('saldo_inicial null/ausente/não-número → null (NÃO 0); semana NÃO é dropada', () => {
    const r = parseSnapshotSemanas([
      { inicio: '2026-05-25', total_entradas: 10, total_saidas: 5, saldo_final: 5, saldo_inicial: null },
      { inicio: '2026-06-01', total_entradas: 0, total_saidas: 0, saldo_final: 0 }, // ausente
      { inicio: '2026-06-08', total_entradas: 0, total_saidas: 0, saldo_final: 0, saldo_inicial: 'x' }, // não-número
    ]);
    expect(r).toHaveLength(3); // nenhuma dropada (campos core válidos)
    expect(r[0].saldo_inicial).toBeNull();
    expect(r[1].saldo_inicial).toBeNull();
    expect(r[2].saldo_inicial).toBeNull();
  });
  it('saldo_inicial número real (incl. 0 real) → preservado', () => {
    const r = parseSnapshotSemanas([
      { inicio: '2026-05-25', total_entradas: 0, total_saidas: 0, saldo_final: 0, saldo_inicial: 1234.5 },
      { inicio: '2026-06-01', total_entradas: 0, total_saidas: 0, saldo_final: 0, saldo_inicial: 0 },
    ]);
    expect(r[0].saldo_inicial).toBe(1234.5);
    expect(r[1].saldo_inicial).toBe(0); // 0 REAL é preservado
  });
  it('campo core inválido → semana dropada; dados não-array → []', () => {
    expect(parseSnapshotSemanas([{ inicio: '', total_entradas: 1, total_saidas: 1, saldo_final: 1, saldo_inicial: 9 }])).toEqual([]);
    expect(parseSnapshotSemanas([{ inicio: '2026-05-25', total_entradas: 'x', total_saidas: 1, saldo_final: 1, saldo_inicial: 9 }])).toEqual([]);
    expect(parseSnapshotSemanas(null)).toEqual([]);
    expect(parseSnapshotSemanas({})).toEqual([]);
  });
});

describe('consolidarCockpit — coorte vazia não fabrica caixa', () => {
  it('nenhum snapshot → caixa_inicial_projecao null (não 0) + parcial', () => {
    const r = consolidarCockpit({ esperadas: ESP, snapshots: [] });
    expect(r.caixa_inicial_projecao).toBeNull();
    expect(r.caixa_inicial_parcial).toBe(true);
  });
});
