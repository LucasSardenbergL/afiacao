import { describe, expect, it } from 'vitest';
import { falhasDaOrdemProducao } from '../ordemProducao';

describe('falhasDaOrdemProducao (PR 8.4)', () => {
  it('uma mensagem por produto que falhou, com o motivo e a chave para procurar no Omie', () => {
    const m = falhasDaOrdemProducao({
      success: false,
      falhas: 1,
      desfecho: [
        { status: 'criada', descricao: 'BASE A' },
        { status: 'falhou', descricao: 'BASE B', motivo: 'Produto sem estrutura', chave: 'OP_abc_202' },
      ],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('BASE B');
    expect(m[0]).toContain('Produto sem estrutura');
    expect(m[0]).toContain('OP_abc_202');
  });

  it('nunca manda criar à mão sem procurar antes (timeout pode ter gravado)', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou', motivo: 'timeout' }] });
    expect(m).toContain('Antes de criar outra');
    expect(m).toContain('pode já existir');
    expect(m).not.toContain('Crie a OP');
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
