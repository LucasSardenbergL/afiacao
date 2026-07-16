import { describe, it, expect } from 'vitest';
import {
  classificarRespostaOmie,
  erroBenigno,
  decidirStatusEfetivacao,
  selecionarPassosPendentes,
  podeReprocessar,
  resumirErros,
  extrairEstadoConsulta,
  validarIdentidade,
  decidirAcaoRecebimento,
  detectarConversao,
  cruzarItensParaEscrita,
  validarGatesEscrita,
  confirmarEfetivacao,
  decidirStatusComConfirmacao,
  decidirEfeitoReconcileLote,
  resumirReconcileLote,
  ehErroRedundante,
  extrairRecebidosDaListagem,
  selecionarCandidatasReconcile,
  type PassoFlags,
  type ItemApp,
  type EfeitoReconcile,
} from './efetivacao-helpers';

// Fixture: body REAL do ConsultarRecebimento (diagnóstico CALL 2 — NF 000234012 ACRE CAXIAS, modelo 55).
// chave de 44 dígitos sintética (o diagnóstico não a transcreveu, mas o cabec a retorna).
const CHAVE_CALL2 = '35260400000000000000550010002340121000000001';
const CONSULTA_CALL2 = {
  cabec: { cEtapa: '80', cModeloNFe: '55', nIdReceb: 12077966878, cChaveNfe: CHAVE_CALL2, nValorNFe: 3274.7 },
  cteCfopEntrada: null,
  departamentos: [{ cCodDepartamento: '8805360468', pDepartamento: 100, vDepartamento: 3274.7 }],
  infoAdicionais: { cCategCompra: '2.01.01', dRegistro: '04/05/2026' },
  infoCadastro: { cRecebido: 'S', cFaturado: 'S', cUsuarioInc: 'WEBSERVICE', cUsuarioRec: 'P000209032', dRec: '04/05/2026' },
  itensRecebimento: [
    {
      itensCabec: { nSequencia: 1, cCodigoProduto: 'PRD03040', cDescricaoProduto: 'SUPORTE HOOKIT', nIdProduto: 8694686103, nQtdeNFe: 229, cAssociarExistente: 'S', cAdicionarNovo: 'N', cIgnorarItem: 'N', cUnidadeNfe: 'UN', nPrecoUnit: 14.3, vTotalItem: 3274.7 },
      itensAjustes: { nQtdeRecebida: 229, cCFOPEntrada: '2.102', cUnidade: 'UN', cNaoGerarMovEstoque: 'N', codigo_local_estoque: 8686372976 },
    },
  ],
};

const itemAppOk = (over: Partial<ItemApp> = {}): ItemApp => ({
  sequencia: 1,
  produto_omie_id: 8694686103,
  quantidade_conferida: 229,
  quantidade_convertida: null,
  status_item: 'conferido',
  unidade_nfe: 'UN',
  unidade_estoque: 'UN',
  ...over,
});

describe('classificarRespostaOmie', () => {
  it('HTTP 200 sem faultstring → sucesso', () => {
    const r = classificarRespostaOmie({ httpOk: true, status: 200, body: { nIdReceb: 42 } });
    expect(r.sucesso).toBe(true);
    expect(r.erro).toBeNull();
  });

  it('HTTP 200 com faultstring → falha (sucesso HTTP ≠ sucesso Omie)', () => {
    const r = classificarRespostaOmie({
      httpOk: true,
      status: 200,
      body: { faultstring: 'O preenchimento da tag [nValUnit] é obrigatório', faultcode: 'SOAP-ENV:Client-101' },
    });
    expect(r.sucesso).toBe(false);
    expect(r.erro).toContain('nValUnit');
  });

  it('HTTP 500 → falha mesmo sem faultstring', () => {
    const r = classificarRespostaOmie({ httpOk: false, status: 500, body: { raw: 'erro interno' } });
    expect(r.sucesso).toBe(false);
    expect(r.erro).toContain('HTTP 500');
  });

  it('HTTP 500 com faultstring → usa a faultstring no erro', () => {
    const r = classificarRespostaOmie({ httpOk: false, status: 500, body: { faultstring: 'Consumo redundante' } });
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe('Consumo redundante');
  });

  it('codigo_status "0" → sucesso', () => {
    const r = classificarRespostaOmie({ httpOk: true, body: { codigo_status: '0', descricao_status: 'OK' } });
    expect(r.sucesso).toBe(true);
    expect(r.omieStatus).toBe('0');
  });

  it('codigo_status "101" → falha com descricao_status', () => {
    const r = classificarRespostaOmie({ httpOk: true, body: { codigo_status: '101', descricao_status: 'Produto não encontrado' } });
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe('Produto não encontrado');
    expect(r.omieStatus).toBe('101');
  });

  it('cCodStatus numérico ≠ 0 → falha', () => {
    const r = classificarRespostaOmie({ httpOk: true, body: { cCodStatus: 5, cDescStatus: 'Falhou' } });
    expect(r.sucesso).toBe(false);
    expect(r.erro).toBe('Falhou');
  });

  it('ausência de codigo_status NÃO é falha', () => {
    const r = classificarRespostaOmie({ httpOk: true, body: { nIdReceb: 1, cChaveNfe: 'x' } });
    expect(r.sucesso).toBe(true);
  });

  it('body null/array/string → robusto (sucesso só com httpOk e sem sinal de erro)', () => {
    expect(classificarRespostaOmie({ httpOk: true, body: null }).sucesso).toBe(true);
    expect(classificarRespostaOmie({ httpOk: true, body: [1, 2, 3] }).sucesso).toBe(true);
    expect(classificarRespostaOmie({ httpOk: true, body: 'texto solto' }).sucesso).toBe(true);
    expect(classificarRespostaOmie({ httpOk: false, status: 404, body: 'not found' }).sucesso).toBe(false);
  });

  it('faultstring só com espaços → tratada como ausente', () => {
    const r = classificarRespostaOmie({ httpOk: true, body: { faultstring: '   ' } });
    expect(r.sucesso).toBe(true);
  });
});

describe('erroBenigno', () => {
  it('"já está na etapa" em alterar_etapa → benigno', () => {
    expect(erroBenigno('Recebimento já está na etapa informada', 'alterar_etapa')).toBe(true);
  });
  it('"já concluído" em concluir_recebimento → benigno', () => {
    expect(erroBenigno('Recebimento já concluído anteriormente', 'concluir_recebimento')).toBe(true);
    expect(erroBenigno('Nota já foi efetivada', 'concluir_recebimento')).toBe(true);
  });
  it('faultstring desconhecida → NÃO benigno (falha real)', () => {
    expect(erroBenigno('Produto não encontrado', 'concluir_recebimento')).toBe(false);
    expect(erroBenigno('Erro de validação X', 'alterar_etapa')).toBe(false);
  });
  it('operação sem allowlist → nunca benigno', () => {
    expect(erroBenigno('já concluído', 'alterar_recebimento')).toBe(false);
  });
  it('faultstring vazia → não benigno', () => {
    expect(erroBenigno('', 'concluir_recebimento')).toBe(false);
    expect(erroBenigno(null, 'concluir_recebimento')).toBe(false);
  });
});

describe('decidirStatusEfetivacao', () => {
  // base = NF SEM CT-e aplicável (cteAplicavel:false), nada concretizado.
  const base: PassoFlags = { alterarOk: false, etapaOk: false, concluirOk: false, cteAplicavel: false, cteOk: false, ajustesTentados: 0, ajustesOk: 0 };

  it('todos os obrigatórios ok (sem CT-e) + sem ajustes → efetivado', () => {
    expect(decidirStatusEfetivacao({ ...base, alterarOk: true, etapaOk: true, concluirOk: true })).toBe('efetivado');
  });
  it('todos ok + CT-e aplicável concluído + ajustes 2/2 → efetivado', () => {
    expect(
      decidirStatusEfetivacao({ alterarOk: true, etapaOk: true, concluirOk: true, cteAplicavel: true, cteOk: true, ajustesTentados: 2, ajustesOk: 2 }),
    ).toBe('efetivado');
  });
  it('nada concretizado (sem CT-e) → falha_efetivacao', () => {
    expect(decidirStatusEfetivacao(base)).toBe('falha_efetivacao');
  });
  it('CT-e não-aplicável NÃO conta como efeito → ainda falha_efetivacao', () => {
    expect(decidirStatusEfetivacao({ ...base, cteAplicavel: false, cteOk: false })).toBe('falha_efetivacao');
  });
  it('alterar ok mas concluir pendente → parcial', () => {
    expect(decidirStatusEfetivacao({ ...base, alterarOk: true })).toBe('efetivacao_parcial');
  });
  it('alterar+etapa+concluir ok mas CT-e aplicável falhou → parcial', () => {
    expect(
      decidirStatusEfetivacao({ alterarOk: true, etapaOk: true, concluirOk: true, cteAplicavel: true, cteOk: false, ajustesTentados: 0, ajustesOk: 0 }),
    ).toBe('efetivacao_parcial');
  });
  it('alterar+etapa+concluir ok mas 1/2 ajustes → parcial', () => {
    expect(
      decidirStatusEfetivacao({ alterarOk: true, etapaOk: true, concluirOk: true, cteAplicavel: false, cteOk: false, ajustesTentados: 2, ajustesOk: 1 }),
    ).toBe('efetivacao_parcial');
  });
  it('só ajuste concretizado (passos NF pendentes) → parcial, não falha', () => {
    expect(
      decidirStatusEfetivacao({ alterarOk: false, etapaOk: false, concluirOk: false, cteAplicavel: false, cteOk: false, ajustesTentados: 1, ajustesOk: 1 }),
    ).toBe('efetivacao_parcial');
  });
});

describe('selecionarPassosPendentes', () => {
  it('lista só os passos sem ok (CT-e aplicável já ok não entra)', () => {
    expect(selecionarPassosPendentes({ alterarOk: true, etapaOk: false, concluirOk: false, cteAplicavel: true, cteOk: true })).toEqual([
      'alterar_etapa',
      'concluir_recebimento',
    ]);
  });
  it('tudo ok → vazio', () => {
    expect(selecionarPassosPendentes({ alterarOk: true, etapaOk: true, concluirOk: true, cteAplicavel: true, cteOk: true })).toEqual([]);
  });
  it('nada ok + CT-e aplicável → todos incluindo cte', () => {
    expect(selecionarPassosPendentes({ alterarOk: false, etapaOk: false, concluirOk: false, cteAplicavel: true, cteOk: false })).toEqual([
      'alterar_recebimento',
      'alterar_etapa',
      'concluir_recebimento',
      'cte',
    ]);
  });
  it('sem CT-e aplicável → cte não entra mesmo com cteOk false', () => {
    expect(selecionarPassosPendentes({ alterarOk: false, etapaOk: false, concluirOk: false, cteAplicavel: false, cteOk: false })).toEqual([
      'alterar_recebimento',
      'alterar_etapa',
      'concluir_recebimento',
    ]);
  });
});

describe('podeReprocessar', () => {
  it('falha/parcial → true; demais → false', () => {
    expect(podeReprocessar('falha_efetivacao')).toBe(true);
    expect(podeReprocessar('efetivacao_parcial')).toBe(true);
    expect(podeReprocessar('efetivado')).toBe(false);
    expect(podeReprocessar('conferido')).toBe(false);
    expect(podeReprocessar('pendente')).toBe(false);
  });
});

describe('resumirErros', () => {
  it('concatena operação: erro', () => {
    expect(resumirErros([{ operacao: 'alterar_recebimento', erro: 'X' }, { operacao: 'cte', erro: 'Y' }])).toBe(
      'alterar_recebimento: X | cte: Y',
    );
  });
  it('trunca acima do limite', () => {
    const out = resumirErros([{ operacao: 'op', erro: 'a'.repeat(1000) }], 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PR2 (A1 — coreografia de escrita): consultar-antes, reconciliar/escrever
// ════════════════════════════════════════════════════════════════════════════

describe('extrairEstadoConsulta', () => {
  it('CALL 2 real → estado + 1 item parseado', () => {
    const e = extrairEstadoConsulta(CONSULTA_CALL2);
    expect(e.cRecebido).toBe('S');
    expect(e.cEtapa).toBe('80');
    expect(e.nIdReceb).toBe(12077966878);
    expect(e.cChaveNfe).toBe(CHAVE_CALL2);
    expect(e.itensOmie).toHaveLength(1);
    expect(e.itensOmie[0]).toMatchObject({ nSequencia: 1, nIdProduto: 8694686103, nQtdeNFe: 229, nQtdeRecebida: 229, cUnidadeNfe: 'UN', cIgnorarItem: false });
    expect(e.itensOmie[0].nFatorConversao).toBeNull();
  });
  it('body null/array/string → defaults vazios', () => {
    for (const b of [null, undefined, [], 'x', 42]) {
      const e = extrairEstadoConsulta(b);
      expect(e).toEqual({ cRecebido: null, cEtapa: null, nIdReceb: null, cChaveNfe: null, itensOmie: [] });
    }
  });
  it('cIgnorarItem "S" → true', () => {
    const e = extrairEstadoConsulta({ itensRecebimento: [{ itensCabec: { nSequencia: 2, cIgnorarItem: 'S', nQtdeNFe: 5 } }] });
    expect(e.itensOmie[0].cIgnorarItem).toBe(true);
  });
  it('fator de conversão em nFatorConv (cabec) → consolidado', () => {
    const e = extrairEstadoConsulta({ itensRecebimento: [{ itensCabec: { nSequencia: 1, nFatorConv: 2, nQtdeNFe: 10 } }] });
    expect(e.itensOmie[0].nFatorConversao).toBe(2);
  });
  it('fator de conversão em subobjeto itensConversao → consolidado', () => {
    const e = extrairEstadoConsulta({ itensRecebimento: [{ itensCabec: { nSequencia: 1, nQtdeNFe: 10 }, itensConversao: { nFatorConversao: 3 } }] });
    expect(e.itensOmie[0].nFatorConversao).toBe(3);
  });
  it('itensRecebimento ausente/null → []', () => {
    expect(extrairEstadoConsulta({ cabec: { nIdReceb: 1 }, itensRecebimento: null }).itensOmie).toEqual([]);
  });
});

describe('validarIdentidade', () => {
  const esperado = { nIdReceb: 12077966878, chaveAcesso: CHAVE_CALL2 };
  it('nIdReceb + chave batem → ok', () => {
    expect(validarIdentidade(extrairEstadoConsulta(CONSULTA_CALL2), esperado).ok).toBe(true);
  });
  it('nIdReceb divergente → falha', () => {
    const e = { ...extrairEstadoConsulta(CONSULTA_CALL2), nIdReceb: 999 };
    expect(validarIdentidade(e, esperado).ok).toBe(false);
  });
  it('chave divergente → falha', () => {
    const e = { ...extrairEstadoConsulta(CONSULTA_CALL2), cChaveNfe: 'OUTRA' };
    expect(validarIdentidade(e, esperado).ok).toBe(false);
  });
  it('nIdReceb ausente na consulta → falha', () => {
    const e = { ...extrairEstadoConsulta(CONSULTA_CALL2), nIdReceb: null };
    expect(validarIdentidade(e, esperado).ok).toBe(false);
  });
  it('chave ausente mas nIdReceb ok (consultado com a chave como filtro) → ok', () => {
    const e = { ...extrairEstadoConsulta(CONSULTA_CALL2), cChaveNfe: null };
    expect(validarIdentidade(e, esperado).ok).toBe(true);
  });
});

describe('decidirAcaoRecebimento', () => {
  const base = { nIdReceb: 1, cChaveNfe: 'x', itensOmie: [] };
  it('cRecebido S → reconciliar', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: 'S', cEtapa: '80' })).toBe('reconciliar');
  });
  it('cRecebido minúsculo "s" → reconciliar', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: 's', cEtapa: '80' })).toBe('reconciliar');
  });
  it('cEtapa 80 mas cRecebido N → inconsistente (nunca reconcilia por etapa só)', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: 'N', cEtapa: '80' })).toBe('inconsistente');
  });
  it('cEtapa " 80 " + cRecebido " n " (com espaços) → inconsistente', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: ' n ', cEtapa: ' 80 ' })).toBe('inconsistente');
  });
  it('cEtapa 80 + cRecebido null → inconsistente', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: null, cEtapa: '80' })).toBe('inconsistente');
  });
  it('cEtapa 40 → escrever', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: 'N', cEtapa: '40' })).toBe('escrever');
  });
  it('ambos null → escrever', () => {
    expect(decidirAcaoRecebimento({ ...base, cRecebido: null, cEtapa: null })).toBe('escrever');
  });
});

describe('detectarConversao', () => {
  it('fator ≠ 1 no Omie → conversão', () => {
    const r = detectarConversao([extrairEstadoConsulta({ itensRecebimento: [{ itensCabec: { nSequencia: 1, nFatorConv: 2, nQtdeNFe: 10 } }] }).itensOmie[0]], [itemAppOk()]);
    expect(r.temConversao).toBe(true);
    expect(r.motivo).toBeTruthy();
  });
  it('quantidade_convertida preenchida no app → conversão', () => {
    expect(detectarConversao([], [itemAppOk({ quantidade_convertida: 10 })]).temConversao).toBe(true);
  });
  it('unidade NF ≠ unidade estoque → conversão', () => {
    expect(detectarConversao([], [itemAppOk({ unidade_nfe: 'CX', unidade_estoque: 'UN' })]).temConversao).toBe(true);
  });
  it('tudo limpo (fator 1/null, sem convertida, unidades iguais) → sem conversão', () => {
    const e = extrairEstadoConsulta(CONSULTA_CALL2);
    expect(detectarConversao(e.itensOmie, [itemAppOk()]).temConversao).toBe(false);
  });
});

describe('cruzarItensParaEscrita', () => {
  const omie = extrairEstadoConsulta(CONSULTA_CALL2).itensOmie;
  it('app conferido × Omie casado → itensEditar + pretendidos', () => {
    const r = cruzarItensParaEscrita(omie, [itemAppOk()]);
    expect(r.ok).toBe(true);
    expect(r.itensEditar).toEqual([{ itensIde: { nSequencia: 1, cAcao: 'EDITAR' }, itensAjustes: { nQtdeRecebida: 229 } }]);
    expect(r.pretendidos).toEqual([{ nSequencia: 1, nIdProduto: 8694686103, nQtdeRecebida: 229 }]);
  });
  it('produto do app ≠ nIdProduto do Omie (mesma seq) → falha (casar só por sequência é furo)', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ produto_omie_id: 111 })]).ok).toBe(false);
  });
  it('item app não-conferido → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ status_item: 'pendente' })]).ok).toBe(false);
  });
  it('quantidade negativa → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ quantidade_conferida: -1 })]).ok).toBe(false);
  });
  it('quantidade NaN → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ quantidade_conferida: NaN })]).ok).toBe(false);
  });
  it('produto_omie_id null no app → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ produto_omie_id: null })]).ok).toBe(false);
  });
  it('item Omie cIgnorarItem → omitido (contagem casa com app sem ele)', () => {
    const comIgnorado = extrairEstadoConsulta({
      itensRecebimento: [
        ...CONSULTA_CALL2.itensRecebimento,
        { itensCabec: { nSequencia: 2, nIdProduto: 999, cIgnorarItem: 'S', nQtdeNFe: 3 }, itensAjustes: { nQtdeRecebida: 3 } },
      ],
    }).itensOmie;
    const r = cruzarItensParaEscrita(comIgnorado, [itemAppOk()]);
    expect(r.ok).toBe(true);
    expect(r.itensEditar).toHaveLength(1);
  });
  it('contagem app ≠ Omie (não-ignorados) → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk(), itemAppOk({ sequencia: 2 })]).ok).toBe(false);
  });
  it('sequência app sem par no Omie → falha', () => {
    expect(cruzarItensParaEscrita(omie, [itemAppOk({ sequencia: 5 })]).ok).toBe(false);
  });
  it('input fora de ordem → itensEditar e pretendidos ordenados por sequência', () => {
    const omie2 = extrairEstadoConsulta({
      itensRecebimento: [
        { itensCabec: { nSequencia: 1, nIdProduto: 11, nQtdeNFe: 5, cIgnorarItem: 'N' }, itensAjustes: { nQtdeRecebida: 5 } },
        { itensCabec: { nSequencia: 2, nIdProduto: 22, nQtdeNFe: 7, cIgnorarItem: 'N' }, itensAjustes: { nQtdeRecebida: 7 } },
      ],
    }).itensOmie;
    const r = cruzarItensParaEscrita(omie2, [
      itemAppOk({ sequencia: 2, produto_omie_id: 22, quantidade_conferida: 7 }),
      itemAppOk({ sequencia: 1, produto_omie_id: 11, quantidade_conferida: 5 }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.itensEditar.map((i) => i.itensIde.nSequencia)).toEqual([1, 2]);
    expect(r.pretendidos.map((p) => p.nSequencia)).toEqual([1, 2]);
  });
});

describe('validarGatesEscrita', () => {
  const base = { statusApp: 'conferido', temLoteEscaneado: false, temConversao: false, motivoConversao: null };
  it('tudo limpo → ok', () => {
    expect(validarGatesEscrita(base).ok).toBe(true);
  });
  it('status ≠ conferido → falha', () => {
    expect(validarGatesEscrita({ ...base, statusApp: 'pendente' }).ok).toBe(false);
  });
  it('lote escaneado → falha', () => {
    const r = validarGatesEscrita({ ...base, temLoteEscaneado: true });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/lote/i);
  });
  it('conversão → falha com o motivo', () => {
    const r = validarGatesEscrita({ ...base, temConversao: true, motivoConversao: 'fator ≠ 1' });
    expect(r.ok).toBe(false);
    expect(r.erro).toBe('fator ≠ 1');
  });
});

describe('confirmarEfetivacao', () => {
  const pretendidos = [{ nSequencia: 1, nIdProduto: 8694686103, nQtdeRecebida: 229 }];
  const esperado = { chaveAcesso: CHAVE_CALL2, pretendidos };
  it('cRecebido S + chave + produto + qtd batem → confirmado', () => {
    const r = confirmarEfetivacao(extrairEstadoConsulta(CONSULTA_CALL2), esperado);
    expect(r.confirmado).toBe(true);
    expect(r.divergencias).toEqual([]);
  });
  it('qtd recebida no Omie ≠ pretendida → não confirmado', () => {
    const body = { ...CONSULTA_CALL2, itensRecebimento: [{ itensCabec: { nSequencia: 1, nIdProduto: 8694686103, nQtdeNFe: 229, cIgnorarItem: 'N' }, itensAjustes: { nQtdeRecebida: 200 } }] };
    const r = confirmarEfetivacao(extrairEstadoConsulta(body), esperado);
    expect(r.confirmado).toBe(false);
    expect(r.divergencias.join(' ')).toMatch(/qtd|quantidade/i);
  });
  it('produto no Omie ≠ pretendido (qtd igual) → não confirmado', () => {
    const body = { ...CONSULTA_CALL2, itensRecebimento: [{ itensCabec: { nSequencia: 1, nIdProduto: 777, nQtdeNFe: 229, cIgnorarItem: 'N' }, itensAjustes: { nQtdeRecebida: 229 } }] };
    expect(confirmarEfetivacao(extrairEstadoConsulta(body), esperado).confirmado).toBe(false);
  });
  it('sequência esperada ausente na reconsulta → não confirmado', () => {
    const body = { ...CONSULTA_CALL2, itensRecebimento: [] };
    const r = confirmarEfetivacao(extrairEstadoConsulta(body), esperado);
    expect(r.confirmado).toBe(false);
    expect(r.divergencias.join(' ')).toMatch(/ausente/i);
  });
  it('cRecebido N → não confirmado', () => {
    const body = { ...CONSULTA_CALL2, infoCadastro: { cRecebido: 'N' } };
    expect(confirmarEfetivacao(extrairEstadoConsulta(body), esperado).confirmado).toBe(false);
  });
});

describe('decidirStatusComConfirmacao', () => {
  const todosOk: PassoFlags = { alterarOk: true, etapaOk: true, concluirOk: true, cteAplicavel: false, cteOk: false, ajustesTentados: 0, ajustesOk: 0 };
  it('todos os passos ok + confirmado → efetivado', () => {
    expect(decidirStatusComConfirmacao(todosOk, true)).toBe('efetivado');
  });
  it('todos os passos ok mas NÃO confirmado → parcial (reconsulta é o juiz)', () => {
    expect(decidirStatusComConfirmacao(todosOk, false)).toBe('efetivacao_parcial');
  });
  it('concluir falhou + confirmado → parcial (status base já não é efetivado)', () => {
    expect(decidirStatusComConfirmacao({ ...todosOk, concluirOk: false }, true)).toBe('efetivacao_parcial');
  });
});

describe('decidirEfeitoReconcileLote (varredura automática — reconcile-only)', () => {
  const clsOk = { sucesso: true, erro: null, omieStatus: null };
  const esperadoCall2 = { nIdReceb: 12077966878, chaveAcesso: CHAVE_CALL2 };

  it('cRecebido=S + identidade ok → reconciliar (caso dominante: humano já entrou no Omie)', () => {
    const r = decidirEfeitoReconcileLote(clsOk, CONSULTA_CALL2, esperadoCall2);
    expect(r).toEqual({ efeito: 'reconciliar' });
  });

  it('consulta falhou (ex. REDUNDANT do rate-limit) → pular, mesmo com body de NF recebida', () => {
    const cls = { sucesso: false, erro: 'Consumo redundante detectado (REDUNDANT)', omieStatus: null };
    const r = decidirEfeitoReconcileLote(cls, CONSULTA_CALL2, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'consulta_falhou' });
  });

  it('identidade divergente (nIdReceb de outra NF) → pular; NUNCA reconcilia NF errada mesmo com cRecebido=S', () => {
    const r = decidirEfeitoReconcileLote(clsOk, CONSULTA_CALL2, { nIdReceb: 999, chaveAcesso: CHAVE_CALL2 });
    expect(r).toEqual({ efeito: 'pular', motivo: 'identidade_divergente' });
  });

  it('chave de acesso divergente → pular por identidade', () => {
    const r = decidirEfeitoReconcileLote(clsOk, CONSULTA_CALL2, { nIdReceb: 12077966878, chaveAcesso: '9'.repeat(44) });
    expect(r).toEqual({ efeito: 'pular', motivo: 'identidade_divergente' });
  });

  it('cRecebido≠S e etapa<80 → pular (aguardando conferência legítima; varredura não escreve no Omie)', () => {
    const body = { ...CONSULTA_CALL2, cabec: { ...CONSULTA_CALL2.cabec, cEtapa: '20' }, infoCadastro: { cRecebido: 'N' } };
    const r = decidirEfeitoReconcileLote(clsOk, body, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'aguardando_conferencia' });
  });

  it('cEtapa=80 sem cRecebido=S → pular como inconsistente (sinal fica no resumo, não no painel)', () => {
    const body = { ...CONSULTA_CALL2, infoCadastro: { cRecebido: 'N' } };
    const r = decidirEfeitoReconcileLote(clsOk, body, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'inconsistente' });
  });

  it('body malformado (sem cabec/nIdReceb) → pular por identidade (fail-closed, nunca reconciliar às cegas)', () => {
    const r = decidirEfeitoReconcileLote(clsOk, {}, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'identidade_divergente' });
  });

  it('NF cancelada no Omie → pular como cancelada, mesmo com cRecebido=S (recebida-e-cancelada não vira efetivada)', () => {
    const body = { ...CONSULTA_CALL2, infoCadastro: { ...CONSULTA_CALL2.infoCadastro, cCancelada: 'S' } };
    const r = decidirEfeitoReconcileLote(clsOk, body, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'cancelada' });
  });

  it('resposta sem chave de acesso → pular por identidade (varredura exige chave; só o fluxo manual tolera ausência)', () => {
    const body = { ...CONSULTA_CALL2, cabec: { ...CONSULTA_CALL2.cabec, cChaveNfe: undefined } };
    const r = decidirEfeitoReconcileLote(clsOk, body, esperadoCall2);
    expect(r).toEqual({ efeito: 'pular', motivo: 'identidade_divergente' });
  });
});

describe('resumirReconcileLote', () => {
  it('conta reconciliadas e puladas por motivo; processadas = total', () => {
    const efeitos: EfeitoReconcile[] = [
      { efeito: 'reconciliar' },
      { efeito: 'reconciliar' },
      { efeito: 'pular', motivo: 'consulta_falhou' },
      { efeito: 'pular', motivo: 'aguardando_conferencia' },
      { efeito: 'pular', motivo: 'aguardando_conferencia' },
      { efeito: 'pular', motivo: 'inconsistente' },
      { efeito: 'pular', motivo: 'identidade_divergente' },
      { efeito: 'pular', motivo: 'cancelada' },
    ];
    expect(resumirReconcileLote(efeitos)).toEqual({
      processadas: 8,
      reconciliadas: 2,
      puladas: { consulta_falhou: 1, cancelada: 1, identidade_divergente: 1, aguardando_conferencia: 2, inconsistente: 1 },
    });
  });

  it('lote vazio → tudo zero', () => {
    expect(resumirReconcileLote([])).toEqual({
      processadas: 0,
      reconciliadas: 0,
      puladas: { consulta_falhou: 0, cancelada: 0, identidade_divergente: 0, aguardando_conferencia: 0, inconsistente: 0 },
    });
  });
});

describe('ehErroRedundante (trava anti-redundância do Omie — por MÉTODO, provada em prod 2026-07-16)', () => {
  it('faultstring REDUNDANT → true (não re-tentar: cada hit renova a trava)', () => {
    expect(ehErroRedundante('ERROR: Consumo redundante detectado. Aguarde 58 segundos para tentar novamente (REDUNDANT).')).toBe(true);
  });
  it('variações de caixa e sem o sufixo (REDUNDANT) → true', () => {
    expect(ehErroRedundante('consumo REDUNDANTE detectado')).toBe(true);
    expect(ehErroRedundante('(REDUNDANT)')).toBe(true);
  });
  it('erros comuns não-redundantes → false', () => {
    expect(ehErroRedundante('HTTP 500')).toBe(false);
    expect(ehErroRedundante('O preenchimento da tag [nValUnit] é obrigatório')).toBe(false);
    expect(ehErroRedundante(null)).toBe(false);
    expect(ehErroRedundante(undefined)).toBe(false);
  });
});

describe('extrairRecebidosDaListagem (ListarRecebimentos → mapa nIdReceb → estado + chave)', () => {
  const CH = (n: number) => String(n).repeat(44).slice(0, 44);
  const paginaReal = {
    nTotalPaginas: 1,
    recebimentos: [
      { cabec: { nIdReceb: 111, cChaveNfe: CH(1) }, infoCadastro: { cRecebido: 'S', cCancelada: 'N' } },
      { cabec: { nIdReceb: 222, cChaveNfe: CH(2) }, infoCadastro: { cRecebido: 'N', cCancelada: 'N' } },
      { cabec: { nIdReceb: 333, cChaveNfe: CH(3) }, infoCadastro: { cRecebido: 'S', cCancelada: 'S' } },
      { nIdReceb: 444, infoCadastro: { cRecebido: 'S' } }, // raiz, sem chave
      { cabec: { nIdReceb: '555', cChaveNFe: CH(5) }, infoCadastro: { cRecebido: 'S' } }, // string + grafia cChaveNFe
      { cabec: {} }, // sem id → ignorado
    ],
  };

  it('mapeia nIdReceb (cabec ou raiz, string ou number) → {recebido, cancelada, chave} (ambas grafias de chave)', () => {
    const m = extrairRecebidosDaListagem([paginaReal]);
    expect(m.get(111)).toEqual({ recebido: true, cancelada: false, chave: CH(1), duplicado: false });
    expect(m.get(222)).toEqual({ recebido: false, cancelada: false, chave: CH(2), duplicado: false });
    expect(m.get(333)).toEqual({ recebido: true, cancelada: true, chave: CH(3), duplicado: false });
    expect(m.get(444)).toEqual({ recebido: true, cancelada: false, chave: null, duplicado: false });
    expect(m.get(555)).toEqual({ recebido: true, cancelada: false, chave: CH(5), duplicado: false });
    expect(m.size).toBe(5);
  });

  it('nIdReceb repetido na listagem → marcado duplicado (fail-closed no cruzamento)', () => {
    const m = extrairRecebidosDaListagem([{
      recebimentos: [
        { cabec: { nIdReceb: 7, cChaveNfe: CH(7) }, infoCadastro: { cRecebido: 'S' } },
        { cabec: { nIdReceb: 7, cChaveNfe: CH(8) }, infoCadastro: { cRecebido: 'S' } },
      ],
    }]);
    expect(m.get(7)?.duplicado).toBe(true);
  });

  it('páginas malformadas/vazias → mapa vazio (nunca lança)', () => {
    expect(extrairRecebidosDaListagem([]).size).toBe(0);
    expect(extrairRecebidosDaListagem([null, 'x', 42, {}]).size).toBe(0);
  });
});

describe('selecionarCandidatasReconcile (identidade forte DIRETO da listagem — Codex v2 P1)', () => {
  const CH = (n: number) => String(n).repeat(44).slice(0, 44);
  const listagem = extrairRecebidosDaListagem([{
    recebimentos: [
      { cabec: { nIdReceb: 1, cChaveNfe: CH(1) }, infoCadastro: { cRecebido: 'S', cCancelada: 'N' } },
      { cabec: { nIdReceb: 2, cChaveNfe: CH(2) }, infoCadastro: { cRecebido: 'N' } },
      { cabec: { nIdReceb: 3, cChaveNfe: CH(3) }, infoCadastro: { cRecebido: 'S', cCancelada: 'S' } },
      { cabec: { nIdReceb: 4 }, infoCadastro: { cRecebido: 'S' } },                       // sem chave na listagem
      { cabec: { nIdReceb: 5, cChaveNfe: CH(9) }, infoCadastro: { cRecebido: 'S' } },     // chave diverge do app
      { cabec: { nIdReceb: 6, cChaveNfe: CH(6) }, infoCadastro: { cRecebido: 'S' } },
      { cabec: { nIdReceb: 6, cChaveNfe: CH(6) }, infoCadastro: { cRecebido: 'S' } },     // duplicado
    ],
  }]);

  it('reconcilia SÓ com id+chave iguais, recebida, não-cancelada, sem duplicata', () => {
    const pendentes = [
      { id: 'a', omie_id_receb: 1, chave_acesso: CH(1) },  // ✓ tudo certo
      { id: 'b', omie_id_receb: 2, chave_acesso: CH(2) },  // não recebida
      { id: 'c', omie_id_receb: 3, chave_acesso: CH(3) },  // cancelada
      { id: 'd', omie_id_receb: 4, chave_acesso: CH(4) },  // listagem sem chave → fail-closed
      { id: 'e', omie_id_receb: 5, chave_acesso: CH(5) },  // chave diverge → fail-closed
      { id: 'f', omie_id_receb: 6, chave_acesso: CH(6) },  // duplicado na listagem → fail-closed
      { id: 'g', omie_id_receb: 9, chave_acesso: CH(9) },  // fora da listagem
    ];
    const r = selecionarCandidatasReconcile(pendentes, listagem, 10);
    expect(r.candidatas.map((c) => c.id)).toEqual(['a']);
    expect(r.naoRecebidas).toBe(1);
    expect(r.canceladas).toBe(1);
    expect(r.identidadeFraca).toBe(2); // 'd' (sem chave) + 'e' (chave divergente)
    expect(r.duplicadas).toBe(1);      // 'f'
    expect(r.foraDaListagem).toBe(1);  // 'g'
  });

  it('pendentes do app com o MESMO omie_id_receb (dado sujo, sem UNIQUE no banco) → nenhuma reconcilia', () => {
    const pendentes = [
      { id: 'x1', omie_id_receb: 1, chave_acesso: CH(1) },
      { id: 'x2', omie_id_receb: 1, chave_acesso: CH(1) },
    ];
    const r = selecionarCandidatasReconcile(pendentes, listagem, 10);
    expect(r.candidatas).toEqual([]);
    expect(r.duplicadas).toBe(2);
  });

  it('pendente sem chave de acesso no app ou id nulo → ignorada fail-closed', () => {
    const r = selecionarCandidatasReconcile(
      [
        { id: 'x', omie_id_receb: null, chave_acesso: CH(1) },  // sem id → ignorada (nenhum contador)
        { id: 'y', omie_id_receb: 1, chave_acesso: null },      // app sem chave → identidade fraca
        { id: 'z', omie_id_receb: 4, chave_acesso: CH(4) },     // listagem sem chave → identidade fraca
      ],
      listagem,
      10,
    );
    expect(r.candidatas).toEqual([]);
    expect(r.identidadeFraca).toBe(2);
  });

  it('cap limita as candidatas (as primeiras na ordem dada — mais antigas primeiro)', () => {
    const lst = extrairRecebidosDaListagem([{
      recebimentos: [1, 2, 3].map((n) => ({ cabec: { nIdReceb: n, cChaveNfe: CH(n) }, infoCadastro: { cRecebido: 'S' } })),
    }]);
    const pend = [1, 2, 3].map((n) => ({ id: `p${n}`, omie_id_receb: n, chave_acesso: CH(n) }));
    const r = selecionarCandidatasReconcile(pend, lst, 2);
    expect(r.candidatas.map((c) => c.id)).toEqual(['p1', 'p2']);
  });
});
