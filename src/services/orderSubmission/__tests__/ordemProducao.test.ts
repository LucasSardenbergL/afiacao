import { describe, expect, it } from 'vitest';
import { falhasDaOrdemProducao, falhasDeTransporteOp } from '../ordemProducao';

// Núcleo (corte após 4 rodadas do Codex): nenhuma mensagem de falha manda criar à mão nem cita quantidade.
const NAO_CRIE = 'Não crie à mão';
const proibidas = (m: string) => {
  expect(m).not.toMatch(/antes de criar/i);
  expect(m).not.toMatch(/no total/i);
  expect(m).not.toMatch(/Crie a OP/);
  expect(m).not.toContain('chave de integração');
};

describe('falhasDaOrdemProducao (PR 8.4)', () => {
  it('uma mensagem por produto que falhou, com o motivo — sem a chave cCodIntOP como instrução', () => {
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

  it.each([
    ['indeterminado', { status: 'falhou', tipo: 'indeterminado', descricao: 'BASE C', motivo: 'timeout', quantidade: 5 }],
    ['tipo ausente (edge sem tipo)', { status: 'falhou', descricao: 'BASE C', motivo: 'timeout' }],
    ['invalido', { status: 'falhou', tipo: 'invalido', descricao: 'BASE C', motivo: 'produto sem código no Omie' }],
  ])('%s: não confirmada — NÃO crie à mão, peça a conferência à produção', (_n, d) => {
    const [m] = falhasDaOrdemProducao({ desfecho: [d] });
    expect(m).toContain('BASE C');
    expect(m).toContain('não confirmada no Omie');
    expect(m).toContain(NAO_CRIE);
    expect(m).toContain('quem cuida da produção');
    proibidas(m);
  });

  it('sem_registro_local: a OP existe no Omie — manda NÃO criar outra', () => {
    const [m] = falhasDaOrdemProducao({ desfecho: [{
      status: 'falhou', tipo: 'sem_registro_local', descricao: 'BASE D',
      motivo: 'OP de id 321 no Omie existe no Omie, mas o app não confirmou o registro local (x)',
    }] });
    expect(m).toContain('Não crie outra');
    expect(m).toContain('conferência do vínculo');
    expect(m).not.toContain('não confirmada no Omie');
    proibidas(m);
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
    expect(m[0]).toContain(NAO_CRIE);
  });

  it('edge antiga: id remoto em TEXTO conta como confirmado (a v1.47 repassa o nCodOP cru)', () => {
    expect(falhasDaOrdemProducao({ success: true, production_orders: [{ id: 'x', omie_ordem_id: '77', descricao: 'OK' }] })).toEqual([]);
  });

  it('edge antiga sem recusa → nada; success false sem lista → genérica; nada → nada', () => {
    expect(falhasDaOrdemProducao({ success: true, production_orders: [{ omie_ordem_id: 5 }] })).toEqual([]);
    expect(falhasDaOrdemProducao({ success: false })).toHaveLength(1);
    expect(falhasDaOrdemProducao(null)).toEqual([]);
  });
});

describe('falhasDeTransporteOp (PR 8.4)', () => {
  it('um aviso por produto (nome repetido conta uma vez), com o erro, sem quantidade e sem mandar criar', () => {
    const m = falhasDeTransporteOp(['BASE E', 'BASE E', 'BASE F', null], 'Edge Function returned a non-2xx status code');
    expect(m).toHaveLength(3);
    expect(m[0]).toContain('BASE E');
    expect(m[1]).toContain('BASE F');
    for (const x of m) {
      expect(x).toContain('non-2xx');
      expect(x).toContain(NAO_CRIE);
      proibidas(x);
    }
    expect(falhasDeTransporteOp([], 'caiu')).toHaveLength(1);
  });
});
