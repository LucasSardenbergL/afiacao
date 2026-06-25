import { describe, it, expect } from 'vitest';
import { margemContribuicao, arMedioTTM, statusLiquidadoAR, montarCelulasComboEVP, recomendarAcaoComercial, scoreConfiancaCockpit, resolverHurdleCockpit, pedidoContaNoFaturamento, tituloFaturavelAR, coberturaBidirecional } from '../valor-cockpit-helpers';

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
  it('receita ou quantidade não-finita → null (cm NaN é fabricação)', () => {
    expect(margemContribuicao({ receita_liquida: NaN, custo_unitario: 6, quantidade: 100 })).toBeNull();
    expect(margemContribuicao({ receita_liquida: 1000, custo_unitario: 6, quantidade: Infinity })).toBeNull();
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

describe('tituloFaturavelAR (denominador de cobertura — simetria do AR)', () => {
  it('RECEBIDO/A VENCER/ATRASADO/VENCE HOJE → conta', () => {
    for (const s of ['RECEBIDO', 'A VENCER', 'ATRASADO', 'VENCE HOJE']) expect(tituloFaturavelAR(s)).toBe(true);
  });
  it('CANCELADO → NÃO conta (simetria com pedido cancelado no numerador)', () => {
    expect(tituloFaturavelAR('CANCELADO')).toBe(false);
  });
  it('status novo/desconhecido → conta por default (blocklist semântica, não subconta)', () => {
    expect(tituloFaturavelAR('PROTESTADO')).toBe(true);
  });
  it('NULL/undefined → CONTA (não infla a cobertura; AR sempre tem status no Omie)', () => {
    expect(tituloFaturavelAR(null)).toBe(true);
    expect(tituloFaturavelAR(undefined)).toBe(true);
  });
});

describe('coberturaBidirecional (dois sinais)', () => {
  it('receita > AR: ar_por_app satura em 1, app_por_ar < 1', () => {
    expect(coberturaBidirecional({ receita: 5_059_623, arFaturavel: 4_054_820 })).toEqual({
      ar_por_app: 1,
      app_por_ar: Math.min(1, 4_054_820 / 5_059_623),
    });
  });
  it('AR > receita: inverso', () => {
    const r = coberturaBidirecional({ receita: 4, arFaturavel: 5 });
    expect(r.ar_por_app).toBeCloseTo(0.8, 6);
    expect(r.app_por_ar).toBe(1);
  });
  it('iguais → ambos 1', () => {
    expect(coberturaBidirecional({ receita: 5, arFaturavel: 5 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
  });
  it('AR ausente (arFaturavel ≤ 0) → ambos 1 (não fabrica penalidade de ausência — Codex)', () => {
    expect(coberturaBidirecional({ receita: 5, arFaturavel: 0 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
  });
  it('receita 0 (sem venda) → app_por_ar=1', () => {
    expect(coberturaBidirecional({ receita: 0, arFaturavel: 5 }).app_por_ar).toBe(1);
  });
  it('entrada negativa → {1,1} (dado inválido não vira % absurda — Codex)', () => {
    expect(coberturaBidirecional({ receita: -100, arFaturavel: 1000 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
    expect(coberturaBidirecional({ receita: 1000, arFaturavel: -100 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
  });
  it('entrada não-finita → {1,1} (não fabrica penalidade)', () => {
    expect(coberturaBidirecional({ receita: NaN, arFaturavel: 5 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
    expect(coberturaBidirecional({ receita: 5, arFaturavel: Infinity })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
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

  it('INVARIANTE de soma: Σ porCliente.evp_teto = Σ porSKU.evp_teto = empresa.evp_teto_total (teto é aditivo)', () => {
    const r = montarCelulasComboEVP(base); // base toda completa → evp afirmável == teto == conhecido
    const somaCli = r.porCliente.reduce((s, x) => s + (x.evp_teto ?? 0), 0);
    const somaSku = r.porSKU.reduce((s, x) => s + (x.evp_teto ?? 0), 0);
    expect(somaCli).toBeCloseTo(r.empresa.evp_teto_total!, 6);
    expect(somaSku).toBeCloseTo(r.empresa.evp_teto_total!, 6);
    expect(somaCli).toBeCloseTo(somaSku, 6);
    // sem omissão → o evp afirmável agregado fecha com evp_conhecido e empresa.evp
    expect(r.porCliente.reduce((s, x) => s + (x.evp ?? 0), 0)).toBeCloseTo(r.empresa.evp_conhecido!, 6);
    expect(r.empresa.evp).toBeCloseTo(r.empresa.evp_conhecido!, 6);
  });

  it('IDENTIDADE CONTÁBIL: empresa.evp_teto_total = empresa.cm − empresa.encargo, mesmo com célula de custo nulo', () => {
    // Um combo SEM custo (cm null) não quebra a identidade do TETO (aditivo): seu encargo entra só em encargo_total.
    const r = montarCelulasComboEVP({
      ...base,
      combos: [
        ...base.combos,
        { cliente: 'C2', sku: 'S2', receita_liquida: 500, quantidade: 30, custo_unitario: null }, // cm null
      ],
    });
    expect(r.empresa.cm).not.toBeNull();
    expect(r.empresa.evp).toBeNull();            // cm_incompleto → não finge total (Codex 2026-06-23)
    expect(r.empresa.evp_teto_total).not.toBeNull();
    // identidade do teto fecha usando o encargo relevante-ao-EVP (só células com cm):
    expect(r.empresa.evp_teto_total!).toBeCloseTo(r.empresa.cm! - r.empresa.encargo!, 6);
    for (const c of r.porCliente) if (c.cm != null && c.evp_teto != null) expect(c.evp_teto).toBeCloseTo(c.cm - c.encargo!, 6);
    for (const s of r.porSKU) if (s.cm != null && s.evp_teto != null) expect(s.evp_teto).toBeCloseTo(s.cm - s.encargo!, 6);
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

  it('AR do cliente null → a_cs 0 + ar_indisponivel + capital_parcial; teto>0 (só estoque) → omitido', () => {
    const r = montarCelulasComboEVP({
      ...base,
      capitalClientes: [{ cliente: 'C1', ar_medio: null }, { cliente: 'C2', ar_medio: 1000 }],
    });
    const c1 = r.celulas.find((c) => c.cliente === 'C1')!;
    expect(c1.a_cs).toBe(0);
    expect(c1.ar_indisponivel).toBe(true);
    expect(c1.capital_parcial).toBe(true);
    expect(c1.evp_status).toBe('omitido_teto_positivo'); // só encargo de estoque → teto>0 → não afirma
    expect(c1.evp).toBeNull();
  });
});

describe('montarCelulasComboEVP — guards + status (teto)', () => {
  const base = {
    combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }], // cm 400
    capitalClientes: [{ cliente: 'C1', ar_medio: 600 }],
    capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }],
    k: 0.2,
  };
  it('estoque ausente + cm + k → evp_teto numérico, evp omitido (teto>0), capital_parcial', () => {
    const c = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: null }] }).celulas[0];
    expect(c.evp_teto).not.toBeNull();
    expect(c.evp).toBeNull();
    expect(c.evp_status).toBe('omitido_teto_positivo');
    expect(c.capital_parcial).toBe(true);
    expect(c.estoque_indisponivel).toBe(true);
  });
  it('AR ausente → capital_parcial=true (teto>0 → omitido)', () => {
    const c = montarCelulasComboEVP({ ...base, capitalClientes: [{ cliente: 'C1', ar_medio: null }] }).celulas[0];
    expect(c.capital_parcial).toBe(true);
    expect(c.evp_status).toBe('omitido_teto_positivo');
  });
  it('célula limpa (AR+estoque ok) → capital_parcial=false, status real', () => {
    const c = montarCelulasComboEVP(base).celulas[0];
    expect(c.capital_parcial).toBe(false);
    expect(c.evp_status).toBe('real');
  });
  it('estoque_valor=0 CONHECIDO → capital_parcial=false (zero conhecido ≠ ausente), status real', () => {
    const c = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: 0 }] }).celulas[0];
    expect(c.estoque_indisponivel).toBe(false);
    expect(c.capital_parcial).toBe(false);
    expect(c.evp_status).toBe('real');
  });
  it('k inválido (k<0 / NaN / 0) → encargo, evp e evp_teto null; status indisponivel_hurdle', () => {
    for (const k of [-0.1, NaN, 0]) {
      const c = montarCelulasComboEVP({ ...base, k }).celulas[0];
      expect(c.encargo).toBeNull();
      expect(c.evp).toBeNull();
      expect(c.evp_teto).toBeNull();
      expect(c.evp_status).toBe('indisponivel_hurdle');
    }
  });
  it('capital negativo ou não-finito → indisponível (não número sujo); teto não vira piso', () => {
    const neg = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: -500 }] }).celulas[0];
    expect(neg.estoque_indisponivel).toBe(true);
    expect(neg.i_cs).toBe(0);
    expect(neg.capital_parcial).toBe(true);
    const nan = montarCelulasComboEVP({ ...base, capitalClientes: [{ cliente: 'C1', ar_medio: NaN }] }).celulas[0];
    expect(nan.ar_indisponivel).toBe(true);
    expect(nan.a_cs).toBe(0);
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
  it('app_por_ar < 0,5 → rebaixa para média com motivo de divergência', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, cobertura_app_por_ar: 0.4 });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('sem ar faturável'))).toBe(true);
  });
  it('app_por_ar exatamente 0,5 → NÃO penaliza (fronteira estrita < 0,5)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, cobertura_app_por_ar: 0.5 });
    expect(r.nivel).toBe('alta');
  });
  it('app_por_ar 0,80 (Oben hoje) → NÃO penaliza', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, cobertura_app_por_ar: 0.8 });
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
  it('custo de baixa confiança ≥20% → rebaixa p/ média + motivo (não baixa sozinho)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, custo_baixa_confianca_pct: 0.22 });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('proxy') || m.toLowerCase().includes('estimado'))).toBe(true);
  });
  it('baixa confiança nunca derruba sozinha abaixo de média (>40% ainda média)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, custo_baixa_confianca_pct: 0.6 });
    expect(r.nivel).toBe('media');
  });
  it('baixa confiança 5–20% → só motivo informativo, mantém alta', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, custo_baixa_confianca_pct: 0.1 });
    expect(r.nivel).toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('informativo'))).toBe(true);
  });
  it('custo_baixa_confianca_pct ausente (default 0) → não afeta (retrocompat)', () => {
    const r = scoreConfiancaCockpit({ cobertura_receita: 0.95, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false });
    expect(r.nivel).toBe('alta');
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
  it('REGRESSÃO: hurdle PRESENTE + evp null por CUSTO ausente + desconto>max → "Cortar desconto" AINDA aparece (motivo honesto: margem ausente, NÃO "não gera valor")', () => {
    const r = recomendarAcaoComercial({ evp: null, cm: null, receita_liquida: 800, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config });
    expect(r.some((x) => x.acao === 'Cortar desconto')).toBe(true);
    expect(r.some((x) => x.acao === 'Configurar hurdle')).toBe(false);
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    // cm ausente ≠ "não gera valor" (margem desconhecida) — motivo preciso (Codex 2026-06-23)
    expect(corte.motivo.toLowerCase()).toContain('margem indisponível');
  });
});

// Régua de faturabilidade do pedido pai, espelhada VERBATIM de v_caca_candidatos/v_caca_compradores
// (positivação/comissão): WHERE deleted_at IS NULL AND status <> ALL(ARRAY['cancelado','rascunho']).
// É o guard do bug do cockpit de valor (contava cancelado como faturamento → R$615M de inflação).
describe('pedidoContaNoFaturamento (espelha a régua de v_caca)', () => {
  it('pedido vivo e faturado → conta', () => {
    expect(pedidoContaNoFaturamento('faturado', null)).toBe(true);
  });
  it('cancelado → NÃO conta (cerne do bug: pedido cancelado não é faturamento)', () => {
    expect(pedidoContaNoFaturamento('cancelado', null)).toBe(false);
  });
  it('rascunho → NÃO conta (pedido não-firme; alinhado a v_caca)', () => {
    expect(pedidoContaNoFaturamento('rascunho', null)).toBe(false);
  });
  it('status NOVO desconhecido (ex.: "entregue") → CONTA por default (blocklist semântica — NÃO subconta silenciosamente; Codex 2026-06-18)', () => {
    expect(pedidoContaNoFaturamento('entregue', null)).toBe(true);
  });
  it('soft-deletado (deleted_at preenchido) → NÃO conta, mesmo com status faturado', () => {
    expect(pedidoContaNoFaturamento('faturado', '2026-02-10T00:00:00Z')).toBe(false);
  });
  it('status NULL → NÃO conta (espelha o NULL <> ALL do WHERE de v_caca, que não passa em NULL)', () => {
    expect(pedidoContaNoFaturamento(null, null)).toBe(false);
  });
  it('status undefined → NÃO conta', () => {
    expect(pedidoContaNoFaturamento(undefined, null)).toBe(false);
  });
});

describe('montarCelulasComboEVP — rollup decomposto + pcts por receita', () => {
  const combos = [
    { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }, // completa, cm 400
    { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 50, custo_unitario: 10 },  // S2 sem estoque → teto>0 omitido
  ];
  const capCli = [{ cliente: 'C1', ar_medio: 600 }];
  const capSku = [{ sku: 'S1', estoque_valor: 800 }]; // S2 ausente
  it('rollup: evp_incompleto se ∃ célula omitida; evp afirmável EXCLUI a omitida; evp_teto inclui todas', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    const rc = r.porCliente.find((x) => x.cliente === 'C1')!;
    const s1 = r.celulas.find((c) => c.sku === 'S1')!;
    const s2 = r.celulas.find((c) => c.sku === 'S2')!;
    expect(s2.evp_status).toBe('omitido_teto_positivo');
    expect(rc.evp_incompleto).toBe(true);
    expect(rc.evp).toBeCloseTo(s1.evp!, 6);                       // só a afirmável (S2 omitida fora)
    expect(rc.evp_teto).toBeCloseTo(s1.evp_teto! + s2.evp_teto!, 6);
    expect(rc.cm_incompleto).toBe(false);
  });
  it('cm_incompleto=true quando o grupo tem célula sem custo', () => {
    const r = montarCelulasComboEVP({
      combos: [...combos, { cliente: 'C1', sku: 'S3', receita_liquida: 500, quantidade: 10, custo_unitario: null }],
      capitalClientes: capCli, capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }, { sku: 'S2', estoque_valor: 400 }, { sku: 'S3', estoque_valor: 100 }], k: 0.2,
    });
    expect(r.porCliente[0].cm_incompleto).toBe(true);
  });
  it('pcts por receita: omitido (S2 = 1000 de 2000) = 0.5; conhecido (S1) = 0.5', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.evp_omitido_otimista_receita_pct).toBeCloseTo(0.5, 6);
    expect(r.evp_conhecido_receita_pct).toBeCloseTo(0.5, 6);
    expect(r.evp_perda_garantida_receita_pct).toBeCloseTo(0, 6);
  });
  it('sem hurdle (k=null) → pct omitido = 0 (status indisponivel_hurdle, não omitido); empresa.evp_incompleto=false', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: null });
    expect(r.evp_omitido_otimista_receita_pct).toBe(0);
    expect(r.empresa.evp_incompleto).toBe(false);
  });
  it('empresa.evp_incompleto agrega o global; cm_incompleto=false aqui; evp=null por omissão', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    expect(r.empresa.evp_incompleto).toBe(true);
    expect(r.empresa.cm_incompleto).toBe(false);
    expect(r.empresa.evp).toBeNull();
  });
});

describe('recomendarAcaoComercial — assimetria (evp_incompleto) e cm_incompleto', () => {
  const config = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };
  it('evp>0 completo (não-incompleto, cm completa) → "Crescer / proteger" puro', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc).toBeTruthy();
    expect(cresc.motivo).not.toMatch(/confirmar|omitido|parcial/i);
  });
  it('evp>0 mas evp_incompleto → "Crescer / proteger" QUALIFICADO (não silencia, não afirma)', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, evp_incompleto: true });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc).toBeTruthy();
    expect(cresc.motivo.toLowerCase()).toContain('capital');
    expect(cresc.motivo.toLowerCase()).toContain('confirmar');
  });
  it('evp>0 mas cm_incompleto → "Crescer / proteger" qualificado (margem parcial)', () => {
    const r = recomendarAcaoComercial({ evp: 300, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 0, dias_estoque: 0, config, cm_incompleto: true });
    const cresc = r.find((x) => x.acao === 'Crescer / proteger')!;
    expect(cresc.motivo.toLowerCase()).toContain('margem');
  });
  it('alerta negativo dispara só com evp<0 CONHECIDO (inclui perda garantida), não evp==null', () => {
    const comNull = recomendarAcaoComercial({ evp: null, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 90, dias_estoque: 200, config });
    expect(comNull.some((x) => x.acao.includes('prazo') || x.acao.includes('Despriorizar'))).toBe(false);
    const comNeg = recomendarAcaoComercial({ evp: -10, receita_liquida: 1000, cm: 400, desconto_total: 0, prazo_medio_dias: 90, dias_estoque: 200, config });
    expect(comNeg.some((x) => x.acao.includes('prazo'))).toBe(true);
    expect(comNeg.some((x) => x.acao.includes('Despriorizar'))).toBe(true);
  });
  it('desconto>max + evp>0 mas evp_incompleto → "Cortar desconto" (otimismo não blinda) com motivo "não medido", NÃO "não gera valor"', () => {
    const r = recomendarAcaoComercial({ evp: 50, receita_liquida: 800, cm: 500, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config, evp_incompleto: true });
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte).toBeTruthy();
    expect(corte.motivo.toLowerCase()).toContain('não medido');
    expect(corte.motivo.toLowerCase()).not.toContain('não gera valor'); // seria FALSO (Codex 2026-06-23)
  });
});

describe('scoreConfiancaCockpit — evp_omitido_otimista_receita_pct', () => {
  const okBase = { cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false };
  it('omitido por receita > 5% → rebaixa para média + motivo', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_omitido_otimista_receita_pct: 0.094 }); // caso Oben (~9,5%)
    expect(r.nivel).toBe('media');
    expect(r.motivos.some((m) => m.toLowerCase().includes('omitido'))).toBe(true);
  });
  it('0 < omitido <= 5% → só motivo, não rebaixa nível', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_omitido_otimista_receita_pct: 0.03 });
    expect(r.nivel).toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('omitido'))).toBe(true);
  });
  it('omitido = 0 → sem motivo de omissão, alta', () => {
    const r = scoreConfiancaCockpit({ ...okBase, evp_omitido_otimista_receita_pct: 0 });
    expect(r.nivel).toBe('alta');
    expect(r.motivos.some((m) => m.toLowerCase().includes('omitido'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-06-23 — Omissão honesta do EVP otimista (capital parcial). Ke da Oben VIVO
// (k=0,30). Sucede #961: assimetria no NÚMERO (teto>0 omitido; teto≤0 mantido) +
// agregado decomposto + guard de alocação não-negativa da perna AUSENTE (Codex).
// ═══════════════════════════════════════════════════════════════════════════
describe('montarCelulasComboEVP — célula: assimetria teto± + status', () => {
  const base = {
    combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }], // cm 400
    capitalClientes: [{ cliente: 'C1', ar_medio: 600 }],
    capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }],
    k: 0.2,
  };
  it('célula COMPLETA → evp = evp_teto (real), status "real", capital_parcial=false', () => {
    const c = montarCelulasComboEVP(base).celulas[0];
    // a_cs=600, i_cs=800, encargo=0.2·1400=280, teto=400−280=120
    expect(c.evp_teto).toBeCloseTo(120, 6);
    expect(c.evp).toBeCloseTo(120, 6);
    expect(c.evp_status).toBe('real');
    expect(c.capital_parcial).toBe(false);
  });
  it('PARCIAL com teto>0 (estoque ausente) → evp NULL, status "omitido_teto_positivo", evp_teto PRESERVADO', () => {
    const c = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: null }] }).celulas[0];
    // i_cs=0, encargo=0.2·600=120, teto=400−120=280 (>0)
    expect(c.evp_teto).toBeCloseTo(280, 6);
    expect(c.evp).toBeNull();                       // otimista → NÃO afirma
    expect(c.evp_status).toBe('omitido_teto_positivo');
    expect(c.capital_parcial).toBe(true);
    expect(c.estoque_indisponivel).toBe(true);
  });
  it('PARCIAL com teto≤0 (AR alto, estoque ausente) → evp MANTIDO, status "teto_nao_positivo" (perda garantida)', () => {
    const c = montarCelulasComboEVP({
      ...base, capitalClientes: [{ cliente: 'C1', ar_medio: 2500 }], capitalSKUs: [{ sku: 'S1', estoque_valor: null }],
    }).celulas[0];
    // a_cs=2500, i_cs=0, encargo=0.2·2500=500, teto=400−500=−100 (≤0) → real ≤ −100
    expect(c.evp_teto).toBeCloseTo(-100, 6);
    expect(c.evp).toBeCloseTo(-100, 6);             // prejuízo garantido NÃO se esconde
    expect(c.evp_status).toBe('teto_nao_positivo');
    expect(c.capital_parcial).toBe(true);
  });
  it('GUARD alocação: estoque ausente + quantidade<0 + teto≤0 → evp NULL (NÃO mantido), pois 0 não é piso do i_cs real', () => {
    // cm=10−6·(−10)=70 ; a_cs=2000, encargo=400, teto=70−400=−330 (≤0) mas qtd<0 invalida o teto
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 10, quantidade: -10, custo_unitario: 6 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 2000 }], capitalSKUs: [{ sku: 'S1', estoque_valor: null }], k: 0.2,
    }).celulas[0];
    expect(c.evp_teto).toBeCloseTo(-330, 6);        // teto bruto existe…
    expect(c.evp).toBeNull();                       // …mas NÃO é upper bound confiável → omitido
    expect(c.evp_status).toBe('omitido_teto_positivo');
  });
  it('GUARD preciso (não conservador): perna PRESENTE negativa NÃO invalida — perna AUSENTE ok → teto≤0 MANTIDO', () => {
    // 2 combos C1: A normal (rc>0); B devolução (receita<0) com estoque ausente. a_cs_B fica negativo,
    // mas a perna AUSENTE é estoque e qtd_B>0 → i_cs real ≥0 → teto AINDA é upper bound → mantém.
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'C1', sku: 'SA', receita_liquida: 5000, quantidade: 100, custo_unitario: 6 },   // cm 4400
        { cliente: 'C1', sku: 'SB', receita_liquida: -1000, quantidade: 10, custo_unitario: 6 },   // cm −1060, estoque ausente
      ],
      capitalClientes: [{ cliente: 'C1', ar_medio: 2000 }],
      capitalSKUs: [{ sku: 'SA', estoque_valor: 800 }], // SB ausente
      k: 0.2,
    });
    const b = r.celulas.find((c) => c.sku === 'SB')!;
    // rc=4000; a_cs_B=2000·(−1000/4000)=−500; encargo_B=0.2·(−500)=−100; teto_B=−1060−(−100)=−960 (≤0)
    expect(b.evp_teto).toBeCloseTo(-960, 6);
    expect(b.evp).toBeCloseTo(-960, 6);             // qtd_B≥0 → estoque-perna válida → mantém
    expect(b.evp_status).toBe('teto_nao_positivo');
  });
  it('k=null → status "indisponivel_hurdle", evp e evp_teto null, capital_parcial reflete a fonte', () => {
    const c = montarCelulasComboEVP({ ...base, capitalSKUs: [{ sku: 'S1', estoque_valor: null }], k: null }).celulas[0];
    expect(c.evp).toBeNull();
    expect(c.evp_teto).toBeNull();
    expect(c.evp_status).toBe('indisponivel_hurdle');
  });
  it('custo ausente → status "indisponivel_cm", evp/evp_teto null', () => {
    const c = montarCelulasComboEVP({ ...base, combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: null }] }).celulas[0];
    expect(c.cm).toBeNull();
    expect(c.evp).toBeNull();
    expect(c.evp_teto).toBeNull();
    expect(c.evp_status).toBe('indisponivel_cm');
  });
});

describe('montarCelulasComboEVP — rollup/empresa decompostos', () => {
  // C1: S1 limpa (cm400, teto+ real) ; S2 estoque ausente teto+ (omitido) ; S3 AR-alto teto≤0 (perda garantida)
  const combos = [
    { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 },  // completa
    { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 50, custo_unitario: 10 },   // estoque ausente
  ];
  const capCli = [{ cliente: 'C1', ar_medio: 600 }];
  const capSku = [{ sku: 'S1', estoque_valor: 800 }]; // S2 ausente
  it('rollup.evp EXCLUI célula omitida (teto>0); evp_teto INCLUI todas; evp_incompleto=true', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    const s1 = r.celulas.find((c) => c.sku === 'S1')!;
    const s2 = r.celulas.find((c) => c.sku === 'S2')!;
    expect(s2.evp_status).toBe('omitido_teto_positivo'); // S2 teto>0 omitido
    const rc = r.porCliente.find((x) => x.cliente === 'C1')!;
    expect(rc.evp).toBeCloseTo(s1.evp!, 6);            // só a real entra (S2 omitida)
    expect(rc.evp_teto).toBeCloseTo(s1.evp_teto! + s2.evp_teto!, 6); // teto soma todas
    expect(rc.evp_incompleto).toBe(true);
  });
  it('empresa: evp=null (há omissão); evp_conhecido só reais; evp_teto_total todas; evp_perda_garantida só teto≤0', () => {
    // adiciona S3 perda garantida (AR alto p/ C2, estoque ausente)
    const r = montarCelulasComboEVP({
      combos: [...combos, { cliente: 'C2', sku: 'S3', receita_liquida: 500, quantidade: 10, custo_unitario: 60 }], // cm 500−600=−100
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }, { cliente: 'C2', ar_medio: 4000 }],
      capitalSKUs: capSku, // S2 e S3 ausentes
      k: 0.2,
    });
    const s1 = r.celulas.find((c) => c.sku === 'S1')!;
    const s3 = r.celulas.find((c) => c.sku === 'S3')!;
    expect(s3.evp_status).toBe('teto_nao_positivo'); // C2 ar=4000 alto → teto≤0
    expect(r.empresa.evp).toBeNull();                                    // há fatia omitida → não finge total
    expect(r.empresa.evp_conhecido).toBeCloseTo(s1.evp!, 6);            // só S1 real
    expect(r.empresa.evp_teto_total).toBeCloseTo(r.celulas.reduce((s, c) => s + (c.evp_teto ?? 0), 0), 6);
    expect(r.empresa.evp_perda_garantida).toBeCloseTo(s3.evp!, 6);      // só S3
    expect(r.empresa.evp_incompleto).toBe(true);
  });
  it('empresa SEM omissão (tudo completo) → evp = evp_conhecido (não null)', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }], k: 0.2,
    });
    expect(r.empresa.evp_incompleto).toBe(false);
    expect(r.empresa.evp).toBeCloseTo(r.empresa.evp_conhecido!, 6);
    expect(r.empresa.evp).toBeCloseTo(120, 6);
  });
  it('pcts por RECEITA (denominador = receita total): omitido/conhecido/perda/sem-cm somam coerente', () => {
    const r = montarCelulasComboEVP({ combos, capitalClientes: capCli, capitalSKUs: capSku, k: 0.2 });
    // receita total 2000; S1 real (1000) conhecido; S2 omitido (1000)
    expect(r.evp_conhecido_receita_pct).toBeCloseTo(0.5, 6);
    expect(r.evp_omitido_otimista_receita_pct).toBeCloseTo(0.5, 6);
    expect(r.evp_perda_garantida_receita_pct).toBeCloseTo(0, 6);
    expect(r.sem_cm_receita_pct).toBeCloseTo(0, 6);
  });
});

// Follow-up /codex challenge 2026-06-23 (3 achados incorporados):
describe('montarCelulasComboEVP — guard de DENOMINADOR de alocação (P1 Codex)', () => {
  it('perna ausente por rc<=0 (devolução no cliente) + teto≤0 → OMITE (não fabrica perda garantida)', () => {
    // C1: A (+1000, sku SA com estoque alto) e B (devolução -2000). rc=-1000 → AR de A "ausente" por rc<=0.
    // teto_A = cm 400 − 0.2·i_cs(2500) = −100 ≤0. SEM o guard de denominador isso viraria 'teto_nao_positivo'
    // FALSO: a alocação real de AR (receita_A/rc = 1000/−1000) seria negativa → encargo real < teto → real > teto.
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'C1', sku: 'SA', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }, // cm 400
        { cliente: 'C1', sku: 'SB', receita_liquida: -2000, quantidade: 50, custo_unitario: 0 },  // devolução → rc=-1000
      ],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }],
      capitalSKUs: [{ sku: 'SA', estoque_valor: 2500 }], // SB ausente
      k: 0.2,
    });
    const a = r.celulas.find((c) => c.sku === 'SA')!;
    expect(a.ar_indisponivel).toBe(true);   // rc<=0 torna a perna AR indisponível
    expect(a.evp_teto).toBeCloseTo(-100, 6);
    expect(a.evp).toBeNull();               // denominador inválido → omite, NÃO mantém
    expect(a.evp_status).toBe('omitido_teto_positivo');
  });
});

describe('recomendarAcaoComercial — motivo combinado evp<0 + evp_incompleto (P1 Codex)', () => {
  const config = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };
  it('desconto>max + evp<0 E evp_incompleto → motivo reconhece a fatia NÃO MEDIDA (não afirma só "não gera valor")', () => {
    const r = recomendarAcaoComercial({ evp: -50, receita_liquida: 800, cm: 100, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config, evp_incompleto: true });
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte).toBeTruthy();
    expect(corte.motivo.toLowerCase()).toContain('não medida'); // a parte omitida pode ser positiva → não confirmável
  });
  it('evp<0 SEM evp_incompleto → "não gera valor" puro (sem fatia omitida, afirmação válida)', () => {
    const r = recomendarAcaoComercial({ evp: -50, receita_liquida: 800, cm: 100, desconto_total: 200, prazo_medio_dias: 0, dias_estoque: 0, config });
    const corte = r.find((x) => x.acao === 'Cortar desconto')!;
    expect(corte.motivo.toLowerCase()).toContain('não gera valor');
    expect(corte.motivo.toLowerCase()).not.toContain('não medida');
  });
});

describe('montarCelulasComboEVP — rollup.perda_garantida (P2 Codex: UI sinaliza teto≤0)', () => {
  it('grupo só com teto≤0 mantido → perda_garantida=true, evp_incompleto=false (evp é teto; real pode ser pior)', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }], // cm 400
      capitalClientes: [{ cliente: 'C1', ar_medio: 2500 }], capitalSKUs: [{ sku: 'S1', estoque_valor: null }], k: 0.2,
    });
    expect(r.celulas[0].evp_status).toBe('teto_nao_positivo'); // teto = 400 − 0.2·2500 = −100
    expect(r.porCliente[0].perda_garantida).toBe(true);
    expect(r.porCliente[0].evp_incompleto).toBe(false);
  });
  it('grupo limpo (real) → perda_garantida=false', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 800 }], k: 0.2,
    });
    expect(r.porCliente[0].perda_garantida).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-06-24 — Bônus: sensibilidade do EVP ao hurdle (combos no fio da navalha).
// Granularidade por combo REAL (capital completo) — o agregado é robusto e MASCARA os frágeis (Codex).
// hurdle_break_even = cm/capital_cs (o k onde evp=0); sensível = break_even na banda [k−δ, k+δ], δ=0,05.
// Parciais FORA desta entrega (classificação muda com k). 30% é o número principal.
// ═══════════════════════════════════════════════════════════════════════════
describe('montarCelulasComboEVP — sensibilidade ao hurdle (célula real)', () => {
  // k=0,30, banda default 0,05 → banda [0,25; 0,35]
  it('break_even DENTRO da banda → sensivel_hurdle=true + break_even + folga', () => {
    // cm=300 (1000−7·100); a_cs=650, i_cs=400 → capital_cs=1050; break_even=300/1050≈0,2857 ∈ [0,25;0,35]
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 650 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    }).celulas[0];
    expect(c.capital_cs).toBeCloseTo(1050, 6);
    expect(c.evp_status).toBe('real');
    expect(c.hurdle_break_even).toBeCloseTo(300 / 1050, 6);
    expect(c.sensivel_hurdle).toBe(true);
    expect(c.folga_hurdle_pp).toBeCloseTo(300 / 1050 - 0.30, 6); // negativa: break-even abaixo do hurdle atual
  });
  it('break_even ACIMA da banda (robustamente bom) → sensivel_hurdle=false', () => {
    // cm=500; capital=1000 → break_even=0,50 > 0,35
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 5 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    }).celulas[0];
    expect(c.hurdle_break_even).toBeCloseTo(0.5, 6);
    expect(c.sensivel_hurdle).toBe(false);
    expect(c.folga_hurdle_pp).toBeCloseTo(0.2, 6); // folga positiva
  });
  it('break_even ABAIXO da banda (robustamente ruim) → sensivel_hurdle=false', () => {
    // cm=100; capital=1000 → break_even=0,10 < 0,25
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 9 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    }).celulas[0];
    expect(c.hurdle_break_even).toBeCloseTo(0.1, 6);
    expect(c.sensivel_hurdle).toBe(false);
  });
  it('célula PARCIAL (estoque ausente) → break_even null, sensivel_hurdle false (fora do escopo)', () => {
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 650 }], capitalSKUs: [{ sku: 'S1', estoque_valor: null }], k: 0.30,
    }).celulas[0];
    expect(c.evp_status).not.toBe('real');
    expect(c.hurdle_break_even).toBeNull();
    expect(c.sensivel_hurdle).toBe(false);
  });
  it('capital_cs=0 (AR e estoque 0 conhecidos) → break_even null, sensivel false (EVP plano)', () => {
    const c = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 0 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 0 }], k: 0.30,
    }).celulas[0];
    expect(c.evp_status).toBe('real');
    expect(c.capital_cs).toBe(0);
    expect(c.hurdle_break_even).toBeNull();
    expect(c.sensivel_hurdle).toBe(false);
  });
  it('k=null → sem banda, break_even null, sensivel false; hurdle_banda null', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 650 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: null,
    });
    expect(r.celulas[0].sensivel_hurdle).toBe(false);
    expect(r.celulas[0].hurdle_break_even).toBeNull();
    expect(r.hurdle_banda).toBeNull();
  });
  it('hurdle_banda reflete k ± δ (0,30 ± 0,05 = [0,25; 0,35])', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 650 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    });
    expect(r.hurdle_banda).toEqual({ base: 0.30, lo: 0.25, hi: 0.35 });
  });
  it('banda custom (δ=0,10 → [0,20; 0,40]) muda quem é sensível', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 5 }], // break_even 0,50
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30, banda_hurdle: 0.10,
    });
    expect(r.hurdle_banda).toEqual({ base: 0.30, lo: 0.20, hi: 0.40 });
    expect(r.celulas[0].sensivel_hurdle).toBe(false); // 0,50 ainda fora de [0,20;0,40]
  });
  it('BORDA: break_even exatamente em kLo (0,25) e kHi (0,35) → sensível (inclusivo, epsilon contra float)', () => {
    // break_even 0,25: cm=250 (1000−7,5·100), capital=1000 → na borda lo
    const lo = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7.5 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    }).celulas[0];
    expect(lo.hurdle_break_even).toBeCloseTo(0.25, 9);
    expect(lo.sensivel_hurdle).toBe(true);
    // break_even 0,35: cm=350 (1000−6,5·100), capital=1000 → na borda hi
    const hi = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.5 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    }).celulas[0];
    expect(hi.hurdle_break_even).toBeCloseTo(0.35, 9);
    expect(hi.sensivel_hurdle).toBe(true);
  });
});

describe('montarCelulasComboEVP — qtd_combos_sensiveis (granularidade, não agregado)', () => {
  it('rollup conta combos frágeis; agregado robusto NÃO mascara', () => {
    // C1: S1 sensível (be 0,2857), S2 robusto-bom (be 0,50). Soma dos 2 pode ser robusta, mas qtd capta o frágil.
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }, // cm 300
        { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 100, custo_unitario: 5 }, // cm 500
      ],
      capitalClientes: [{ cliente: 'C1', ar_medio: 1300 }], // rc=2000 → a_cs S1=650, S2=650
      capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }, { sku: 'S2', estoque_valor: 400 }],
      k: 0.30,
    });
    const s1 = r.celulas.find((c) => c.sku === 'S1')!;
    const s2 = r.celulas.find((c) => c.sku === 'S2')!;
    expect(s1.sensivel_hurdle).toBe(true);
    expect(s2.sensivel_hurdle).toBe(false);
    expect(r.porCliente[0].qtd_combos_sensiveis).toBe(1);
    expect(r.empresa.qtd_combos_sensiveis).toBe(1);
    expect(r.empresa.capital_conhecido).toBeCloseTo(s1.capital_cs + s2.capital_cs, 6);
  });
  it('k=null → qtd_combos_sensiveis=0 em rollup/empresa; capital_conhecido null', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 650 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: null,
    });
    expect(r.porCliente[0].qtd_combos_sensiveis).toBe(0);
    expect(r.empresa.qtd_combos_sensiveis).toBe(0);
    expect(r.empresa.capital_conhecido).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-06-24 — Bônus P2 (segue #1044): expor a FOLGA ao hurdle p/ os "quase-frágeis".
// Decisão Claude+Codex (xhigh, money-path): NÃO min|folga| (devolveria uma folga NEGATIVA,
// que já está abaixo do hurdle e é sinalizada por evp<0/perda_garantida), e SIM a menor folga
// POSITIVA (break_even − k > 0) entre células 'real' — o combo "parece seguro, está frágil".
// É LOCATOR, não severidade → carrega a receita do combo vencedor p/ contexto (combo ínfimo
// não vira ruído). Banda alternativa rejeitada (só REALOCA a fronteira). Escopo só 'real'.
// ═══════════════════════════════════════════════════════════════════════════
describe('montarCelulasComboEVP — folga_hurdle_min_pp (menor folga POSITIVA; locator)', () => {
  it('combo positivo FORA da banda (blind spot) → folga_min_pp = a folga, + receita do combo', () => {
    // cm=380 (1000−6,2·100); cap=1000 (ar600+est400) → break_even 0,38; folga +0,08 (8pp, fora de [0,25;0,35])
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.2 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    });
    expect(r.celulas[0].sensivel_hurdle).toBe(false);              // NÃO acende na banda
    expect(r.porCliente[0].qtd_combos_sensiveis).toBe(0);          // contagem da banda é cega
    expect(r.porCliente[0].folga_hurdle_min_pp).toBeCloseTo(0.08, 6); // mas a folga REVELA
    expect(r.porCliente[0].folga_hurdle_min_receita).toBeCloseTo(1000, 6);
    expect(r.porSKU[0].folga_hurdle_min_pp).toBeCloseTo(0.08, 6);
    expect(r.empresa.folga_hurdle_min_pp).toBeCloseTo(0.08, 6);
    expect(r.empresa.folga_hurdle_min_receita).toBeCloseTo(1000, 6);
  });
  it('contínuo: combo DENTRO da banda (folga +2pp) é o mais próximo → folga_min = +0,02', () => {
    // cm=320 → break_even 0,32; folga +0,02 (dentro da banda)
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.8 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    });
    expect(r.celulas[0].sensivel_hurdle).toBe(true);
    expect(r.empresa.folga_hurdle_min_pp).toBeCloseTo(0.02, 6);
  });
  it('dois combos → folga_min = o mais próximo (menor folga positiva), não o mais distante', () => {
    // S1 break_even 0,32 (folga +0,02) ; S2 break_even 0,38 (folga +0,08). min = +0,02.
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.8 },
        { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.2 },
      ],
      capitalClientes: [{ cliente: 'C1', ar_medio: 2000 }], // rc=2000 → a_cs 1000 cada
      capitalSKUs: [{ sku: 'S1', estoque_valor: 0 }, { sku: 'S2', estoque_valor: 0 }], k: 0.30,
    });
    expect(r.porCliente[0].folga_hurdle_min_pp).toBeCloseTo(0.02, 6);
  });
  it('FALSIFICAÇÃO min|abs|: folga negativa MENOR em módulo NÃO captura o blind spot positivo', () => {
    // S1 break_even 0,27 → folga −0,03 (|0,03|, JÁ abaixo do hurdle: evp<0); S2 break_even 0,38 → folga +0,08.
    // min|abs| devolveria −0,03 (ERRADO); a métrica certa devolve +0,08 (o combo frágil-mas-positivo).
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 7.3 },
        { cliente: 'C1', sku: 'S2', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.2 },
      ],
      capitalClientes: [{ cliente: 'C1', ar_medio: 2000 }],
      capitalSKUs: [{ sku: 'S1', estoque_valor: 0 }, { sku: 'S2', estoque_valor: 0 }], k: 0.30,
    });
    expect(r.porCliente[0].folga_hurdle_min_pp).toBeCloseTo(0.08, 6); // +0,08, NÃO −0,03
  });
  it('só células com folga NEGATIVA (break_even<k, já-abaixo) → folga_min null (não é blind spot)', () => {
    // cm=200 → break_even 0,20; folga −0,10. EVP já negativo → sinalizado por evp<0/perda; folga_min ignora.
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 8.0 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: 0.30,
    });
    expect(r.porCliente[0].folga_hurdle_min_pp).toBeNull();
    expect(r.porCliente[0].folga_hurdle_min_receita).toBeNull();
    expect(r.empresa.folga_hurdle_min_pp).toBeNull();
  });
  it('k=null → folga_min null em rollup e empresa (ausente ≠ 0)', () => {
    const r = montarCelulasComboEVP({
      combos: [{ cliente: 'C1', sku: 'S1', receita_liquida: 1000, quantidade: 100, custo_unitario: 6.2 }],
      capitalClientes: [{ cliente: 'C1', ar_medio: 600 }], capitalSKUs: [{ sku: 'S1', estoque_valor: 400 }], k: null,
    });
    expect(r.porCliente[0].folga_hurdle_min_pp).toBeNull();
    expect(r.empresa.folga_hurdle_min_pp).toBeNull();
    expect(r.empresa.folga_hurdle_min_receita).toBeNull();
  });
  it('combo ÍNFIMO domina o min (locator, não severidade) → carrega receita p/ a UI contextualizar', () => {
    // CA: receita 48, cm 30, cap 99 → break_even 0,3030, folga +0,0030 (o mais próximo, porém R$48).
    // CB: receita 10000, break_even 0,36, folga +0,06. empresa.folga_min = +0,0030, receita = 48 (não 10000).
    const r = montarCelulasComboEVP({
      combos: [
        { cliente: 'CA', sku: 'SA', receita_liquida: 48, quantidade: 1, custo_unitario: 18 },
        { cliente: 'CB', sku: 'SB', receita_liquida: 10000, quantidade: 100, custo_unitario: 96.4 },
      ],
      capitalClientes: [{ cliente: 'CA', ar_medio: 99 }, { cliente: 'CB', ar_medio: 600 }],
      capitalSKUs: [{ sku: 'SA', estoque_valor: 0 }, { sku: 'SB', estoque_valor: 400 }], k: 0.30,
    });
    expect(r.empresa.folga_hurdle_min_pp).toBeCloseTo(30 / 99 - 0.30, 6); // ≈ +0,00303
    expect(r.empresa.folga_hurdle_min_receita).toBeCloseTo(48, 6);        // contexto: é ínfimo
  });
});
