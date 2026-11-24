import { describe, expect, it } from 'vitest';
import { falhasDaOrdemProducao } from '../ordemProducao';

describe('falhasDaOrdemProducao (PR 8.4)', () => {
  it('uma mensagem por produto que falhou, com o motivo do Omie', () => {
    const m = falhasDaOrdemProducao({
      success: false,
      falhas: 1,
      desfecho: [
        { status: 'criada', descricao: 'BASE A' },
        { status: 'falhou', descricao: 'BASE B', motivo: 'Produto sem estrutura' },
        { status: 'ja_existia', descricao: 'BASE C' },
      ],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('BASE B');
    expect(m[0]).toContain('Produto sem estrutura');
    expect(m[0]).toContain('NÃO foi criada');
  });

  it('tudo criado ou já existente → nenhuma falha', () => {
    expect(falhasDaOrdemProducao({ success: true, desfecho: [{ status: 'criada' }, { status: 'ja_existia' }] }))
      .toEqual([]);
  });

  it('falha sem descrição nem motivo não fica vazia', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{ status: 'falhou' }] });
    expect(m).toContain('de produto');
    expect(m).toContain('sem detalhe do Omie');
  });

  it('edge antiga: success false sem desfecho → falha genérica; success true → nada', () => {
    expect(falhasDaOrdemProducao({ success: false })).toHaveLength(1);
    expect(falhasDaOrdemProducao({ success: true, production_orders: [] })).toEqual([]);
    expect(falhasDaOrdemProducao(null)).toEqual([]);
  });
});
