import { describe, expect, it } from 'vitest';
import { falhasDaOrdemProducao, falhasDeTransporteOp } from '../ordemProducao';

describe('falhasDaOrdemProducao (PR 8.4)', () => {
  it('uma mensagem por produto que falhou, com o motivo; a chave cCodIntOP não é instrução de busca', () => {
    const m = falhasDaOrdemProducao({
      success: false,
      falhas: 1,
      desfecho: [
        { status: 'criada', descricao: 'BASE A' },
        { status: 'falhou', tipo: 'indeterminado', descricao: 'BASE B', motivo: 'Produto sem estrutura', chave: 'OP_abc_202' },
      ],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('BASE B');
    expect(m[0]).toContain('Produto sem estrutura');
    expect(m[0]).not.toContain('OP_abc_202');
  });

  it('indeterminado (e tipo ausente): conferir por produto e quantidade antes de criar outra', () => {
    for (const d of [{ status: 'falhou', tipo: 'indeterminado', motivo: 'timeout' }, { status: 'falhou', motivo: 'timeout' }]) {
      const [m] = falhasDaOrdemProducao({ desfecho: [d] });
      expect(m).toContain('antes de criar outra');
      expect(m).toContain('pode já existir');
      expect(m).toContain('produto e quantidade');
      expect(m).not.toContain('Corrija o item');
    }
  });

  it('sem_registro_local: a OP existe no Omie — manda NÃO criar outra (2ª rodada do Codex)', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{
      status: 'falhou', tipo: 'sem_registro_local', descricao: 'BASE C',
      motivo: 'OP de id 321 no Omie FOI criada no Omie, mas não ficou registrada no app (x)',
    }] });
    expect(m).toContain('Não crie outra');
    expect(m).toContain('conferência do vínculo');
    expect(m).not.toContain('antes de criar outra');
  });

  it('invalido: uma LINHA não foi ao Omie — nunca diz que o produto não foi enviado (3ª rodada do Codex)', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou', tipo: 'invalido', descricao: 'BASE D', motivo: 'produto sem código no Omie' }] });
    expect(m).toContain('Uma linha de BASE D não pôde ir ao Omie');
    expect(m).toContain('produto sem código no Omie');
    expect(m).toContain('confira no Omie');
    expect(m).not.toContain('não foi enviada');
  });

  it('indeterminado com quantidade: a conferência é pelo TOTAL da OP agregada', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou', tipo: 'indeterminado', descricao: 'BASE G', motivo: 'timeout', quantidade: 5 }] });
    expect(m).toContain('5 no total');
  });

  it('erro de transporte: um aviso por CÓDIGO Omie com a quantidade somada (3ª rodada do Codex)', () => {
    const m = falhasDeTransporteOp([
      { descricao: 'BASE E', omie_codigo_produto: 10, quantidade: 2 },
      { descricao: 'BASE E', omie_codigo_produto: 10, quantidade: 3 },
      { descricao: 'BASE F', omie_codigo_produto: 11, quantidade: 1 },
      { descricao: 'SEM CODIGO', omie_codigo_produto: null, quantidade: 4 },
    ], 'Edge Function returned a non-2xx status code');
    expect(m).toHaveLength(3);
    expect(m[0]).toContain('BASE E (5 no total');
    expect(m[1]).toContain('BASE F (1 no total');
    expect(m[2]).toContain('SEM CODIGO');
    for (const x of m) {
      expect(x).toContain('non-2xx');
      expect(x).toContain('antes de criar outra');
    }
    expect(falhasDeTransporteOp([], 'caiu')).toHaveLength(1);
  });

  it('edge antiga: id remoto em TEXTO conta como confirmado (a v1.47 repassa o nCodOP cru)', () => {
    expect(falhasDaOrdemProducao({ success: true, production_orders: [{ id: 'x', omie_ordem_id: '77', descricao: 'OK' }] })).toEqual([]);
  });

  it('tudo criado → nenhuma falha', () => {
    expect(falhasDaOrdemProducao({ success: true, desfecho: [{ status: 'criada' }, { status: 'criada' }] }))
      .toEqual([]);
  });

  it('falha sem descrição nem motivo não fica vazia', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou' }] });
    expect(m).toContain('de produto');
    expect(m).toContain('sem detalhe do Omie');
  });

  it('edge antiga: OP sem id na lista vira aviso (antes fechava calado)', () => {
    const m = falhasDaOrdemProducao({
      success: true,
      production_orders: [{ omie_ordem_id: 77, descricao: 'OK' }, { omie_ordem_id: null, descricao: 'BASE Z' }],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('BASE Z');
  });

  it('edge antiga sem recusa → nada; success false sem lista → genérica; nada → nada', () => {
    expect(falhasDaOrdemProducao({ success: true, production_orders: [{ omie_ordem_id: 5 }] })).toEqual([]);
    expect(falhasDaOrdemProducao({ success: false })).toHaveLength(1);
    expect(falhasDaOrdemProducao(null)).toEqual([]);
  });
});
