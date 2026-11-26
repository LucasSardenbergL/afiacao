import { describe, expect, it } from 'vitest';
import {
  brl,
  discordaDaIa,
  faceRecomendacao,
  horasNaFila,
  motivoValido,
  ordenarFila,
  passouDoSla,
  usoPosPedido,
  type ItemFila,
} from './fila';

const base: ItemFila = {
  origem: 'efetivo', item_id: 'i1', solicitacao_id: 's1', decisao_id: 'd1', sales_order_id: 'so1',
  company: 'oben', revisao: 'r1', valor_brl: 5000, prazo_dias: 28, motivo: 'estoura_limite', faixa: 'amarelo',
  limite_brl: 10000, prazo_max_dias: 60, exposicao_titulos_brl: 4000, exposicao_reservas_brl: 2000,
  status: 'aberta', criado_em: '2026-11-25T10:00:00Z', decidida_em: null, customer_user_id: null,
  omie_numero_pedido: null, pedido_status: null, vendedor_user_id: null, origem_pedido: 'app',
  recomendacao_status: null, recomendacao: null, prazo_sugerido_dias: null, recomendacao_confianca: null,
  recomendacao_codigos: null,
};

describe('fila de crédito — ausente ≠ zero', () => {
  it('valor não medido vira "—", nunca R$ 0', () => {
    expect(brl(null)).toBe('—');
    expect(brl(undefined)).toBe('—');
    expect(brl(0)).toContain('0,00');
  });

  it('uso do limite é null se uma parcela da exposição não foi medida', () => {
    expect(usoPosPedido({ ...base, exposicao_titulos_brl: null })).toBeNull();
    expect(usoPosPedido({ ...base, limite_brl: null })).toBeNull();
    expect(usoPosPedido({ ...base, limite_brl: 0 })).toBeNull();
    expect(usoPosPedido(base)).toBeCloseTo(1.1);
  });
});

describe('fila de crédito — SLA de 2 h', () => {
  const agora = new Date('2026-11-25T12:00:00Z');
  it('efetivo aberto com 2 h conta como estourado; 1h59 não', () => {
    expect(passouDoSla(base, agora)).toBe(true);
    expect(passouDoSla({ ...base, criado_em: '2026-11-25T10:01:00Z' }, agora)).toBe(false);
  });
  it('sombra e congelada nunca estouram SLA', () => {
    expect(passouDoSla({ ...base, origem: 'sombra', status: 'simulada' }, agora)).toBe(false);
    expect(passouDoSla({ ...base, status: 'congelada' }, agora)).toBe(false);
  });
  it('horas na fila', () => {
    expect(horasNaFila(base.criado_em, agora)).toBe(2);
  });
});

describe('fila de crédito — recomendação', () => {
  it('sem linha ou em andamento → chegando; esgotada → falhou; abstenção', () => {
    expect(faceRecomendacao(base).tipo).toBe('chegando');
    expect(faceRecomendacao({ ...base, recomendacao_status: 'em_andamento' }).tipo).toBe('chegando');
    expect(faceRecomendacao({ ...base, recomendacao_status: 'esgotada' }).tipo).toBe('falhou');
    expect(faceRecomendacao({ ...base, recomendacao_status: 'ok', recomendacao: 'sem_recomendacao' }).tipo).toBe('abstencao');
  });

  it('discordar da IA exige motivo; sem recomendação não há discordância', () => {
    const aprovar = faceRecomendacao({ ...base, recomendacao_status: 'ok', recomendacao: 'aprovar', recomendacao_confianca: 0.8 });
    expect(discordaDaIa(aprovar, false)).toBe(true);
    expect(discordaDaIa(aprovar, true)).toBe(false);
    expect(discordaDaIa(faceRecomendacao(base), false)).toBe(false);
    expect(motivoValido('  ok ')).toBe(false);
    expect(motivoValido('cliente antigo')).toBe(true);
  });
});

describe('fila de crédito — ordem', () => {
  it('efetivo aberto mais velho primeiro, depois efetivo encerrado, depois sombra', () => {
    const itens: ItemFila[] = [
      { ...base, item_id: 'sombra', origem: 'sombra', status: 'simulada', criado_em: '2026-11-25T08:00:00Z' },
      { ...base, item_id: 'novo', criado_em: '2026-11-25T11:00:00Z' },
      { ...base, item_id: 'velho', criado_em: '2026-11-25T09:00:00Z' },
      { ...base, item_id: 'superada', status: 'superada', criado_em: '2026-11-25T07:00:00Z' },
    ];
    expect(ordenarFila(itens).map((i) => i.item_id)).toEqual(['velho', 'novo', 'superada', 'sombra']);
  });
});
