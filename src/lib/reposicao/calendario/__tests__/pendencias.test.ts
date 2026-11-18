import { describe, it, expect } from 'vitest';
import { calcularPendencias, janelaFimDeAno, addMeses, type EntradaPendencias } from '../pendencias';
import {
  montarGradeMes,
  agruparPeriodos,
  fimDoRecesso,
  rotuloRecebeEm,
  pesoDoStatus,
  datasDoPeriodo,
} from '../grade';

const HOJE = '2026-11-18';

function entrada(p: Partial<EntradaPendencias> = {}): EntradaPendencias {
  return {
    hoje: HOJE,
    feriados: [],
    diasEmpresa: [],
    diasSemNf: [],
    // longe o bastante para não gerar `calendario_curto` nos testes que não são dele
    ultimoDiaCadastrado: '2030-12-31',
    ...p,
  };
}

const doTipo = (ps: ReturnType<typeof calcularPendencias>, t: string) => ps.filter((p) => p.tipo === t);

describe('calcularPendencias — emenda', () => {
  it('feriado 08/12/2026 (terça) sem linha em 07/12 → pendência URGENTE em 2026-11-18', () => {
    const ps = calcularPendencias(entrada({ feriados: [{ data: '2026-12-08', nome: 'Feriado X' }] }));
    const em = doTipo(ps, 'emenda_sem_decisao');
    expect(em).toHaveLength(1);
    expect(em[0].data).toBe('2026-12-07');
    expect(em[0].urgente).toBe(true);
  });

  it('com linha aberto/emenda em 07/12 → nenhuma pendência (a decisão "trabalhar" também é decisão)', () => {
    const ps = calcularPendencias(
      entrada({
        feriados: [{ data: '2026-12-08', nome: 'Feriado X' }],
        diasEmpresa: [{ data: '2026-12-07', status: 'aberto', origem: 'emenda' }],
      }),
    );
    expect(doTipo(ps, 'emenda_sem_decisao')).toHaveLength(0);
  });

  it('feriado 2027-09-07 (terça) → pendência NÃO urgente na segunda 06/09', () => {
    const ps = calcularPendencias(entrada({ feriados: [{ data: '2027-09-07', nome: 'Independência' }] }));
    const em = doTipo(ps, 'emenda_sem_decisao');
    expect(em).toHaveLength(1);
    expect(em[0].data).toBe('2027-09-06');
    expect(em[0].urgente).toBe(false);
  });

  it('quinta → a ponte é a sexta seguinte; feriado em quarta não gera emenda', () => {
    const ps = calcularPendencias(
      entrada({
        feriados: [
          { data: '2027-06-03', nome: 'Corpus Christi' }, // quinta
          { data: '2026-12-02', nome: 'Quarta qualquer' },
        ],
      }),
    );
    expect(doTipo(ps, 'emenda_sem_decisao').map((p) => p.data)).toEqual(['2027-06-04']);
  });
});

describe('calcularPendencias — emenda de feriado MUNICIPAL (linha da empresa, origem feriado)', () => {
  // Carga real: 01/06/2027 (terça) São Firmino é linha origem='feriado' fechada; a ponte 31/05 foi decidida (emenda).
  const saoFirmino = { data: '2027-06-01', status: 'fechado', origem: 'feriado', motivo: 'São Firmino (municipal, Lei 744/1967)' };

  it('sem a decisão de 31/05/2027 → pendência de emenda na segunda 31/05, com o nome do municipal', () => {
    const ps = calcularPendencias(entrada({ diasEmpresa: [saoFirmino] }));
    const em = doTipo(ps, 'emenda_sem_decisao');
    expect(em.map((p) => p.data)).toEqual(['2027-05-31']);
    expect(em[0].texto).toContain('São Firmino');
  });

  it('CONTROLE: com a decisão de 31/05/2027 (emenda) → nenhuma pendência', () => {
    const ps = calcularPendencias(
      entrada({ diasEmpresa: [{ data: '2027-05-31', status: 'fechado', origem: 'emenda' }, saoFirmino] }),
    );
    expect(doTipo(ps, 'emenda_sem_decisao')).toHaveLength(0);
  });

  it('linha de feriado ABERTA (empresa trabalha) não conta como feriado', () => {
    const ps = calcularPendencias(entrada({ diasEmpresa: [{ ...saoFirmino, status: 'aberto' }] }));
    expect(doTipo(ps, 'emenda_sem_decisao')).toHaveLength(0);
  });

  it('mesma data nos dois: calendario_feriados vence no nome e não duplica a pendência', () => {
    const ps = calcularPendencias(
      entrada({ feriados: [{ data: '2027-06-01', nome: 'Nome nacional' }], diasEmpresa: [saoFirmino] }),
    );
    const em = doTipo(ps, 'emenda_sem_decisao');
    expect(em).toHaveLength(1);
    expect(em[0].texto).toContain('Nome nacional');
  });
});

describe('calcularPendencias — dia sem NF', () => {
  it('cada data da RPC vira pendência, e a linha pendente_dado não decidida também', () => {
    const ps = calcularPendencias(
      entrada({
        diasSemNf: ['2026-11-10'],
        diasEmpresa: [
          { data: '2026-05-11', status: 'pendente_dado', origem: 'historico' },
          { data: '2026-05-15', status: 'pendente_dado', origem: 'manual' }, // decidida: "dado faltante"
        ],
      }),
    );
    expect(doTipo(ps, 'dia_sem_nf').map((p) => p.data).sort()).toEqual(['2026-05-11', '2026-11-10']);
  });
});

describe('calcularPendencias — calendário curto', () => {
  it('último dia 2027-06-30 em 2026-11-18 → calendario_curto', () => {
    const ps = calcularPendencias(entrada({ ultimoDiaCadastrado: '2027-06-30' }));
    expect(doTipo(ps, 'calendario_curto')).toHaveLength(1);
  });

  it('último dia ≥ hoje + 12 meses → nada', () => {
    const ps = calcularPendencias(entrada({ ultimoDiaCadastrado: '2027-11-18' }));
    expect(doTipo(ps, 'calendario_curto')).toHaveLength(0);
  });

  it('nenhum dia cadastrado → curto e urgente (ausente não é "ok")', () => {
    const ps = calcularPendencias(entrada({ ultimoDiaCadastrado: null }));
    const c = doTipo(ps, 'calendario_curto');
    expect(c).toHaveLength(1);
    expect(c[0].urgente).toBe(true);
  });
});

describe('calcularPendencias — fornecedor sem recesso', () => {
  it('fornecedor habilitado sem dia fechado entre 21/12 e 03/01 → pendência; com dia → nada', () => {
    const ps = calcularPendencias(
      entrada({
        fornecedoresHabilitados: ['RENNER SAYERLACK S/A', 'FORNECEDOR NOVO LTDA'],
        fechamentosFornecedor: [
          { data: '2026-12-24', fornecedor_nome: 'RENNER SAYERLACK S/A' },
          // fora da janela: não conta
          { data: '2026-12-10', fornecedor_nome: 'FORNECEDOR NOVO LTDA' },
        ],
      }),
    );
    const f = doTipo(ps, 'fornecedor_sem_recesso');
    expect(f.map((p) => p.fornecedor_nome)).toEqual(['FORNECEDOR NOVO LTDA']);
    expect(f[0].data).toBe('2026-12-21');
    expect(f[0].urgente).toBe(true);
  });

  it('sem a lista de habilitados a regra não roda (não fabrica pendência)', () => {
    const ps = calcularPendencias(entrada());
    expect(doTipo(ps, 'fornecedor_sem_recesso')).toHaveLength(0);
  });

  it('janela: em 02/01 ainda vale a de dezembro passado; em 04/01 já é a do fim do ano', () => {
    expect(janelaFimDeAno('2027-01-02')).toEqual({ de: '2026-12-21', ate: '2027-01-03' });
    expect(janelaFimDeAno('2027-01-04')).toEqual({ de: '2027-12-21', ate: '2028-01-03' });
  });
});

describe('ordem e datas', () => {
  it('urgentes primeiro', () => {
    const ps = calcularPendencias(
      entrada({
        feriados: [
          { data: '2027-09-07', nome: 'Independência' },
          { data: '2026-12-08', nome: 'Feriado X' },
        ],
        diasSemNf: ['2026-01-05'],
      }),
    );
    expect(ps[0].urgente).toBe(true);
  });

  it('addMeses fixa o fim do mês', () => {
    expect(addMeses('2026-11-18', 12)).toBe('2027-11-18');
    expect(addMeses('2027-01-31', 1)).toBe('2027-02-28');
  });
});

describe('grade', () => {
  it('dia SEM linha: seg–sex aberto, sáb/dom fechado (regra base), não "vazio"', () => {
    const g = montarGradeMes(2026, 11, [], []);
    expect(g).toHaveLength(30);
    const d18 = g.find((c) => c.data === '2026-11-18')!; // quarta
    const d21 = g.find((c) => c.data === '2026-11-21')!; // sábado
    expect([d18.status, d18.regraBase]).toEqual(['aberto', true]);
    expect([d21.status, d21.regraBase]).toEqual(['fechado', true]);
  });

  it('a linha manda sobre a regra base', () => {
    const g = montarGradeMes(
      2026,
      12,
      [{ data: '2026-12-26', status: 'aberto', peso: 1, motivo: 'inventário', origem: 'manual' }],
      [{ data: '2026-12-25', nome: 'Natal' }],
    );
    const d26 = g.find((c) => c.data === '2026-12-26')!; // sábado aberto por exceção
    expect([d26.status, d26.regraBase]).toEqual(['aberto', false]);
    expect(g.find((c) => c.data === '2026-12-25')!.feriado).toBe('Natal');
  });

  it('peso: fechado 0, o resto 1', () => {
    expect(pesoDoStatus('fechado')).toBe(0);
    expect(pesoDoStatus('meia_equipe')).toBe(1);
    expect(pesoDoStatus('pendente_dado')).toBe(1);
  });

  it('agrupa datas consecutivas por fornecedor', () => {
    const p = agruparPeriodos([
      { data: '2026-12-22', fornecedor_nome: 'A', motivo: 'recesso' },
      { data: '2026-12-23', fornecedor_nome: 'A', motivo: null },
      { data: '2026-12-26', fornecedor_nome: 'A', motivo: null },
      { data: '2026-12-22', fornecedor_nome: 'B', motivo: null },
    ]);
    expect(p.map((x) => [x.fornecedor_nome, x.de, x.ate, x.dias])).toEqual([
      ['A', '2026-12-22', '2026-12-23', 2],
      ['A', '2026-12-26', '2026-12-26', 1],
      ['B', '2026-12-22', '2026-12-22', 1],
    ]);
  });

  it('datasDoPeriodo recusa período invertido', () => {
    expect(datasDoPeriodo('2026-12-30', '2027-01-02')).toHaveLength(4);
    expect(() => datasDoPeriodo('2026-12-30', '2026-12-29')).toThrow(/anterior ao início/);
  });

  it('fimDoRecesso: maior fechado da janela; sem recesso → null', () => {
    const linhas = [
      { data: '2026-12-24', status: 'fechado' },
      { data: '2027-01-01', status: 'fechado' },
      { data: '2027-01-04', status: 'aberto' },
      { data: '2027-02-16', status: 'fechado' }, // carnaval, fora da janela
    ];
    expect(fimDoRecesso(linhas, HOJE)).toBe('2027-01-01');
    expect(fimDoRecesso([], HOJE)).toBeNull();
  });

  it('rotuloRecebeEm só com ajuste === true', () => {
    expect(rotuloRecebeEm({ recebimento_ajustado_calendario: true, data_recebimento_prevista: '2027-01-05' })).toBe(
      'recebe em 05/01',
    );
    expect(rotuloRecebeEm({ recebimento_ajustado_calendario: false, data_recebimento_prevista: '2027-01-05' })).toBeNull();
    expect(rotuloRecebeEm({ recebimento_ajustado_calendario: null, data_recebimento_prevista: '2027-01-05' })).toBeNull();
    expect(rotuloRecebeEm({ recebimento_ajustado_calendario: true, data_recebimento_prevista: null })).toBeNull();
  });
});
