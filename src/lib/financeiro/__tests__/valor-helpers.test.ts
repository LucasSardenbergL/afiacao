// src/lib/financeiro/__tests__/valor-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  calcularNOPAT,
  margemOperacionalPreImposto,
  capitalInvestido,
  somarKe,
  waccHurdle,
  roic,
  spread,
  eva,
  roicIncremental,
  normalizarComingling,
  scoreConfiancaValor,
  resolverCapitalGiro,
  frescorGiro,
  acharCapitalGiroAnterior,
  resolverCapitalParaValor,
} from '../valor-helpers';

describe('calcularNOPAT', () => {
  it('presumido: NOPAT = EBIT puro − (IRPJ+CSLL); não subtrai PIS/COFINS de novo', () => {
    const r = calcularNOPAT({
      regime: 'presumido',
      resultado_operacional_ttm: 1000, // inclui +recfin −despfin
      receitas_financeiras_ttm: 100,
      despesas_financeiras_ttm: 40,
      irpj_ttm: 90, csll_ttm: 30,
      das_ttm: 0, pis_ttm: 13, cofins_ttm: 60, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    // EBIT puro = 1000 − 100 + 40 = 940
    expect(r.ebit).toBe(940);
    // imposto abaixo da linha = 90 + 30 = 120 (PIS/COFINS NÃO entram)
    expect(r.imposto_operacional_nopat).toBe(120);
    expect(r.nopat).toBe(820);
    // carga total do regime (informacional) = irpj+csll+pis+cofins+icms+iss+ipi
    expect(r.carga_tributaria_regime_total).toBe(90 + 30 + 13 + 60);
  });

  it('simples: NOPAT = EBIT puro (DAS já absorvido); imposto abaixo da linha = 0', () => {
    const r = calcularNOPAT({
      regime: 'simples',
      resultado_operacional_ttm: 500,
      receitas_financeiras_ttm: 20,
      despesas_financeiras_ttm: 10,
      irpj_ttm: 0, csll_ttm: 0,
      das_ttm: 80, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.ebit).toBe(490); // 500 − 20 + 10
    expect(r.imposto_operacional_nopat).toBe(0);
    expect(r.nopat).toBe(490);
    expect(r.carga_tributaria_regime_total).toBe(80); // DAS, informacional
  });

  it('EBIT negativo → NOPAT negativo (sem clamp, sem multiplicador)', () => {
    const r = calcularNOPAT({
      regime: 'presumido', resultado_operacional_ttm: -200,
      receitas_financeiras_ttm: 0, despesas_financeiras_ttm: 0,
      irpj_ttm: 0, csll_ttm: 0, das_ttm: 0, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.nopat).toBe(-200);
  });

  it('imposto > EBIT → NOPAT negativo coerente (presumido)', () => {
    const r = calcularNOPAT({
      regime: 'presumido', resultado_operacional_ttm: 100,
      receitas_financeiras_ttm: 0, despesas_financeiras_ttm: 0,
      irpj_ttm: 90, csll_ttm: 40, das_ttm: 0, pis_ttm: 0, cofins_ttm: 0, icms_ttm: 0, iss_ttm: 0, ipi_ttm: 0,
    });
    expect(r.nopat).toBe(-30); // 100 − 130
  });
});

describe('margemOperacionalPreImposto', () => {
  it('EBIT / receita_liquida', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: 1000 })).toBeCloseTo(0.2, 10);
  });
  it('receita_liquida 0 → 0', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: 0 })).toBe(0);
  });
  it('receita_liquida negativa → 0 (guarda)', () => {
    expect(margemOperacionalPreImposto({ ebit: 200, receita_liquida: -50 })).toBe(0);
  });
});

describe('capitalInvestido', () => {
  it('giro + ativo fixo − ajustes; completo (não parcial)', () => {
    const r = capitalInvestido({
      capital_giro: 300000,
      ativo_fixo: { valor: 500000, data_ref: '2026-01-01', fonte: 'reposicao', base: 'reposicao', operacional: true },
      ajustes: 20000,
    });
    expect(r.capital_investido).toBe(780000); // 300k + 500k − 20k
    expect(r.parcial).toBe(false);
    expect(r.ativo_fixo).toBe(500000);
  });

  it('sem ativo fixo → parcial (só giro − ajustes) + motivo', () => {
    const r = capitalInvestido({ capital_giro: 300000, ativo_fixo: null });
    expect(r.capital_investido).toBe(300000);
    expect(r.ativo_fixo).toBe(0);
    expect(r.parcial).toBe(true);
    expect(r.motivos.length).toBeGreaterThan(0);
  });

  it('ativo fixo marcado como não-operacional → não entra, vira parcial', () => {
    const r = capitalInvestido({
      capital_giro: 100,
      ativo_fixo: { valor: 999, data_ref: null, fonte: 'book', base: 'book', operacional: false },
    });
    expect(r.ativo_fixo).toBe(0);
    expect(r.parcial).toBe(true);
  });
});

describe('somarKe', () => {
  it('Ke = âncora + Σ prêmios', () => {
    expect(somarKe({ ancora: 0.11, premio_risco_equity: 0.05, premio_tamanho_private: 0.03, premio_iliquidez_controle: 0.02 }))
      .toBeCloseTo(0.21, 10);
  });
});

describe('waccHurdle', () => {
  it('pesos + Kd PRÉ-imposto (tax-shield off); wacc = we·Ke + wd·Kd', () => {
    const r = waccHurdle({ ke: 0.20, kd: 0.14, divida: 400000, equity: 600000 });
    // wd = 0.4, we = 0.6 → 0.6*0.20 + 0.4*0.14 = 0.12 + 0.056 = 0.176
    expect(r.peso_divida).toBeCloseTo(0.4, 10);
    expect(r.peso_equity).toBeCloseTo(0.6, 10);
    expect(r.wacc).toBeCloseTo(0.176, 10);
    expect(r.tax_shield_aplicado).toBe(false);
  });

  it('sem dívida (divida=0) → wacc = Ke (all-equity)', () => {
    const r = waccHurdle({ ke: 0.18, kd: null, divida: 0, equity: 500000 });
    expect(r.wacc).toBeCloseTo(0.18, 10);
  });

  it('Ke ausente → wacc null + motivo', () => {
    const r = waccHurdle({ ke: null, kd: 0.1, divida: 100, equity: 100 });
    expect(r.wacc).toBeNull();
    expect(r.motivos.length).toBeGreaterThan(0);
  });

  it('PL ausente → wacc null', () => {
    expect(waccHurdle({ ke: 0.2, kd: 0.1, divida: 100, equity: null }).wacc).toBeNull();
  });

  it('há dívida mas Kd ausente → wacc null', () => {
    expect(waccHurdle({ ke: 0.2, kd: null, divida: 100, equity: 100 }).wacc).toBeNull();
  });
});

describe('roic / spread / eva', () => {
  it('roic = nopat / capital', () => {
    expect(roic({ nopat: 200, capital_investido: 1000 })).toBeCloseTo(0.2, 10);
  });
  it('roic: capital 0 ou null → null', () => {
    expect(roic({ nopat: 200, capital_investido: 0 })).toBeNull();
    expect(roic({ nopat: 200, capital_investido: null })).toBeNull();
  });
  it('spread = roic − wacc; qualquer null → null', () => {
    expect(spread({ roic: 0.2, wacc: 0.176 })).toBeCloseTo(0.024, 10);
    expect(spread({ roic: null, wacc: 0.1 })).toBeNull();
    expect(spread({ roic: 0.2, wacc: null })).toBeNull();
  });
  it('eva = spread × capital; qualquer null → null', () => {
    expect(eva({ spread: 0.024, capital_investido: 1000 })).toBeCloseTo(24, 10);
    expect(eva({ spread: null, capital_investido: 1000 })).toBeNull();
    expect(eva({ spread: 0.024, capital_investido: null })).toBeNull();
  });
});

describe('roicIncremental', () => {
  it('ΔNOPAT / Δcapital quando Δcapital ≥ limiar', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 1500000, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.delta_nopat).toBe(100);
    expect(r.delta_capital).toBe(500000);
    expect(r.roic_incremental).toBeCloseTo(100 / 500000, 12);
    expect(r.aviso).toBeNull();
  });

  it('Δcapital pequeno (< limiar) → null + aviso', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 1000500, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.roic_incremental).toBeNull();
    expect(r.aviso).not.toBeNull();
  });

  it('Δcapital negativo → null + aviso (desinvestimento é ruído)', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: 200, capital_atual: 900000, capital_anterior: 1000000, limiar_delta_capital: 1000 });
    expect(r.roic_incremental).toBeNull();
    expect(r.aviso).not.toBeNull();
  });

  it('histórico ausente (anterior null) → null + aviso', () => {
    const r = roicIncremental({ nopat_atual: 300, nopat_anterior: null, capital_atual: 1500000, capital_anterior: null });
    expect(r.roic_incremental).toBeNull();
    expect(r.delta_nopat).toBeNull();
    expect(r.aviso).not.toBeNull();
  });
});

describe('normalizarComingling', () => {
  it('dono se paga ABAIXO do mercado → EBIT normalizado MENOR que o reportado', () => {
    const r = normalizarComingling({
      ebit_reportado: 1000, capital_reportado: 500000,
      prolabore_real_ttm: 120000, prolabore_mercado_ttm: 200000, // paga 120k, mercado 200k
      aluguel_mercado_ttm: null, intercompany_giro: null,
    });
    // ajuste = real − mercado = 120k − 200k = −80k → ebit_norm = 1000 − 80000 = −79000
    expect(r.ajuste_prolabore).toBe(-80000);
    expect(r.ebit_normalizado).toBe(-79000);
    expect(r.aplicado).toBe(true);
    expect(r.ebit_normalizado).not.toBe(r.ebit_reportado);
  });

  it('aluguel de mercado reduz EBIT (despesa figurativa)', () => {
    const r = normalizarComingling({
      ebit_reportado: 500000, capital_reportado: 500000,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: 60000, intercompany_giro: null,
    });
    expect(r.ajuste_aluguel).toBe(-60000);
    expect(r.ebit_normalizado).toBe(440000);
  });

  it('intercompany removido do capital de giro no normalizado', () => {
    const r = normalizarComingling({
      ebit_reportado: 100, capital_reportado: 800000,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: null, intercompany_giro: 150000,
    });
    expect(r.ajuste_intercompany_capital).toBe(-150000);
    expect(r.capital_normalizado).toBe(650000);
  });

  it('sem nenhum input de normalização → aplicado=false e normalizado == reportado', () => {
    const r = normalizarComingling({
      ebit_reportado: 100, capital_reportado: 200,
      prolabore_real_ttm: null, prolabore_mercado_ttm: null,
      aluguel_mercado_ttm: null, intercompany_giro: null,
    });
    expect(r.aplicado).toBe(false);
    expect(r.ebit_normalizado).toBe(100);
    expect(r.capital_normalizado).toBe(200);
    expect(r.motivos.length).toBeGreaterThan(0);
  });
});

describe('scoreConfiancaValor', () => {
  it('tudo presente + DRE alta → alta', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.nivel).toBe('alta');
    expect(r.wacc_disponivel).toBe(true);
    expect(r.normalizado_disponivel).toBe(true);
  });

  it('sem ativo fixo (capital parcial) → media + flag roic/eva disponíveis ainda', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: true,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('parcial'))).toBe(true);
  });

  it('WACC null → wacc/eva indisponíveis e nível ≤ media', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: true, eva_null: true, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.wacc_disponivel).toBe(false);
    expect(r.eva_disponivel).toBe(false);
    expect(r.nivel).not.toBe('alta');
  });

  it('sem normalização → normalizado indisponível + aviso', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: false, imposto_teorico_parcial: false, dre_confianca: 'alta',
    });
    expect(r.normalizado_disponivel).toBe(false);
    expect(r.motivos.some((m) => m.toLowerCase().includes('normaliz'))).toBe(true);
  });

  it('DRE baixa → baixa (pior sinal manda)', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'baixa',
    });
    expect(r.nivel).toBe('baixa');
  });

  it('TTM parcial (<12 meses) → rebaixa para media + motivo', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
      ttm_parcial: true,
    });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('ttm incompleto'))).toBe(true);
  });

  it('giro indisponível → baixa + motivo de NCG (mais severo que roic_null por capital≤0)', () => {
    const r = scoreConfiancaValor({
      roic_null: true, wacc_null: false, eva_null: true, capital_parcial: true,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
      giro_indisponivel: true,
    });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.some((m) => m.toLowerCase().includes('snapshot de ncg'))).toBe(true);
  });

  it('giro stale (sem indisponível) → media + motivo de NCG desatualizado', () => {
    const r = scoreConfiancaValor({
      roic_null: false, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
      giro_stale: true,
    });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('desatualiz'))).toBe(true);
  });

  it('roic_null por capital≤0 CONHECIDO (giro disponível) → media, NÃO baixa', () => {
    const r = scoreConfiancaValor({
      roic_null: true, wacc_null: false, eva_null: false, capital_parcial: false,
      normalizacao_aplicada: true, imposto_teorico_parcial: false, dre_confianca: 'alta',
      giro_indisponivel: false,
    });
    expect(r.nivel).toBe('media');
  });
});

describe('resolverCapitalGiro', () => {
  it('pega o snapshot mais recente com ncg não-nulo (negativo é valor real)', () => {
    const r = resolverCapitalGiro([
      { ncg: null, snapshot_at: '2026-05-28T10:00:00Z' },
      { ncg: -5000, snapshot_at: '2026-05-27T10:00:00Z' },
      { ncg: 9999, snapshot_at: '2026-05-20T10:00:00Z' },
    ]);
    expect(r.capital_giro).toBe(-5000);
    expect(r.disponivel).toBe(true);
    expect(r.snapshot_at).toBe('2026-05-27T10:00:00Z');
  });
  it('ncg zero é valor REAL (não ausência) — truthiness não', () => {
    const r = resolverCapitalGiro([{ ncg: 0, snapshot_at: '2026-05-28T10:00:00Z' }]);
    expect(r.capital_giro).toBe(0);
    expect(r.disponivel).toBe(true);
  });
  it('todos null → indisponível', () => {
    const r = resolverCapitalGiro([{ ncg: null, snapshot_at: '2026-05-28T10:00:00Z' }]);
    expect(r.capital_giro).toBeNull();
    expect(r.disponivel).toBe(false);
    expect(r.snapshot_at).toBeNull();
  });
  it('sem snapshots → indisponível', () => {
    const r = resolverCapitalGiro([]);
    expect(r.disponivel).toBe(false);
    expect(r.snapshot_at).toBeNull();
  });
  it('ordem fora de ordem → pega o mais recente por data (não confia no array)', () => {
    const r = resolverCapitalGiro([
      { ncg: 100, snapshot_at: '2026-05-01T00:00:00Z' },
      { ncg: 200, snapshot_at: '2026-05-27T00:00:00Z' },
      { ncg: 150, snapshot_at: '2026-05-10T00:00:00Z' },
    ]);
    expect(r.capital_giro).toBe(200);
  });
  it('ncg string vazia/whitespace (cast runtime) → ausência, NÃO 0 (Number("")===0 seria fabricação)', () => {
    expect(resolverCapitalGiro([{ ncg: '' as unknown as number, snapshot_at: '2026-05-28T00:00:00Z' }]).disponivel).toBe(false);
    expect(resolverCapitalGiro([{ ncg: '   ' as unknown as number, snapshot_at: '2026-05-28T00:00:00Z' }]).disponivel).toBe(false);
  });
  it('ncg string numérica (PostgREST numeric) → valor real', () => {
    const r = resolverCapitalGiro([{ ncg: '300000' as unknown as number, snapshot_at: '2026-05-28T00:00:00Z' }]);
    expect(r.capital_giro).toBe(300000);
    expect(r.disponivel).toBe(true);
  });
});

describe('frescorGiro', () => {
  const hoje = Date.parse('2026-05-28T00:00:00Z');
  it('fresco (8 dias) → não stale, dias=8', () => {
    expect(frescorGiro('2026-05-20T00:00:00Z', hoje, 45)).toEqual({ dias: 8, stale: false });
  });
  it('velho (>120 dias) → stale, dias grande', () => {
    const r = frescorGiro('2026-01-01T00:00:00Z', hoje, 45);
    expect(r.stale).toBe(true);
    expect(r.dias).toBeGreaterThan(120);
  });
  it('snapshot_at null → dias null, não stale', () => {
    expect(frescorGiro(null, hoje, 45)).toEqual({ dias: null, stale: false });
  });
  it('snapshot_at inválido → dias null, não stale', () => {
    expect(frescorGiro('lixo', hoje, 45)).toEqual({ dias: null, stale: false });
  });
});

describe('acharCapitalGiroAnterior', () => {
  it('acha o snapshot ~365d antes do ref dentro da tolerância', () => {
    const snaps = [
      { ncg: 1000, snapshot_at: '2026-05-27T00:00:00Z' },
      { ncg: 800, snapshot_at: '2025-05-26T00:00:00Z' },
    ];
    expect(acharCapitalGiroAnterior(snaps, '2026-05-27T00:00:00Z')).toBe(800);
  });
  it('sem snapshot próximo de −365d (fora da tolerância) → null', () => {
    const snaps = [{ ncg: 1000, snapshot_at: '2026-05-27T00:00:00Z' }];
    expect(acharCapitalGiroAnterior(snaps, '2026-05-27T00:00:00Z')).toBeNull();
  });
});

describe('resolverCapitalParaValor (orquestração — defeita o "inline 0")', () => {
  const hoje = Date.parse('2026-05-28T00:00:00Z');
  const af = null; // sem ativo fixo

  it('NCG ausente (todos null) → capital_investido/capital_giro null, giro_indisponivel, sem anterior', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: null, snapshot_at: '2026-05-28T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.capital_investido).toBeNull();
    expect(r.capital.capital_giro).toBeNull();
    expect(r.capital.giro_indisponivel).toBe(true);
    expect(r.capital.parcial).toBe(true);
    expect(r.capital_anterior).toBeNull();
    expect(r.giro_snapshot_at).toBeNull();
  });

  it('NCG ausente + ativo fixo informado → AINDA capital null (não vira ativo_fixo isolado)', () => {
    const ativo = { valor: 500000, data_ref: null, fonte: 'reposicao' as const, base: 'reposicao' as const, operacional: true };
    const r = resolverCapitalParaValor({ snaps: [], ativo_fixo: ativo, hojeMs: hoje });
    expect(r.capital.capital_investido).toBeNull(); // NÃO 500000 — sem giro, ROIC não nasce
    expect(r.capital.giro_indisponivel).toBe(true);
  });

  it('NCG negativo grande sem ativo fixo → giro DISPONÍVEL, capital≤0, roic null POR CAPITAL (não por ausência)', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: -50000, snapshot_at: '2026-05-27T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.giro_indisponivel).toBe(false);
    expect(r.capital.capital_investido).toBe(-50000);
    expect(roic({ nopat: 1000, capital_investido: r.capital.capital_investido })).toBeNull();
  });

  it('NCG válido recente → capital_giro = ncg (happy-path idêntico), não stale', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: 300000, snapshot_at: '2026-05-25T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.capital_giro).toBe(300000);
    expect(r.capital.capital_investido).toBe(300000);
    expect(r.giro_stale).toBe(false);
    expect(r.giro_dias).toBe(3);
  });

  it('NCG válido porém VELHO → disponível mas stale (capital real, confiança rebaixada depois)', () => {
    const r = resolverCapitalParaValor({ snaps: [{ ncg: 300000, snapshot_at: '2026-01-01T00:00:00Z' }], ativo_fixo: af, hojeMs: hoje });
    expect(r.capital.capital_giro).toBe(300000);
    expect(r.giro_stale).toBe(true);
  });
});

describe('normalizarComingling — capital null não coage', () => {
  it('capital_reportado null + intercompany_giro -500 → capital_normalizado null (NÃO -500); ebit normalizado segue', () => {
    const r = normalizarComingling({
      ebit_reportado: 10000, capital_reportado: null,
      prolabore_real_ttm: 1000, prolabore_mercado_ttm: 3000, aluguel_mercado_ttm: null, intercompany_giro: -500,
    });
    expect(r.capital_normalizado).toBeNull();
    expect(r.capital_reportado).toBeNull();
    expect(r.ebit_normalizado).toBe(10000 + (1000 - 3000)); // EBIT independe do capital
  });
});

describe('capitalInvestido — giro nullable', () => {
  it('giro null → capital null + giro_indisponivel + parcial', () => {
    const r = capitalInvestido({ capital_giro: null, ativo_fixo: null });
    expect(r.capital_investido).toBeNull();
    expect(r.capital_giro).toBeNull();
    expect(r.giro_indisponivel).toBe(true);
    expect(r.parcial).toBe(true);
  });
  it('giro 0 REAL + ativo fixo → capital = ativo fixo, giro_indisponivel false', () => {
    const r = capitalInvestido({ capital_giro: 0, ativo_fixo: { valor: 500000, data_ref: null, fonte: 'reposicao', base: 'reposicao', operacional: true } });
    expect(r.capital_investido).toBe(500000);
    expect(r.giro_indisponivel).toBe(false);
  });
});
