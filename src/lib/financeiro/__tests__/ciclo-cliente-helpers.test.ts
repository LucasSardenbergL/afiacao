// src/lib/financeiro/__tests__/ciclo-cliente-helpers.test.ts
import { describe, expect, it } from 'vitest';
import {
  num, perfilPorP80, perfilCliente, confiancaCliente, degrauAbaixo, sugerirAlavanca,
  descontoMaximo, parseCustoMensal, CUSTO_MENSAL_MAX, normalizarResumo, type ResumoCliente,
} from '@/lib/financeiro/ciclo-cliente-helpers';

const HOJE = '2026-10-14';
const base = (o: Partial<ResumoCliente> = {}): ResumoCliente => ({
  company: 'oben', omieCodigoCliente: 1, nomeCliente: 'CLI',
  nParcelas: 8, nDocumentos: 8, valorPago: 36500, valorPagoSemBaixa: null,
  prazoConcedidoPond: 30, prazoRealPond: 30, atrasoPond: 0,
  atrasoP50: 0, atrasoP80: 0, atrasoP80Valor: 0, atrasoMaxObservado: 0,
  excessoCarenciaPond: 0, pctValorAtrasado: 0, ultimaBaixa: '2026-10-01',
  nVencidas: null, saldoVencido: null, saldoVencido90: null, diasVencidoMax: null,
  volumeEmitido12m: 36500, primeiraEmissao: '2025-10-20', nStatusAmbiguo: null, ...o,
});

describe('num', () => {
  it('aceita number e string numérica', () => { expect(num(2)).toBe(2); expect(num('2.5')).toBe(2.5); });
  it('ausente/inválido vira null, nunca 0', () => {
    for (const x of [null, undefined, '', 'abc', 'NaN', 'Infinity', '-Infinity', NaN, Infinity, -Infinity]) expect(num(x)).toBeNull();
  });
});

describe('perfilPorP80 — fronteiras', () => {
  it.each([
    [-3, 'folga'], [-2.99, 'pontual'], [0, 'pontual'], [0.01, 'atraso_leve'],
    [7, 'atraso_leve'], [7.01, 'atraso_cronico'], [null, 'sem_dado'],
  ] as const)('p80=%s → %s', (p80, esperado) => { expect(perfilPorP80(p80)).toBe(esperado); });
});

describe('perfilCliente', () => {
  it('leituras divergentes → misto', () => {
    expect(perfilCliente(base({ atrasoP80: 0, atrasoP80Valor: 10 })).perfil).toBe('misto');
  });
  it('leituras iguais → o perfil', () => {
    expect(perfilCliente(base({ atrasoP80: 10, atrasoP80Valor: 12 })).perfil).toBe('atraso_cronico');
  });
});

describe('confiancaCliente', () => {
  it('6 documentos e baixa há 90d → media', () => {
    expect(confiancaCliente(base({ nDocumentos: 6, ultimaBaixa: '2026-07-16' }), HOJE)).toBe('media');
  });
  it('5 documentos → baixa', () => { expect(confiancaCliente(base({ nDocumentos: 5 }), HOJE)).toBe('baixa'); });
  it('baixa há 91d → baixa', () => {
    expect(confiancaCliente(base({ ultimaBaixa: '2026-07-15' }), HOJE)).toBe('baixa');
  });
  it('sem nenhuma paga → baixa', () => {
    expect(confiancaCliente(base({ nDocumentos: null, ultimaBaixa: null }), HOJE)).toBe('baixa');
  });
});

describe('degrauAbaixo', () => {
  it.each([[30, 28], [31, 30], [28, 21], [8, 7], [7, null], [3, null], [120, 90], [7.4, null], [7.6, 7]] as const)(
    '%s → %s', (de, para) => { expect(degrauAbaixo(de)).toBe(para); });
});

describe('sugerirAlavanca', () => {
  it('vencida aberta vence tudo, e não soma ao recorrente', () => {
    const s = sugerirAlavanca(base({ saldoVencido: 1000, saldoVencido90: 600, atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5 }), HOJE);
    expect(s.alavanca).toBe('recuperar_vencido');
    expect(s.texto).toBe('R$ 1.000 vencidos (R$ 600 > 90d)');
    expect(s.cenario?.reais).toBe(1000);
    expect(s.cenario?.rotulo).toMatch(/estoque vencido/);
  });
  it('cliente só-vencido (sem pagas) → recuperar_vencido', () => {
    const s = sugerirAlavanca(base({ nParcelas: null, nDocumentos: null, valorPago: null, atrasoP80: null, atrasoP80Valor: null, ultimaBaixa: null, saldoVencido: 100 }), HOJE);
    expect(s.alavanca).toBe('recuperar_vencido');
    expect(s.texto).toBe('R$ 100 vencidos');
  });
  it('atraso crônico → cenário = excesso × volume/365', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5, volumeEmitido12m: 36500 }), HOJE);
    expect(s.alavanca).toBe('cobrar_atraso');
    expect(s.cenario?.reais).toBeCloseTo(500, 6);
    expect(s.descontoCandidato).toBe(false);
  });
  it('atraso leve → cobrar + candidato a desconto', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 4, atrasoP80Valor: 4, excessoCarenciaPond: 1 }), HOJE);
    expect(s.alavanca).toBe('cobrar_atraso');
    expect(s.descontoCandidato).toBe(true);
  });
  it('volume ausente → cenário null com motivo, nunca 0', () => {
    const s = sugerirAlavanca(base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5, volumeEmitido12m: null }), HOJE);
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('sem volume na janela');
  });
  it('pontual → degrau 30→28 com cenário 2 × volume/365', () => {
    const s = sugerirAlavanca(base(), HOJE);
    expect(s.alavanca).toBe('degrau_prazo');
    expect(s.degrau).toEqual({ de: 30, para: 28 });
    expect(s.cenario?.reais).toBeCloseTo(200, 6);
    expect(s.cenario?.rotulo).toMatch(/se continuar pagando no vencimento/);
  });
  it('folga → degrau sem R$', () => {
    const s = sugerirAlavanca(base({ atrasoP80: -5, atrasoP80Valor: -5 }), HOJE);
    expect(s.alavanca).toBe('degrau_prazo');
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('benefício depende de piloto');
  });
  it('baixa confiança → nenhuma (sem vencida)', () => {
    expect(sugerirAlavanca(base({ nDocumentos: 3 }), HOJE).alavanca).toBe('nenhuma');
  });
  it('misto → nenhuma', () => {
    expect(sugerirAlavanca(base({ atrasoP80: 0, atrasoP80Valor: 10 }), HOJE).alavanca).toBe('nenhuma');
  });
  it('parcelado (18 parcelas, 6 NFs) → média não é condição, sem degrau nem R$', () => {
    const s = sugerirAlavanca(base({ nParcelas: 18, nDocumentos: 6, prazoConcedidoPond: 60 }), HOJE);
    expect(s.alavanca).toBe('degrau_prazo');
    expect(s.degrau).toBeNull();
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('parcelado: média não é condição');
    expect(s.texto).toBe('Parcelado: prazo médio 60 d não é a condição — revisar o calendário de parcelas no drill');
    expect(s.texto).not.toMatch(/56/);
  });
  it('parcela única (parcelas = documentos) mantém degrau numérico', () => {
    const s = sugerirAlavanca(base({ nParcelas: 8, nDocumentos: 8 }), HOJE);
    expect(s.degrau).toEqual({ de: 30, para: 28 });
  });
  it('contagem de parcelas ausente → reais null com motivo', () => {
    const s = sugerirAlavanca(base({ nParcelas: null }), HOJE);
    expect(s.cenario?.reais).toBeNull();
    expect(s.cenario?.motivo).toBe('sem contagem de parcelas/documentos');
  });
  it('R$ do degrau usa prazo cru: 30,4 → 2,4×dia (texto arredondado)', () => {
    const s = sugerirAlavanca(base({ prazoConcedidoPond: 30.4 }), HOJE);
    expect(s.cenario?.reais).toBeCloseTo(240, 6);
    expect(s.degrau).toEqual({ de: 30, para: 28 });
  });
  it('todo cenário tem rótulo "não é previsão", inclusive com reais null', () => {
    const casos = [
      base({ saldoVencido: 5 }),
      base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5, volumeEmitido12m: null }),
      base({ atrasoP80: 10, atrasoP80Valor: 10, excessoCarenciaPond: 5 }),
      base({ atrasoP80: -5, atrasoP80Valor: -5 }),
      base({ nParcelas: 18, nDocumentos: 6 }),
      base({ volumeEmitido12m: null }),
      base(),
    ];
    for (const c of casos) expect(sugerirAlavanca(c, HOJE).cenario?.rotulo).toMatch(/não é previsão/);
  });
  it('misto → texto explica a divergência', () => {
    expect(sugerirAlavanca(base({ atrasoP80: 0, atrasoP80Valor: 10 }), HOJE).texto)
      .toBe('Frequência e valor do atraso divergem — sem sugestão automática');
  });
  it('prazo 7 pontual → sem degrau (nunca 7→0)', () => {
    const s = sugerirAlavanca(base({ prazoConcedidoPond: 7 }), HOJE);
    expect(s.alavanca).toBe('nenhuma');
    expect(s.degrau).toBeNull();
  });
});

describe('descontoMaximo — d = 1 − (1+c)^(−N/30)', () => {
  it('c=2%, N=30 → 1,9608%', () => {
    const r = descontoMaximo(0.02, 30);
    expect(r.ok && r.dMax).toBeCloseTo(0.0196078, 6);
  });
  it('custo ausente → marca custo_ausente', () => {
    expect(descontoMaximo(null, 30)).toEqual({ ok: false, motivo: 'custo_ausente' });
  });
  it.each([0, -0.01, NaN, Infinity])('custo %s → custo_invalido (nunca 0%%)', (c) => {
    expect(descontoMaximo(c, 30)).toEqual({ ok: false, motivo: 'custo_invalido' });
  });
  it.each([0, -1, NaN])('N=%s → dias_invalidos', (n) => {
    expect(descontoMaximo(0.02, n)).toEqual({ ok: false, motivo: 'dias_invalidos' });
  });
});

describe('parseCustoMensal (input BR)', () => {
  it('"2,5" → 0.025 e "2.5" → 0.025', () => {
    expect(parseCustoMensal('2,5')).toEqual({ ok: true, c: 0.025 });
    expect(parseCustoMensal(' 2.5 ')).toEqual({ ok: true, c: 0.025 });
  });
  it('teto: 20 → ok no limite; acima (500, 20,01) → custo_invalido', () => {
    expect(CUSTO_MENSAL_MAX).toBe(0.2);
    expect(parseCustoMensal('20')).toEqual({ ok: true, c: 0.2 });
    expect(parseCustoMensal('500')).toEqual({ ok: false, motivo: 'custo_invalido' });
    expect(parseCustoMensal('20,01')).toEqual({ ok: false, motivo: 'custo_invalido' });
  });
  it('vazio → custo_ausente', () => { expect(parseCustoMensal('  ')).toEqual({ ok: false, motivo: 'custo_ausente' }); });
  it.each(['abc', '-1', '0', '1e999'])('"%s" → custo_invalido', (t) => {
    expect(parseCustoMensal(t)).toEqual({ ok: false, motivo: 'custo_invalido' });
  });
});

describe('normalizarResumo', () => {
  it('converte strings numéricas e preserva null', () => {
    const r = normalizarResumo({ company: 'oben', omie_codigo_cliente: 7, nome_cliente: null, n_documentos: '6', atraso_p80: null, volume_emitido_12m: '100.5' });
    expect(r.nDocumentos).toBe(6);
    expect(r.atrasoP80).toBeNull();
    expect(r.volumeEmitido12m).toBe(100.5);
    expect(r.nomeCliente).toBeNull();
  });
});
