import { describe, it, expect } from 'vitest';
import { margemContribuicao, arMedioTTM, montarCelulasComboEVP, recomendarAcaoComercial, scoreConfiancaCockpit } from '../valor-cockpit-helpers';

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

describe('arMedioTTM', () => {
  const win = { ttm_inicio: '2025-06-01', ttm_fim: '2026-06-01' }; // 365 dias
  it('título aberto a janela inteira: média ≈ saldo', () => {
    const a = arMedioTTM({
      titulos: [{ valor_documento: 1000, saldo: 1000, data_emissao: '2025-06-01', data_recebimento: null, status: 'ABERTO' }],
      ...win,
    });
    expect(a).toBeCloseTo(1000, 0);
  });
  it('título recebido na metade: contribui metade do tempo', () => {
    const a = arMedioTTM({
      titulos: [{ valor_documento: 1000, saldo: 0, data_emissao: '2025-06-01', data_recebimento: '2025-12-01', status: 'RECEBIDO' }],
      ...win,
    });
    // ~183 dias aberto / 365 × 1000 ≈ 501
    expect(a).toBeGreaterThan(450);
    expect(a).toBeLessThan(550);
  });
  it('sem data_emissao → ignora o título', () => {
    expect(arMedioTTM({ titulos: [{ valor_documento: 9999, saldo: 9999, data_emissao: null, data_recebimento: null, status: 'ABERTO' }], ...win })).toBe(0);
  });
  it('sem títulos → 0', () => {
    expect(arMedioTTM({ titulos: [], ...win })).toBe(0);
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
    expect(r.empresa.evp!).toBeCloseTo(r.empresa.cm! - r.empresa.encargo, 6);
    // e por rollup:
    for (const c of r.porCliente) if (c.cm != null && c.evp != null) expect(c.evp).toBeCloseTo(c.cm - c.encargo, 6);
    for (const s of r.porSKU) if (s.cm != null && s.evp != null) expect(s.evp).toBeCloseTo(s.cm - s.encargo, 6);
    // encargo_total inclui a célula sem custo → ≥ encargo relevante-ao-EVP:
    expect(r.empresa.encargo_total).toBeGreaterThanOrEqual(r.empresa.encargo - 1e-9);
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
});
