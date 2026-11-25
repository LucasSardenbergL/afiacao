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
    expect(m).toContain('vinculação');
    expect(m).not.toContain('antes de criar outra');
  });

  it('invalido: nem foi ao Omie — corrigir o item, sem mandar conferir OP', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou', tipo: 'invalido', descricao: 'BASE D', motivo: 'quantidade inválida' }] });
    expect(m).toContain('não foi enviada ao Omie');
    expect(m).toContain('quantidade inválida');
    expect(m).toContain('Corrija o item');
    expect(m).not.toContain('pode já existir');
  });

  it('erro de transporte: um aviso de conferência por produto enviado, com o erro', () => {
    const m = falhasDeTransporteOp(['BASE E', null, 'BASE F'], 'Edge Function returned a non-2xx status code');
    expect(m).toHaveLength(3);
    expect(m[0]).toContain('BASE E');
    expect(m[2]).toContain('BASE F');
    for (const x of m) {
      expect(x).toContain('non-2xx');
      expect(x).toContain('antes de criar outra');
    }
    expect(falhasDeTransporteOp([], 'caiu')).toHaveLength(1);
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
