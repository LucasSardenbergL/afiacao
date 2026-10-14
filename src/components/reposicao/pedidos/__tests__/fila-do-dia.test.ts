import { describe, expect, it } from 'vitest';
import { motivoBloqueioAprovacao, ordenarFilaDoDia, resumirFilaDoDia } from '../fila-do-dia';

const p = (status: string, valor_total: number | null, fornecedor_nome = 'X') => ({ status, valor_total, fornecedor_nome });

describe('ordenarFilaDoDia', () => {
  it('põe o que espera decisão primeiro e o disparado por último', () => {
    const fila = ordenarFilaDoDia([
      p('disparado', 900),
      p('aprovado_aguardando_disparo', 800),
      p('falha_envio', 700),
      p('pendente_aprovacao', 100),
      p('bloqueado_guardrail', 50),
    ]);
    expect(fila.map((x) => x.status)).toEqual([
      'pendente_aprovacao',
      'bloqueado_guardrail',
      'falha_envio',
      'aprovado_aguardando_disparo',
      'disparado',
    ]);
  });

  it('dentro do grupo, o mais caro primeiro; valor ausente vai para o fim do grupo', () => {
    const fila = ordenarFilaDoDia([p('pendente_aprovacao', null, 'A'), p('pendente_aprovacao', 10, 'B'), p('pendente_aprovacao', 99, 'C')]);
    expect(fila.map((x) => x.fornecedor_nome)).toEqual(['C', 'B', 'A']);
  });

  it('não muta a lista de entrada', () => {
    const entrada = [p('disparado', 1), p('pendente_aprovacao', 1)];
    ordenarFilaDoDia(entrada);
    expect(entrada[0].status).toBe('disparado');
  });
});

describe('resumirFilaDoDia', () => {
  it('conta por grupo e soma só o que está a aprovar', () => {
    const r = resumirFilaDoDia([
      p('pendente_aprovacao', 100),
      p('bloqueado_guardrail', 50),
      p('falha_envio', 999),
      p('aprovado_aguardando_disparo', 999),
      p('disparado', 999),
      p('disparado', 999),
    ]);
    expect(r).toEqual({ aAprovar: 2, falhou: 1, aguardandoDisparo: 1, disparados: 2, valorAAprovar: 150, valorAAprovarParcial: false });
  });

  it('ausente ≠ zero: a aprovar sem nenhum valor dá null, não R$ 0', () => {
    expect(resumirFilaDoDia([p('pendente_aprovacao', null)]).valorAAprovar).toBeNull();
  });

  it('valor parcial é sinalizado', () => {
    const r = resumirFilaDoDia([p('pendente_aprovacao', null), p('pendente_aprovacao', 40)]);
    expect(r.valorAAprovar).toBe(40);
    expect(r.valorAAprovarParcial).toBe(true);
  });

  it('nada a aprovar é 0 legítimo', () => {
    expect(resumirFilaDoDia([p('disparado', 10)]).valorAAprovar).toBe(0);
  });
});

describe('motivoBloqueioAprovacao', () => {
  const ok = { itensEstado: 'ok' as const, nItens: 3, condicaoSelecionada: true };
  it('libera com itens lidos e condição', () => {
    expect(motivoBloqueioAprovacao(ok)).toBeNull();
  });
  it('bloqueia enquanto carrega', () => {
    expect(motivoBloqueioAprovacao({ ...ok, itensEstado: 'carregando' })).toMatch(/Carregando os itens/);
  });
  it('bloqueia quando a leitura dos itens falhou', () => {
    expect(motivoBloqueioAprovacao({ ...ok, itensEstado: 'erro' })).toMatch(/consegui carregar os itens/);
  });
  it('bloqueia pedido sem itens', () => {
    expect(motivoBloqueioAprovacao({ ...ok, nItens: 0 })).toMatch(/sem itens/);
  });
  it('bloqueia sem condição de pagamento', () => {
    expect(motivoBloqueioAprovacao({ ...ok, condicaoSelecionada: false })).toMatch(/condição de pagamento/);
  });
});
