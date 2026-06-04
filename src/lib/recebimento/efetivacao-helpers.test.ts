import { describe, it, expect } from 'vitest';
import {
  classificarRespostaOmie,
  erroBenigno,
  decidirStatusEfetivacao,
  selecionarPassosPendentes,
  podeReprocessar,
  resumirErros,
  type PassoFlags,
} from './efetivacao-helpers';

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
