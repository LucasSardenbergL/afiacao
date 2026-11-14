import { describe, expect, it } from 'vitest';
import { lerFilaSistemas, lerSensorSistemas, totalPedidos } from '../sistemas';
import { lerMinhasSugestoes, sugestoesDeSistema } from '../sugestoes';

const candidato = {
  id: 7, status: 'pendente', papel: 'catalisador',
  base: { omie_codigo_produto: 101, descricao: 'FUNDO PU FL.6673.00LT', familia: 'Fundos PU', pedidos_12m: 154, valor_12m: 145931.2 },
  par: { omie_codigo_produto: 201, descricao: 'CATALISADOR FC.6975LT', familia: 'Catalisadores PU' },
  juntos: 95, share: 0.6169,
  boletim: { situacao: 'confere', boletim: 'FUNDO PU 6673', codigo_boletim: 'FL.6673.00', codigo_citado: 'FC.6975', proporcao_pct: 50 },
};
const fila = {
  empresa: 'oben', medido_em: '2026-11-13', candidatos: [candidato],
  decididos: [{ id: 3, status: 'rejeitado', papel: 'diluente', decidido_em: '2026-11-13T10:00:00Z',
    base: { omie_codigo_produto: 102, descricao: 'SELADORA' }, par: { omie_codigo_produto: 302, descricao: null } }],
};

describe('lerFilaSistemas — borda fail-closed da fila do founder', () => {
  it('lê candidato, boletim e decididos', () => {
    const f = lerFilaSistemas(fila);
    expect(f.candidatos[0]).toMatchObject({ id: 7, papel: 'catalisador', juntos: 95, base: { pedidos12m: 154 } });
    expect(f.candidatos[0].boletim).toEqual({ situacao: 'confere', boletim: 'FUNDO PU 6673', codigoCitado: 'FC.6975', proporcaoPct: 50 });
    expect(f.decididos[0]).toMatchObject({ id: 3, status: 'rejeitado', par: { descricao: null } });
  });

  it('boletim null (nenhum casa) e ambíguo (mais de um) são estados distintos', () => {
    const f = lerFilaSistemas({ ...fila, candidatos: [{ ...candidato, boletim: null }, { ...candidato, id: 8, boletim: { situacao: 'ambiguo', boletins: 2 } }] });
    expect(f.candidatos.map((c) => c.boletim?.situacao ?? null)).toEqual([null, 'ambiguo']);
  });

  it('valor da base NULL (sem preço) fica null — nunca R$ 0', () => {
    const f = lerFilaSistemas({ ...fila, candidatos: [{ ...candidato, base: { ...candidato.base, valor_12m: null } }] });
    expect(f.candidatos[0].base.valor12m).toBeNull();
  });

  it('chave ausente LANÇA com o nome da chave (nunca vira fila vazia)', () => {
    const { candidatos: _c, ...sem } = fila;
    expect(() => lerFilaSistemas(sem)).toThrow('venda_sistema: fila.candidatos ausente');
    const { juntos: _j, ...semJuntos } = candidato;
    expect(() => lerFilaSistemas({ ...fila, candidatos: [semJuntos] })).toThrow('venda_sistema: candidato.juntos ausente');
  });

  it('status/papel desconhecido LANÇA (um "confirmado" na fila de candidatos seria estado impossível)', () => {
    expect(() => lerFilaSistemas({ ...fila, candidatos: [{ ...candidato, status: 'confirmado' }] }))
      .toThrow('venda_sistema: candidato.status desconhecido (confirmado)');
    expect(() => lerFilaSistemas({ ...fila, candidatos: [{ ...candidato, papel: 'primer' }] }))
      .toThrow('venda_sistema: candidato.papel desconhecido (primer)');
  });
});

describe('lerSensorSistemas — taxa só com denominador', () => {
  const sensor = {
    de: '2026-08-15', ate: '2026-11-13', base_pedidos: 'x',
    fila: [{ empresa: 'oben', mostrados: 5, confirmados: 2, rejeitados: 1, nao_sei: 1, pendentes: 1, taxa_confirmacao: 0.4 }],
    pedidos: [{ braco: 'tratamento', elegiveis: 5, completos: 1, taxa: 0.2 }, { braco: 'controle', elegiveis: 0, completos: 0, taxa: null }],
    sugestoes: [{ braco: 'controle', geradas: 2, mostradas: 0, abertas: 1, viraram: 0, nao_virou: 1, nao_medivel: 0, taxa: 0 }],
  };

  it('lê fila, pedidos por braço e sugestões', () => {
    const s = lerSensorSistemas(sensor);
    expect(s.fila[0]).toMatchObject({ mostrados: 5, confirmados: 2, naoSei: 1, taxaConfirmacao: 0.4 });
    expect(s.pedidos[1].taxa).toBeNull();
    expect(s.sugestoes[0]).toMatchObject({ geradas: 2, naoVirou: 1, taxa: 0 });
  });

  it('total: soma os braços; sem elegível a taxa é null (ausente ≠ zero)', () => {
    expect(totalPedidos(lerSensorSistemas(sensor).pedidos)).toEqual({ elegiveis: 5, completos: 1, taxa: 0.2 });
    expect(totalPedidos([])).toEqual({ elegiveis: 0, completos: 0, taxa: null });
  });

  it('número ilegível LANÇA', () => {
    expect(() => lerSensorSistemas({ ...sensor, fila: [{ ...sensor.fila[0], mostrados: 'muitos' }] }))
      .toThrow('venda_sistema: sensor.fila.mostrados nao numerico');
  });
});

describe('lerMinhasSugestoes — tipo sistema na ficha', () => {
  const base = {
    dia: '2026-11-13', ondas: { recompra: true, complemento: false, preco: false, sistema: true },
    compradores: [{
      comprador_id: 'c1', nome: 'A', telefone: null, motivo_entrada: 'maior atraso da carteira', valor_ref_total: 10,
      sugestoes: [
        { id: 'r1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 1, valor_ref: 10, sistema: null },
        { id: 's1', tipo: 'sistema', empresa: 'oben', omie_codigo_produto: 201, descricao: 'CATALISADOR FC.6975LT',
          sistema: { papel: 'catalisador', base_omie_codigo_produto: 101, base_descricao: 'FUNDO PU FL.6673.00LT' } },
      ],
    }],
  };

  it('ondas.sistema e o par da sugestão', () => {
    const r = lerMinhasSugestoes(base);
    expect(r.ondas.sistema).toBe(true);
    expect(sugestoesDeSistema(r.compradores[0]).map((s) => [s.id, s.sistema?.papel, s.sistema?.baseDescricao]))
      .toEqual([['s1', 'catalisador', 'FUNDO PU FL.6673.00LT']]);
  });

  it('sugestão sistema SEM o par não entra na seção (o servidor nunca manda; se mandar, não inventa)', () => {
    const c = { ...base.compradores[0], sugestoes: [{ ...base.compradores[0].sugestoes[1], sistema: null }] };
    expect(sugestoesDeSistema(lerMinhasSugestoes({ ...base, compradores: [c] }).compradores[0])).toEqual([]);
  });

  it('par malformado LANÇA; ondas.sistema não-booleano LANÇA', () => {
    const c = { ...base.compradores[0], sugestoes: [{ ...base.compradores[0].sugestoes[1], sistema: { papel: 'primer' } }] };
    expect(() => lerMinhasSugestoes({ ...base, compradores: [c] })).toThrow('venda_minhas_sugestoes: sistema malformado');
    expect(() => lerMinhasSugestoes({ ...base, ondas: { ...base.ondas, sistema: 'sim' } }))
      .toThrow('venda_minhas_sugestoes: ondas malformadas');
  });
});
