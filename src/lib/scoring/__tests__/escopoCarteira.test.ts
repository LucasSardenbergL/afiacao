import { describe, it, expect } from 'vitest';
import { filtrarPorCarteira } from '../escopoCarteira';

/**
 * O universo da TELA do farmer.
 *
 * Medido em prod (2026-08-13, `docs/historico/farmer-scoring-paridade-ts-sql.md` §6): o
 * `useFarmerScoring` lista 835 clientes company-wide, mas só 294/395 são da carteira de cada
 * vendedora — e a RPC de margem responde só pela carteira. Resultado: "Sem custo conhecido" em
 * 562 de 835 clientes. Alinhar a tela ao escopo da RPC derruba isso para 21.
 *
 * A regra mora aqui, e não dentro do hook, pelo mesmo motivo de `healthScore.ts`: o que importa
 * é o comportamento de BORDA (carteira vazia), e ele não é testável no meio de query + agregação.
 */
describe('filtrarPorCarteira — o universo da tela', () => {
  const clientes = ['a', 'b', 'c'];

  it('sem capability, mantém só os clientes da carteira', () => {
    const r = filtrarPorCarteira(clientes, { capCarteiraLer: false, carteira: new Set(['a', 'c']) });
    expect(r).toEqual(['a', 'c']);
  });

  it('com cap_carteira_ler (gestor/master), devolve todos e ignora a carteira', () => {
    // O master é o CONTROLE do cenário medido: a RPC já lhe devolve tudo, então filtrar a tela
    // dele mudaria o que ele vê sem fechar delta nenhum (medido: 835→835, 58→58, 0 slots).
    const r = filtrarPorCarteira(clientes, { capCarteiraLer: true, carteira: new Set(['a']) });
    expect(r).toEqual(['a', 'b', 'c']);
  });

  it('carteira VAZIA sem capability devolve lista vazia — nunca a base inteira', () => {
    // Fail-closed. É o acidente do money-path.md §7 ao contrário: lá o caller leu lista vazia
    // como "este farmer não tem carteira, deve ser super_admin" e recarregou SEM filtro, virando
    // a base inteira o universo do cálculo. Vendedora sem carteira vê ZERO, não vê tudo.
    const r = filtrarPorCarteira(clientes, { capCarteiraLer: false, carteira: new Set() });
    expect(r).toEqual([]);
  });

  it('não inventa cliente que não estava na lista, mesmo se a carteira o contiver', () => {
    // A carteira RECORTA o universo; não o expande. Um assignment para cliente sem pedido não
    // pode fazer aparecer alguém que o motor não pontuou.
    const r = filtrarPorCarteira(clientes, { capCarteiraLer: false, carteira: new Set(['a', 'zzz']) });
    expect(r).toEqual(['a']);
  });

  it('preserva a ordem recebida', () => {
    // A ordem de entrada carrega a prioridade já calculada; reordenar aqui mudaria a agenda por
    // efeito colateral de um filtro.
    const r = filtrarPorCarteira(['c', 'a', 'b'], { capCarteiraLer: false, carteira: new Set(['a', 'b', 'c']) });
    expect(r).toEqual(['c', 'a', 'b']);
  });
});
