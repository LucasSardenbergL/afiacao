import { describe, it, expect } from 'vitest';
import { avaliarDefasagem, DEFASAGEM_CONST, type DefasagemInput } from './defasagem';

// Fixture base: âncora válida, custo subiu de 60→72 (+20%), preço 100 herdado.
// Padrão "tudo OK por default; cada teste perturba 1 eixo" (como cockpit-preco.test.ts).
const base = (o: Partial<DefasagemInput>): DefasagemInput => ({
  pNow: 100,
  pLast: 100,
  cLast: 60,
  cNow: 72,             // +20% de custo
  temAncora: true,
  descontoNaoProvado: false,
  cNowFresco: true,
  dataConfiavel: true,
  ancoraMeses: 3,
  qtyRatioOk: true,
  ...o,
});

describe('avaliarDefasagem', () => {
  it('defasado — custo +20%, preço não subiu → defasado, P_req = pLast*(cNow/cLast)', () => {
    const r = avaliarDefasagem(base({}));
    expect(r.status).toBe('defasado');
    // P_req = 100 * (72/60) = 120,00
    expect(r.pReq).toBe(120);
    // alta de custo = 20%
    expect(r.altaCustoPerc).toBeCloseTo(20, 6);
  });

  it('em_dia — preço acompanhou a alta (+20%) → em_dia', () => {
    // pNow já em 120 (acompanhou). pReq=120, gap=0 < piso → em_dia.
    const r = avaliarDefasagem(base({ pNow: 120 }));
    expect(r.status).toBe('em_dia');
    expect(r.pReq).toBe(120);
  });

  it('sem_alta — custo caiu (72→48) → sem_alta (nunca repassa queda)', () => {
    const r = avaliarDefasagem(base({ cNow: 48 }));
    expect(r.status).toBe('sem_alta');
    expect(r.pReq).toBeNull();
  });

  it('sem_alta (ruído) — alta < piso de 2% (60→61, +1,67%) → sem_alta', () => {
    const r = avaliarDefasagem(base({ cNow: 61 }));
    expect(r.status).toBe('sem_alta');
  });

  it('G1 — pLast ≤ cLast (vendeu no/abaixo do custo) → neutro (não herda markup de prejuízo)', () => {
    const r = avaliarDefasagem(base({ pLast: 55, cLast: 60 }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('prejuizo_ancora');
    expect(r.pReq).toBeNull();
  });

  it('âncora antiga — ancoraMeses > 18 → neutro/ancora_antiga', () => {
    const r = avaliarDefasagem(base({ ancoraMeses: 24 }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('ancora_antiga');
  });

  it('quarentena — custo +60% (60→96) → revisar (provável erro de cadastro/unidade)', () => {
    const r = avaliarDefasagem(base({ cNow: 96 }));
    expect(r.status).toBe('revisar');
    expect(r.motivo).toBe('quarentena_custo');
  });

  it('fronteira da tolerância — custo +10%, preço +9,96% (por centavo) → NÃO defasado (TOL_PP)', () => {
    // cLast 100 → cNow 110 (+10%). pLast 100 → pNow 109,96 (+9,96%).
    // gap de pontos = 10% - 9,96% = 0,04pp < TOL_PP(3pp) → em_dia.
    const r = avaliarDefasagem(base({ pLast: 100, pNow: 109.96, cLast: 100, cNow: 110 }));
    expect(r.status).toBe('em_dia');
  });

  it('piso de ação — defasado pela razão mas P_req - P_now < R$1 → em_dia (centavo não dispara)', () => {
    // cLast 100 → cNow 102 (+2%, passa o piso de alta). pLast 50 → pReq = 50*1.02 = 51.
    // pNow 50,30: gap de pontos = 2% - 0,6% = 1,4pp > TOL? Não: 1,4 < 3 → em_dia já por tolerância.
    // Para isolar o PISO DE AÇÃO: forço a razão a passar a tolerância mas o gap em R$ < piso.
    // cLast 100 → cNow 110 (+10%). pLast 9 → pReq = 9*1.10 = 9,90. pNow 9 (não subiu):
    // gap pontos = 10% - 0% = 10pp > 3pp → passaria por razão. Mas pReq - pNow = 0,90 < R$1,00
    // E < 2% de pNow (0,18) → o MAIOR é R$1,00 → 0,90 < 1,00 → em_dia (piso de ação).
    const r = avaliarDefasagem(base({ pLast: 9, pNow: 9, cLast: 100, cNow: 110 }));
    expect(r.status).toBe('em_dia');
    expect(r.pReq).toBe(9.9);
  });

  it('desconto não provado → neutro/desconto_nao_provado', () => {
    const r = avaliarDefasagem(base({ descontoNaoProvado: true }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('desconto_nao_provado');
  });

  it('C_now stale → sem_custo_atual_fresco (G6)', () => {
    const r = avaliarDefasagem(base({ cNowFresco: false }));
    expect(r.status).toBe('sem_custo_atual_fresco');
  });

  it('sem data confiável → sem_data_confiavel (G7)', () => {
    const r = avaliarDefasagem(base({ dataConfiavel: false }));
    expect(r.status).toBe('sem_data_confiavel');
  });

  it('qty divergente (ordem de grandeza) → revisar (G5)', () => {
    const r = avaliarDefasagem(base({ qtyRatioOk: false }));
    expect(r.status).toBe('revisar');
    expect(r.motivo).toBe('qty_divergente');
  });

  it('sem âncora → sem_historico', () => {
    const r = avaliarDefasagem(base({ temAncora: false }));
    expect(r.status).toBe('sem_historico');
  });

  it('pLast/cLast/cNow inválido (NaN/≤0) → neutro/sem_base', () => {
    expect(avaliarDefasagem(base({ cLast: 0 })).status).toBe('neutro');
    expect(avaliarDefasagem(base({ cNow: NaN })).status).toBe('neutro');
    expect(avaliarDefasagem(base({ pLast: -5 })).status).toBe('neutro');
  });

  it('constantes congeladas (oráculo de tunagem)', () => {
    expect(DEFASAGEM_CONST.TOL_PP).toBe(3);
    expect(DEFASAGEM_CONST.PISO_ALTA_PERC).toBe(2);
    expect(DEFASAGEM_CONST.PISO_ACAO_PERC).toBe(2);
    expect(DEFASAGEM_CONST.PISO_ACAO_REAIS).toBe(1);
    expect(DEFASAGEM_CONST.ANCORA_MESES_MAX).toBe(18);
    expect(DEFASAGEM_CONST.QUARENTENA_PERC).toBe(50);
  });
});
