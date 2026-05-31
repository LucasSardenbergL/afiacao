import { describe, it, expect } from 'vitest';
import { margemContribuicao, arMedioTTM, statusLiquidadoAR, montarCelulasComboEVP, recomendarAcaoComercial, scoreConfiancaCockpit, resolverHurdleCockpit } from '../valor-cockpit-helpers';

// helper de fixture: TituloAR completo com defaults (reduz ruído nos casos)
function tit(p: Partial<Parameters<typeof arMedioTTM>[0]['titulos'][number]>) {
  return {
    valor_documento: 1000, saldo: 0, valor_recebido: 0,
    data_emissao: '2025-06-01', data_vencimento: null, data_baixa_derivada: null, status: 'ABERTO',
    ...p,
  };
}

describe('margemContribuicao', () => {
  it('receita − custo×qtd', () => {
    expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: 6, quantidade: 100 })).toBe(400);
  });
  it('custo ausente → null', () => {
    expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: null, quantidade: 100 })).toBeNull();
  });
  it('margem negativa é honesta (vende abaixo do custo)', () => {
    expect(margemContribuicao({ receita_liquida: 500, custo_unitario: 6, quantidade: 100 })).toBe(-100);
  });
});

describe('statusLiquidadoAR', () => {
  it('RECEBIDO/LIQUIDADO/PAGO → true; aberto/null → false', () => {
    expect(statusLiquidadoAR('RECEBIDO')).toBe(true);
    expect(statusLiquidadoAR('PAGO')).toBe(true);
    expect(statusLiquidadoAR('A VENCER')).toBe(false);
    expect(statusLiquidadoAR('ATRASADO')).toBe(false);
    expect(statusLiquidadoAR(null)).toBe(false);
  });
});

describe('arMedioTTM (status + baixa derivada)', () => {
  const win = { ttm_inicio: '2025-06-01', ttm_fim: '2026-06-01' }; // 365 dias
  it('título aberto a janela inteira: média ≈ saldo', () => {
    const a = arMedioTTM({ titulos: [tit({ saldo: 1000, status: 'A VENCER' })], ...win });
    expect(a.ar_medio).toBeCloseTo(1000, 0);
  });
  it('liquidado fechado na metade (baixa derivada): contribui metade + v_real', () => {
    const a = arMedioTTM({ titulos: [tit({ saldo: 1000, status: 'RECEBIDO', data_baixa_derivada: '2025-12-01' })], ...win });
    // ~183 dias aberto / 365 × valor_documento(1000) ≈ 501; usa valor_documento, NÃO o saldo cheio
    expect(a.ar_medio).toBeGreaterThan(450);
    expect(a.ar_medio).toBeLessThan(550);
    expect(a.v_real).toBe(1000);
    expect(a.v_proxy).toBe(0);
  });
  it('liquidado SEM baixa derivada usa VENCIMENTO como proxy (não exclui) → v_proxy', () => {
    const a = arMedioTTM({ titulos: [tit({ saldo: 1000, status: 'RECEBIDO', data_vencimento: '2025-12-01' })], ...win });
    expect(a.ar_medio).toBeGreaterThan(450); // fecha no vencimento, mesma contribuição ~501
    expect(a.ar_medio).toBeLessThan(550);
    expect(a.v_proxy).toBe(1000);
    expect(a.v_real).toBe(0);
  });
  it('liquidado SEM baixa nem vencimento → excluído (v_sem_fecho), não infla a AR', () => {
    // saldo cheio (1000) — se contasse como aberto a janela toda, ar_medio ≈ 1000
    const a = arMedioTTM({ titulos: [tit({ saldo: 1000, status: 'RECEBIDO' })], ...win });
    expect(a.ar_medio).toBe(0);
    expect(a.v_sem_fecho).toBe(1000);
  });
  it('liquidado usa valor_documento, NÃO o saldo cheio (#396)', () => {
    // saldo cheio 5000, valor_documento 1000, fecha na metade → ~501 (não ~2500)
    const a = arMedioTTM({ titulos: [tit({ valor_documento: 1000, saldo: 5000, status: 'LIQUIDADO', data_baixa_derivada: '2025-12-01' })], ...win });
    expect(a.ar_medio).toBeLessThan(550);
  });
  it('liquidado fechado ANTES da janela → contribui 0 e não conta cobertura', () => {
    const a = arMedioTTM({ titulos: [tit({ data_emissao: '2025-01-01', status: 'RECEBIDO', data_baixa_derivada: '2025-03-01' })], ...win });
    expect(a.ar_medio).toBe(0);
    expect(a.v_real).toBe(0); // não contribuiu na janela → fora da cobertura
  });
  it('aberto com saldo estranho (0) → fallback valor_documento − valor_recebido', () => {
    const a = arMedioTTM({ titulos: [tit({ valor_documento: 1000, saldo: 0, valor_recebido: 300, status: 'A VENCER' })], ...win });
    expect(a.ar_medio).toBeCloseTo(700, 0); // 1000 − 300, janela inteira
  });
  it('sem data_emissao → ignora o título', () => {
    expect(arMedioTTM({ titulos: [tit({ data_emissao: null })], ...win }).ar_medio).toBe(0);
  });
  it('sem títulos → 0', () => {
    expect(arMedioTTM({ titulos: [], ...win }).ar_medio).toBe(0);
  });
});

describe('montarCelulasComboEVP', () => {
  const base = {
    combos: [
      { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }, // cm 400
      { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 50, custo_unitario: 10 },  // cm 500
      { cliente: 'C2', sku: 'S1', receita_liquida: 2000, quantidade: 100, custo_unitario: 6 },  // cm 1400
    ],
    capitalClientes: [{ cliente: 'C1', ar_medio: 600 }, { cliente: 'C2', ar_medio: 1000 }],
    capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }, { sku: 'S2', estoque_valor: 400 }],
    k: 0.20,
  };

  it('aloca AR por receita do cliente e estoque por quantidade do SKU', () => {
    const r = montarCelulasComboEVP(base);
    const c1s1 = r.celulas.find((c) => c.cliente === 'C1' && c.sku === 'S1')!;
    // R_C1 = 2000 → a_cs = 600 × 1000/2000 = 300
    expect(c1s1.a_cs).toBeCloseTo(300, 6);
    // Q_S1 = 200 (C1 100 + C2 100) → i_cs = 800 × 100/200 = 400
    expect(c1s1.i_cs).toBeCloseTo(400, 6);
    // encargo = 0.20 × (300+400) = 140 ; evp = 400 − 140 = 260
    expect(c1s1.encargo).toBeCloseTo(140, 6);
    expect(c1s1.evp).toBeCloseTo(260, 6);
  });

  it('INVARIANTE: Σ porCliente.evp = Σ porSKU.evp = empresa.evp', () => {
    const r = montarCelulasComboEVP(base);
    const somaCli = r.porCliente.reduce((s, x) => s + (x.evp ?? 0), 0);
    const somaSku = r.porSKU.reduce((s, x) => s + (x.evp ?? 0), 0);
    expect(somaCli).toBeCloseTo(r.empresa.evp!, 6);
    expect(somaSku).toBeCloseTo(r.empresa.evp!, 6);
    expect(somaCli).toBeCloseTo(somaSku, 6);
  });

  it('IDENTIDADE CONTÁBIL: empresa.evp = empresa.cm − empresa.encargo, mesmo com célula de custo nulo', () => {
    // Um combo SEM custo (cm null) não pode quebrar a identidade: seu encargo entra só em encargo_total.
    const r = montarCelulasComboEVP({
      ...base,
      combos: [
        ...base.combos,
        { cliente: 'C2', sku: 'S2', receita_liquida: 500, quantidade: 30, custo_unitario: null }, // cm null
      ],
    });
    expect(r.empresa.cm).not.toBeNull();
    expect(r.empresa.evp).not.toBeNull();
    // identidade fecha usando o encargo relevante-ao-EVP (não o total):
    // (k é número neste teste → encargo non-null; `!` consistente com evp!/cm! das mesmas linhas)
    expect(r.empresa.evp!).toBeCloseTo(r.empresa.cm! - r.empresa.encargo!, 6);
    // e por rollup:
    for (const c of r.porCliente) if (c.cm != null && c.evp != null) expect(c.evp).toBeCloseTo(c.cm - c.encargo!, 6);
    for (const s of r.porSKU) if (s.cm != null && s.evp != null) expect(s.evp).toBeCloseTo(s.cm - s.encargo!, 6);
    // encargo_total inclui a célula sem custo → ≥ encargo relevante-ao-EVP:
    expect(r.empresa.encargo_total!).toBeGreaterThanOrEqual(r.empresa.encargo! - 1e-9);
  });

  it('custo ausente → cm null, célula fora do EVP, flag', () => {
    const r = montarCelulasComboEVP({
      ...base,
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: null }],
    });
    expect(r.celulas[0].cm).toBeNull();
    expect(r.celulas[0].evp).toBeNull();
    expect(r.empresa.cm).toBeNull(); // nenhum cm válido
  });

  it('AR do cliente null → a_cs 0 + flag ar_indisponivel', () => {
    const r = montarCelulasComboEVP({
      ...base,
      capitalClientes: [{ cliente: 'C1', ar_medio: null }, { cliente: 'C2', ar_medio: 1000 }],
    });
    const c1 = r.celulas.find((c) => c.cliente === 'C1')!;
    expect(c1.a_cs).toBe(0);
    expect(c1.ar_indisponivel).toBe(true);
  });
});

const cfg = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };

describe('recomendarAcaoComercial', () => {
  it('desconto acima do máx + EVP baixo → cortar desconto', () => {
    const r = recomendarAcaoComercial({ evp: -50, receita_liquida: 1000, cm: 100, desconto_total: 200, prazo_medio_dias: 20, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('desconto'))).toBe(true);
  });
  it('prazo acima do alvo + encargo de AR pesado → encurtar prazo', () => {
    const r = recomendarAcaoComercial({ evp: -10, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 75, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('prazo'))).toBe(true);
  });
  it('margem% abaixo da mínima → subir preço com impacto R$', () => {
    const r = recomendarAcaoComercial({ evp: 5, receita_liquida: 1000, cm: 80, desconto_total: 0, prazo_medio_dias: 20, dias_estoque: 30, config: cfg });
    const subir = r.find((x) => x.acao.toLowerCase().includes('preço'));
    expect(subir).toBeTruthy();
    expect(subir!.impacto_rs).not.toBeNull();
  });
  it('estoque acima do limite + EVP negativo → despriorizar/liquidar SKU', () => {
    const r = recomendarAcaoComercial({ evp: -100, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 20, dias_estoque: 200, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('estoque') || x.acao.toLowerCase().includes('despriorizar'))).toBe(true);
  });
  it('tudo saudável → recomenda crescer/proteger', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 15, dias_estoque: 30, config: cfg });
    expect(r.some((x) => x.acao.toLowerCase().includes('crescer'))).toBe(true);
  });
  it('cm null → sem recomendação de preço (sem dado)', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: null, desconto_total: 0, prazo_medio_dias: 15, dias_estoque: 30, config: cfg });
    expect(r.every((x) => !x.acao.toLowerCase().includes('preço'))).toBe(true);
  });
});

describe('scoreConfiancaCockpit', () => {
  it('tudo coberto → alta', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).toBe('alta');
  });
  it('cobertura de receita baixa → rebaixa + motivo', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.4, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).not.toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('cobertura'))).toBe(true);
  });
  it('muito custo ausente → baixa', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0.6, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).toBe('baixa');
  });
  it('imposto estimado vira motivo (não derruba sozinho)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: true });
    expect(r.motivos.some((m) => m.toLowerCase().includes('imposto'))).toBe(true);
  });
  it('hurdle indisponível → baixa + motivo (guard de hurdle)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, hurdle_indisponivel: true });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.some((m) => m.toLowerCase().includes('hurdle'))).toBe(true);
  });
});

describe('resolverHurdleCockpit', () => {
  it('ke.base ausente → null (não fabrica 0.20)', () => {
    expect(resolverHurdleCockpit({})).toBeNull();
    expect(resolverHurdleCockpit({ ke: {} })).toBeNull();
    expect(resolverHurdleCockpit(null)).toBeNull();
  });
  it('ke.base vazio {} → null (não 0 — 0% seria capital grátis)', () => {
    expect(resolverHurdleCockpit({ ke: { base: {} } })).toBeNull();
  });
  it('âncora ausente → null mesmo com prêmios', () => {
    expect(resolverHurdleCockpit({ ke: { base: { premio_risco_equity: 0.05 } } })).toBeNull();
  });
  it('âncora + prêmios válidos → soma', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0.11, premio_risco_equity: 0.05, premio_tamanho_private: 0.03, premio_iliquidez_controle: 0.02 } } })).toBeCloseTo(0.21, 10);
  });
  it('âncora só → soma (prêmios ausentes = 0)', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0.12 } } })).toBeCloseTo(0.12, 10);
  });
  it('âncora string numérica (PostgREST) → número', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: '0.1' } } })).toBeCloseTo(0.1, 10);
  });
  it('soma ≤ 0 → null', () => {
    expect(resolverHurdleCockpit({ ke: { base: { ancora: 0 } } })).toBeNull();
  });
});

describe('montarCelulasComboEVP — k nullable', () => {
  const combos = [{ cliente: 'A', sku: '1', receita_liquida: 1000, quantidade: 10, custo_unitario: 50 }];
  const capCli = [{ cliente: 'A', ar_medio: 2000 }];
  const capSku = [{ sku: '1', estoque_valor: 500 }];
  it('k número → encargo/evp calculados (happy-path), asserts EXATOS em rollup/empresa', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.celulas[0].encargo).toBeCloseTo(0.2 * (2000 + 500), 6); // 500
    expect(r.celulas[0].evp).toBeCloseTo(500 - 0.2 * 2500, 6);       // 0
    expect(r.porCliente[0].encargo).toBeCloseTo(500, 6);
    expect(r.porCliente[0].encargo_total).toBeCloseTo(500, 6);
    expect(r.porCliente[0].evp).toBeCloseTo(0, 6);
    expect(r.porSKU[0].encargo).toBeCloseTo(500, 6);
    expect(r.empresa.encargo).toBeCloseTo(500, 6);
    expect(r.empresa.encargo_total).toBeCloseTo(500, 6);
    expect(r.empresa.evp).toBeCloseTo(0, 6);
  });
  it('k null → encargo/evp null em célula/rollup/empresa; cm segue; acumulador NÃO coage', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: null });
    expect(r.celulas[0].encargo).toBeNull();
    expect(r.celulas[0].evp).toBeNull();
    expect(r.celulas[0].cm).toBe(500); // 1000 − 50*10
    expect(r.porCliente[0].encargo).toBeNull();
    expect(r.porCliente[0].encargo_total).toBeNull(); // NÃO 0
    expect(r.porCliente[0].evp).toBeNull();
    expect(r.empresa.encargo).toBeNull();
    expect(r.empresa.encargo_total).toBeNull();
    expect(r.empresa.evp).toBeNull();
    expect(r.empresa.cm).toBe(500);
  });
  it('MISTO k=null + célula cm=null no mesmo cliente: custo-ausente ≠ hurdle-ausente', () => {
    const combos2 = [
      { cliente: 'A', sku: '1', receita_liquida: 1000, quantidade: 10, custo_unitario: 50 }, // cm=500
      { cliente: 'A', sku: '2', receita_liquida: 800, quantidade: 5, custo_unitario: null },  // cm=null
    ];
    const r = montarCelulasComboEVP({ combos: combos2, capitalClientes: [{ cliente: 'A', ar_medio: 2000 }], capitalSKUs: [{ sku: '1', estoque_valor: 500 }, { sku: '2', estoque_valor: 300 }], k: null });
    const celSemCusto = r.celulas.find((c) => c.sku === '2')!;
    expect(celSemCusto.cm).toBeNull();      // custo ausente
    expect(celSemCusto.evp).toBeNull();
    expect(celSemCusto.encargo).toBeNull(); // hurdle ausente
    expect(r.porCliente[0].cm).toBe(500);   // só a célula com custo
    expect(r.porCliente[0].encargo).toBeNull();
    expect(r.porCliente[0].encargo_total).toBeNull();
    expect(r.porCliente[0].evp).toBeNull();
  });
});

describe('recomendarAcaoComercial — hurdle_indisponivel', () => {
  const config = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };
  it('hurdle ausente: evp null NÃO dispara "crescer"; "Subir preço" dispara por margem; SEM nota por-cliente (vive na confiança/UI, não vaza pro A4)', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: 100, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel: true });
    expect(r.some((x) => x.acao === 'Subir preço')).toBe(true); // cm 10% < 15%
    expect(r.some((x) => x.acao === 'Crescer / proteger')).toBe(false);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false); // NÃO existe — evita vazamento pro A4
  });
  it('hurdle ausente + desconto excessivo → "Cortar desconto" com motivo hurdle-aware (sem prometer EVP)', () => {
    const r = recomendarAcaoComercial({ evp: null, receita_liquida: 800, cm: 500, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel: true });
    const corte = r.find((x) => x.acao === 'Cortar desconto');
    expect(corte).toBeTruthy();
    expect(corte!.motivo.toLowerCase()).toContain('lucro econômico indisponível');
  });
  it('hurdle presente (default): comportamento atual — evp>0 → "Crescer"', () => {
    const r = recomendarAcaoComercial({ evp: 50, receita_liquida: 1000, cm: 300, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config });
    expect(r.some((x) => x.acao === 'Crescer / proteger')).toBe(true);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false);
  });
  it('REGRESSÃO: hurdle PRESENTE + evp null por CUSTO ausente + desconto>max → "Cortar desconto" AINDA aparece (motivo original)', () => {
    const r = recomendarAcaoComercial({ evp: null, cm: null, receita_liquida: 800, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config });
    expect(r.some((x) => x.acao === 'Cortar desconto')).toBe(true);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false);
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte.motivo.toLowerCase()).toContain('não gera valor');
  });
});
