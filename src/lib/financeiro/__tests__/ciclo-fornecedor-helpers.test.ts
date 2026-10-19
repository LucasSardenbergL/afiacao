// src/lib/financeiro/__tests__/ciclo-fornecedor-helpers.test.ts
import { describe, expect, it } from 'vitest';
import {
  normalizarTituloCp, normalizarResumoFornecedor, inicioRegimeDesconto, taxaDescontoObservada,
  custoDoPrazo, montarFilaCustoPrazo, pontualidadePorMes, confiancaFornecedor, rotuloPorDiaCompras,
  rotuloConferirBoleto, descontoNoDrill, ordenarFornecedores, filtrarFornecedores,
  type TituloCp, type ResumoFornecedor,
} from '@/lib/financeiro/ciclo-fornecedor-helpers';

const HOJE = '2026-10-18';

/** Título pago em dia, com 2% de desconto informado, vencendo em `venc`. */
function pago(lanc: number, venc: string, extra: Partial<TituloCp> = {}): TituloCp {
  return {
    company: 'oben', fornecedor: 900, lancamento: lanc, documento: `NF${lanc}`,
    emissao: venc, vencimento: venc, dataBaixa: venc, dataBaixaConfiavel: true,
    valor: 1000, valorAberto: null, situacao: 'paga', prazoConcedido: 10, prazoReal: 10, atrasoBaixa: 0,
    descontoObtido: 20, descontoInformado: 20, valorPagoPrincipal: 1000, encargoPago: 0, diasVencido: null,
    fonteValorAberto: null,
    ...extra,
  };
}

const resumoBase: ResumoFornecedor = normalizarResumoFornecedor({
  company: 'oben', omie_codigo_fornecedor: 900, nome_fornecedor: 'RENNER SAYERLACK S/A', fonte_nome: 'pedido_compra',
  compras_12m: '100000', n_titulos_12m: 20, n_documentos_pagos: 20, valor_pago: '100000',
  prazo_concedido_pond: '10', prazo_real_pond: '10', atraso_pond_sinal: '0', atraso_pond_pos: '0', n_prazo_negativo: 0,
  valor_pago_em_dia: '90000', valor_pago_atrasado: '10000', valor_pago_data_incerta: '0', valor_pago_conf_decisao: '95000',
  desconto_obtido_12m: '1800', encargo_pago_12m: '0', n_titulos_com_desconto: 18,
  valor_vencido_aberto: '0', n_vencidas: 0, dias_vencido_max: null, valor_a_vencer: '5000', n_status_ambiguo: 0,
});

describe('normalização', () => {
  it('NULL do banco continua null, nunca 0', () => {
    const t = normalizarTituloCp({
      company: 'oben', omie_codigo_fornecedor: 900, omie_codigo_lancamento: 1, numero_documento: null,
      data_emissao: '2026-09-01', data_vencimento: '2026-09-11', data_baixa: null, data_baixa_confiavel: false,
      valor_documento: '500.00', valor_aberto: null, situacao: 'paga', prazo_concedido_dias: 10,
      prazo_real_dias: null, dias_atraso_baixa: null, desconto_obtido: null, desconto_informado_omie: null,
      valor_pago_principal: null, encargo_pago: null, dias_vencido: null,
    });
    expect(t.valor).toBe(500);
    expect(t.descontoInformado).toBeNull();
    expect(t.atrasoBaixa).toBeNull();
    expect(t.documento).toBeNull();
  });
  it('resumo: desconto ausente fica null', () => {
    const r = normalizarResumoFornecedor({ company: 'oben', omie_codigo_fornecedor: 1, desconto_obtido_12m: null });
    expect(r.descontoObtido12m).toBeNull();
    expect(r.nome).toBeNull();
  });
});

describe('inicioRegimeDesconto', () => {
  it('desconto isolado não abre regime; abre no vencimento do 1º de 3 NFs em 90 d', () => {
    const ts = [
      pago(1, '2026-03-10'),
      pago(2, '2026-07-14'), pago(3, '2026-07-21'), pago(4, '2026-07-28'),
    ];
    expect(inicioRegimeDesconto(ts)).toBe('2026-07-14');
  });
  it('3 parcelas da MESMA NF contam como 1 documento', () => {
    const ts = [1, 2, 3].map((i) => pago(i, `2026-08-0${i}`, { documento: 'NF-UNICA' }));
    expect(inicioRegimeDesconto(ts)).toBeNull();
  });
  it('sem desconto nenhum → null', () => {
    expect(inicioRegimeDesconto([pago(1, '2026-08-01', { descontoInformado: 0 })])).toBeNull();
  });
});

describe('taxaDescontoObservada', () => {
  const seis = [1, 2, 3, 4, 5, 6].map((i) => pago(i, `2026-08-${String(i * 4).padStart(2, '0')}`));
  it('6 NFs a 2% em dia → 2%', () => {
    expect(taxaDescontoObservada(seis, '2026-08-04', HOJE)).toEqual({ taxa: 0.02, nDocumentos: 6, motivo: null });
  });
  it('1 título só → sem taxa (amostra)', () => {
    expect(taxaDescontoObservada([pago(1, '2026-08-04')], '2026-08-04', HOJE).taxa).toBeNull();
  });
  it('4 NFs → amostra', () => {
    expect(taxaDescontoObservada(seis.slice(0, 4), '2026-08-04', HOJE)).toMatchObject({ taxa: null, motivo: 'amostra' });
  });
  it('taxas espalhadas entre 1% e 3% → dispersao', () => {
    const esp = seis.map((t, i) => ({ ...t, descontoInformado: [10, 14, 18, 22, 26, 30][i] }));
    expect(taxaDescontoObservada(esp, '2026-08-04', HOJE)).toMatchObject({ taxa: null, motivo: 'dispersao' });
  });
  it('desconto com atraso frequente não é de pontualidade', () => {
    const atr = seis.map((t, i) => (i < 3 ? { ...t, atrasoBaixa: 4 } : t));
    expect(taxaDescontoObservada(atr, '2026-08-04', HOJE)).toMatchObject({ taxa: null, motivo: 'nao_pontualidade' });
  });
  it('sem regime → sem taxa', () => {
    expect(taxaDescontoObservada(seis, null, HOJE)).toMatchObject({ taxa: null, motivo: 'sem_regime' });
  });
  it('só a janela de 180 d pesa na taxa', () => {
    const velho = [1, 2, 3, 4, 5].map((i) => pago(100 + i, `2025-12-0${i}`, { descontoInformado: 10 }));
    const r = taxaDescontoObservada([...velho, ...seis], '2025-12-01', HOJE);
    expect(r).toEqual({ taxa: 0.02, nDocumentos: 6, motivo: null });
  });
});

describe('custoDoPrazo', () => {
  const regime = [1, 2, 3, 4, 5, 6].map((i) => pago(i, `2026-08-${String(i * 4).padStart(2, '0')}`));
  it('perdido por atraso só no regime, sem cobrar o desconto já obtido, e "em dia sem desconto" à parte', () => {
    const ts = [
      ...regime,
      pago(20, '2026-05-10', { atrasoBaixa: 5, descontoInformado: 0, valor: 50000, valorPagoPrincipal: 50000 }), // antes do regime
      pago(21, '2026-09-10', { atrasoBaixa: 2, descontoInformado: 0, valor: 10000, valorPagoPrincipal: 10000 }), // perde 200
      pago(22, '2026-09-12', { atrasoBaixa: 1, descontoInformado: 200, valor: 10000, valorPagoPrincipal: 10000 }), // já obteve
      pago(23, '2026-09-14', { atrasoBaixa: 0, descontoInformado: 0, valor: 5000, valorPagoPrincipal: 5000 }), // conferir boleto: 100
      pago(24, '2026-09-16', { atrasoBaixa: null, dataBaixaConfiavel: false, descontoInformado: 0, valor: 7000 }), // data incerta
      pago(25, '2026-09-18', { atrasoBaixa: 0, descontoInformado: null, valor: 9000 }), // resumo não lido
    ];
    const c = custoDoPrazo(ts, resumoBase, HOJE);
    expect(c.taxa).toBe(0.02);
    expect(c.regimeInicio).toBe('2026-08-04');
    expect(c.perdidoAtraso).toBeCloseTo(200, 6);
    expect(c.perdidoEmDiaSemDesconto).toBeCloseTo(100, 6);
    expect(c.descontoObtido).toBe(1800);
    expect(c.encargoPago).toBe(0);
  });
  it('sem taxa → perdidos null, não 0', () => {
    const c = custoDoPrazo([pago(1, '2026-09-01', { descontoInformado: 0, atrasoBaixa: 3 })], resumoBase, HOJE);
    expect(c.taxa).toBeNull();
    expect(c.perdidoAtraso).toBeNull();
    expect(c.perdidoEmDiaSemDesconto).toBeNull();
  });
  it('prazo concedido negativo não quebra nada', () => {
    const c = custoDoPrazo([...regime, pago(30, '2026-09-20', { prazoConcedido: -5, prazoReal: -5 })], resumoBase, HOJE);
    expect(c.perdidoAtraso).toBe(0);
  });
});

describe('montarFilaCustoPrazo', () => {
  const r = (forn: number, vencido: number): ResumoFornecedor => ({ ...resumoBase, fornecedor: forn, valorVencidoAberto: vencido });
  const custo = (perdido: number | null, encargo: number | null, emDia: number | null = null) => ({
    taxa: perdido === null ? null : 0.02, regimeInicio: null, perdidoAtraso: perdido,
    perdidoEmDiaSemDesconto: emDia, perdidoEmDiaDescontoAbaixo: null, encargoPago: encargo, descontoObtido: null,
  });
  it('ordena por R$ apurado+cenário, desempata pelo vencido, separa sem evidência e conferir boleto', () => {
    const f = montarFilaCustoPrazo([
      { resumo: r(1, 0), custo: custo(200, 0) },
      { resumo: r(2, 900), custo: custo(null, 50) },
      { resumo: r(3, 100), custo: custo(null, 50) },
      { resumo: r(4, 0), custo: custo(null, null) },
      { resumo: r(5, 0), custo: custo(0, 0, 100) },
    ]);
    expect(f.fila.map((i) => i.resumo.fornecedor)).toEqual([1, 2, 3]);
    expect(f.fila[0].totalRs).toBe(200);
    expect(f.semEvidencia.map((x) => x.fornecedor)).toEqual([4]);
    expect(f.conferirBoleto.map((x) => [x.resumo.fornecedor, x.valor])).toEqual([[5, 100]]);
  });
});

describe('pontualidadePorMes', () => {
  it('mês corrente é parcial; % em dia só entre datáveis; cobertura explícita', () => {
    const ts: TituloCp[] = [
      pago(1, '2026-09-05', { valor: 600 }),
      pago(2, '2026-09-06', { valor: 300, atrasoBaixa: 2 }),
      pago(3, '2026-09-07', { valor: 100, dataBaixaConfiavel: false, atrasoBaixa: null }),
      pago(4, '2026-10-03', { valor: 50 }),
      { ...pago(5, '2026-10-05'), situacao: 'vencida_aberta', valor: 80, valorAberto: 80, dataBaixa: null, atrasoBaixa: null, dataBaixaConfiavel: false },
      { ...pago(6, '2026-10-25'), situacao: 'a_vencer', valorAberto: 70 }, // não venceu: fora
    ];
    const m = pontualidadePorMes(ts, HOJE);
    expect(m.map((x) => x.mes)).toEqual(['2026-09-01', '2026-10-01']);
    const set = m[0];
    expect(set.valorVencido).toBe(1000);
    expect(set.pctEmDia).toBeCloseTo(600 / 900, 6);
    expect(set.pctAtrasado).toBeCloseTo(300 / 900, 6);
    expect(set.coberturaData).toBeCloseTo(900 / 1000, 6);
    expect(set.mesParcial).toBe(false);
    expect(m[1]).toMatchObject({ valorVencido: 130, valorAberto: 80, mesParcial: true });
  });
  it('mês sem nenhum datável → % null, não 0', () => {
    const m = pontualidadePorMes([pago(1, '2026-09-05', { dataBaixaConfiavel: false, atrasoBaixa: null })], HOJE);
    expect(m[0].pctEmDia).toBeNull();
  });
});

describe('confiancaFornecedor e R$/dia', () => {
  it('baixa com < 6 NFs ou cobertura de decisão < 80%', () => {
    expect(confiancaFornecedor(resumoBase)).toBe('media');
    expect(confiancaFornecedor({ ...resumoBase, nDocumentosPagos: 5 })).toBe('baixa');
    expect(confiancaFornecedor({ ...resumoBase, valorPagoConfDecisao: 70000 })).toBe('baixa');
    expect(confiancaFornecedor({ ...resumoBase, valorPago: null })).toBe('baixa');
  });
  it('R$/dia: null sem compras; com compras, rótulo com o sinal explícito', () => {
    expect(rotuloPorDiaCompras(null)).toBeNull();
    expect(rotuloPorDiaCompras(0)).toBeNull();
    expect(rotuloPorDiaCompras(365000)).toEqual({ porDia: 1000 });
  });
});

describe('revisão Codex', () => {
  it('#1 parcela atrasada SEM desconto da mesma NF tira a NF de "em dia"', () => {
    const ts = [1, 2, 3, 4, 5].flatMap((i) => {
      const venc = `2026-08-${String(i * 4).padStart(2, '0')}`;
      return [
        pago(i * 10, venc, { documento: `NF${i}` }),
        pago(i * 10 + 1, venc, { documento: `NF${i}`, descontoInformado: 0, atrasoBaixa: 6 }),
      ];
    });
    expect(taxaDescontoObservada(ts, '2026-08-04', HOJE)).toMatchObject({ taxa: null, motivo: 'nao_pontualidade' });
  });
  it('#3 título que vence HOJE não entra como vencido (o SQL o chama de a_vencer)', () => {
    const t = { ...pago(1, HOJE), situacao: 'a_vencer' as const, valorAberto: 1000, dataBaixa: null, atrasoBaixa: null, dataBaixaConfiavel: false };
    expect(pontualidadePorMes([t], HOJE)).toEqual([]);
  });
  it('#8 P20/P80 exatamente a 0,5 p.p. da mediana passa (sem erro de ponto flutuante)', () => {
    const ts = [15, 15, 20, 25, 25].map((d, i) => pago(i + 1, `2026-08-${String((i + 1) * 4).padStart(2, '0')}`, { descontoInformado: d }));
    expect(taxaDescontoObservada(ts, '2026-08-04', HOJE)).toMatchObject({ taxa: 0.02, motivo: null });
  });
});

describe('revisão final — vencimento em fim de semana', () => {
  // 2026-08-08 e 2026-08-15 são sábados; pagos na segunda (atraso bruto 2 d) com o desconto concedido.
  const docs = ['2026-08-04', '2026-08-08', '2026-08-12', '2026-08-15', '2026-08-20', '2026-08-24'].map((v, i) =>
    pago(i + 1, v, ['2026-08-08', '2026-08-15'].includes(v) ? { atrasoBaixa: 2 } : {}));
  it('sábado pago na segunda conta como em dia na prova da taxa', () => {
    expect(taxaDescontoObservada(docs, '2026-08-04', HOJE)).toMatchObject({ taxa: 0.02, motivo: null });
  });
  it('domingo pago na terça continua atrasado (1 dia útil depois)', () => {
    expect(pontualidadePorMes([pago(1, '2026-08-09', { atrasoBaixa: 2 })], HOJE)[0].pctAtrasado).toBe(1);
  });
  it('sábado pago na segunda não é atraso na pontualidade nem desconto perdido por atraso', () => {
    expect(pontualidadePorMes([pago(1, '2026-08-08', { atrasoBaixa: 2 })], HOJE)[0].pctEmDia).toBe(1);
    const c = custoDoPrazo([...docs, pago(50, '2026-09-05', { atrasoBaixa: 2, descontoInformado: 0 })], resumoBase, HOJE);
    expect(c.perdidoAtraso).toBe(0);
    expect(c.perdidoEmDiaSemDesconto).toBeCloseTo(20, 6);
  });
});

describe('pré-voo prod — resíduo de ponto flutuante', () => {
  it('desconto que bate com a taxa até o centavo não vira R$ perdido (Sayerlack: 0,0015)', () => {
    // taxa observada levemente acima de 2% (19,99/999,5 etc.) e título atrasado com o desconto cheio arredondado
    const regime = [1, 2, 3, 4, 5, 6].map((i) => pago(i, `2026-08-${String(i * 4).padStart(2, '0')}`, { descontoInformado: 20.0001 }));
    const c = custoDoPrazo([...regime, pago(40, '2026-09-10', { atrasoBaixa: 3, descontoInformado: 20 })], resumoBase, HOJE);
    expect(c.perdidoAtraso).toBe(0);
  });
});

describe('follow-up da revisão final (minors)', () => {
  const regime = [1, 2, 3, 4, 5, 6].map((i) => pago(i, `2026-08-${String(i * 4).padStart(2, '0')}`));
  it('pago em dia com desconto ABAIXO do observado não é "sem desconto": as duas parcelas saem separadas', () => {
    const c = custoDoPrazo([...regime,
      pago(40, '2026-09-10', { descontoInformado: 0 }),   // em dia, sem desconto: perde 20
      pago(41, '2026-09-12', { descontoInformado: 5 }),   // em dia, desconto de 0,5%: perde 15
    ], resumoBase, HOJE);
    expect(c.perdidoEmDiaSemDesconto).toBeCloseTo(20, 6);
    expect(c.perdidoEmDiaDescontoAbaixo).toBeCloseTo(15, 6);
    const { conferirBoleto } = montarFilaCustoPrazo([{ resumo: resumoBase, custo: c }]);
    expect(conferirBoleto).toHaveLength(1);
    expect(conferirBoleto[0]).toMatchObject({ semDesconto: 20, descontoAbaixo: 15 });
    expect(conferirBoleto[0].valor).toBeCloseTo(35, 6);
  });
  it('sem taxa observada, as duas parcelas do em dia são null (nunca 0)', () => {
    const c = custoDoPrazo([pago(1, '2026-09-10')], resumoBase, HOJE);
    expect(c.perdidoEmDiaSemDesconto).toBeNull();
    expect(c.perdidoEmDiaDescontoAbaixo).toBeNull();
  });
  it('rótulo do "conferir boleto" diz qual dos dois casos', () => {
    expect(rotuloConferirBoleto({ semDesconto: 20, descontoAbaixo: 0 })).toBe('pago em dia sem desconto');
    expect(rotuloConferirBoleto({ semDesconto: 0, descontoAbaixo: 15 })).toBe('pago em dia com desconto abaixo do observado');
    expect(rotuloConferirBoleto({ semDesconto: 20, descontoAbaixo: 15 }))
      .toBe('pago em dia sem desconto (R$ 20) ou com desconto abaixo do observado (R$ 15)');
  });
  it('1º mês da tendência cortado pela janela de 12 m sai marcado como parcial', () => {
    // janela começa em 2025-10-18: out/2025 só tem do dia 18 em diante; set/2025 só tem abertos (fora da janela de pagas).
    const ts: TituloCp[] = [
      { ...pago(1, '2025-09-20'), situacao: 'vencida_aberta', valorAberto: 100, dataBaixa: null, atrasoBaixa: null, dataBaixaConfiavel: false },
      pago(2, '2025-10-20'),
      pago(3, '2025-11-05'),
    ];
    const m = pontualidadePorMes(ts, HOJE);
    expect(m.map((x) => [x.mes, x.mesParcial])).toEqual([
      ['2025-09-01', true], ['2025-10-01', true], ['2025-11-01', false],
    ]);
  });
  it('janela que começa no dia 1 não marca o 1º mês como parcial', () => {
    const m = pontualidadePorMes([pago(1, '2025-11-03')], '2026-11-01');
    expect(m[0].mesParcial).toBe(false);
  });
  it('drill usa o desconto OBTIDO (o mesmo da tabela); informado sem confirmação aparece à parte', () => {
    expect(descontoNoDrill(pago(1, '2026-09-01'))).toEqual({ obtido: 20, informadoNaoConfirmado: null });
    expect(descontoNoDrill(pago(2, '2026-09-01', { descontoObtido: null, descontoInformado: 345.23 })))
      .toEqual({ obtido: null, informadoNaoConfirmado: 345.23 });
    expect(descontoNoDrill(pago(3, '2026-09-01', { descontoObtido: null, descontoInformado: null })))
      .toEqual({ obtido: null, informadoNaoConfirmado: null });
  });
  it('normaliza fonte_valor_aberto (selo "valor do título" no drill)', () => {
    const base = { company: 'oben', omie_codigo_fornecedor: 1, omie_codigo_lancamento: 1, data_emissao: HOJE, data_vencimento: HOJE,
      valor_documento: '10', situacao: 'a_vencer', prazo_concedido_dias: 0 };
    expect(normalizarTituloCp({ ...base, fonte_valor_aberto: 'valor_titulo' }).fonteValorAberto).toBe('valor_titulo');
    expect(normalizarTituloCp({ ...base, fonte_valor_aberto: 'omie_resumo' }).fonteValorAberto).toBe('omie_resumo');
    expect(normalizarTituloCp({ ...base, fonte_valor_aberto: null }).fonteValorAberto).toBeNull();
    expect(normalizarTituloCp({ ...base, fonte_valor_aberto: 'xpto' }).fonteValorAberto).toBeNull();
  });
  it('ordenação da tabela: campo escolhido desc, null por último; nome asc; desempate estável por compras', () => {
    const a = { ...resumoBase, fornecedor: 1, nome: 'BETA', compras12m: 100, atrasoPondPos: null, valorVencidoAberto: 50 };
    const b = { ...resumoBase, fornecedor: 2, nome: 'ALFA', compras12m: 300, atrasoPondPos: 2, valorVencidoAberto: 0 };
    const c = { ...resumoBase, fornecedor: 3, nome: null, compras12m: null, atrasoPondPos: 5, valorVencidoAberto: 50 };
    const ids = (xs: ResumoFornecedor[]) => xs.map((x) => x.fornecedor);
    expect(ids(ordenarFornecedores([a, b, c], 'compras'))).toEqual([2, 1, 3]);
    expect(ids(ordenarFornecedores([a, b, c], 'atraso'))).toEqual([3, 2, 1]);
    expect(ids(ordenarFornecedores([a, b, c], 'vencido'))).toEqual([1, 3, 2]);
    expect(ids(ordenarFornecedores([a, b, c], 'nome'))).toEqual([2, 1, 3]);
    expect(ids(ordenarFornecedores([a, b, c], 'desconhecido'))).toEqual([2, 1, 3]);
  });
  it('filtro por nome ou código, sem caixa nem acento', () => {
    const a = { ...resumoBase, fornecedor: 900, nome: 'RENNER SAYERLACK S/A' };
    const b = { ...resumoBase, fornecedor: 8689691709, nome: null };
    const c = { ...resumoBase, fornecedor: 5, nome: 'Fábrica São João' };
    const ids = (xs: ResumoFornecedor[]) => xs.map((x) => x.fornecedor);
    expect(ids(filtrarFornecedores([a, b, c], ''))).toEqual([900, 8689691709, 5]);
    expect(ids(filtrarFornecedores([a, b, c], 'sayer'))).toEqual([900]);
    expect(ids(filtrarFornecedores([a, b, c], '86896'))).toEqual([8689691709]);
    expect(ids(filtrarFornecedores([a, b, c], 'fabrica sao'))).toEqual([5]);
  });
});
