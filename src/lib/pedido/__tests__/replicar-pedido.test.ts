import { describe, it, expect } from 'vitest';
import { montarPlanoReplicacao } from '../replicar-pedido';
import type { Product } from '@/hooks/unifiedOrder/types';

let idc = 0;
const produto = (over: Partial<Product> = {}): Product => ({
  id: `prod-${idc++}`,
  codigo: 'PRD0001',
  descricao: 'PRODUTO',
  unidade: 'UN',
  valor_unitario: 100,
  estoque: 10,
  ativo: true,
  omie_codigo_produto: 1,
  ...over,
});

const catalisador = produto({ id: 'cat', omie_codigo_produto: 111, descricao: 'CATALISADOR FC' });
const baseTinta = produto({
  id: 'base', omie_codigo_produto: 222, descricao: 'BASE BRILH BRANC PU WFBB.6045QT',
  is_tintometric: true, tint_type: 'base',
});

describe('montarPlanoReplicacao', () => {
  it('item comum achado no catálogo → direto, com a quantidade do pedido', () => {
    const plano = montarPlanoReplicacao(
      [{ descricao: 'CATALISADOR FC', quantidade: 3, valor_unitario: 50, omie_codigo_produto: 111 }],
      [catalisador, baseTinta],
    );
    expect(plano.diretos).toEqual([{ product: catalisador, quantidade: 3 }]);
    expect(plano.tintas).toEqual([]);
    expect(plano.foraDoCatalogo).toEqual([]);
  });

  it('item com cor numa base tintométrica → fila de tinta (com nome da cor e quantidade)', () => {
    const plano = montarPlanoReplicacao(
      [{ descricao: 'BASE BRILH...', quantidade: 2, valor_unitario: 100, omie_codigo_produto: 222, tint_nome_cor: 'OVO H101 - BS' }],
      [catalisador, baseTinta],
    );
    expect(plano.tintas).toEqual([{ product: baseTinta, nomeCor: 'OVO H101 - BS', quantidade: 2 }]);
    expect(plano.diretos).toEqual([]);
  });

  it('item com cor cujo produto NÃO é mais base tintométrica → direto (sem fluxo de cor)', () => {
    const exBase = produto({ id: 'ex', omie_codigo_produto: 333, is_tintometric: false });
    const plano = montarPlanoReplicacao(
      [{ descricao: 'X', quantidade: 1, valor_unitario: 10, omie_codigo_produto: 333, tint_nome_cor: 'AZUL' }],
      [exBase],
    );
    expect(plano.diretos).toEqual([{ product: exBase, quantidade: 1 }]);
    expect(plano.tintas).toEqual([]);
  });

  it('base tintométrica SEM cor no item antigo → fila de tinta sem cor pré-buscada (dialog decide)', () => {
    const plano = montarPlanoReplicacao(
      [{ descricao: 'BASE...', quantidade: 1, valor_unitario: 100, omie_codigo_produto: 222 }],
      [baseTinta],
    );
    expect(plano.tintas).toEqual([{ product: baseTinta, nomeCor: null, quantidade: 1 }]);
  });

  it('item fora do catálogo → foraDoCatalogo com a descrição', () => {
    const plano = montarPlanoReplicacao(
      [{ descricao: 'PRODUTO EXTINTO', quantidade: 1, valor_unitario: 10, omie_codigo_produto: 999 }],
      [catalisador],
    );
    expect(plano.foraDoCatalogo).toEqual(['PRODUTO EXTINTO']);
  });

  it('quantidade inválida/ausente vira 1', () => {
    const plano = montarPlanoReplicacao(
      [
        { descricao: 'A', valor_unitario: 10, omie_codigo_produto: 111 },
        { descricao: 'B', quantidade: 0, valor_unitario: 10, omie_codigo_produto: 111 },
        { descricao: 'C', quantidade: -2 as number, valor_unitario: 10, omie_codigo_produto: 111 },
      ],
      [catalisador],
    );
    expect(plano.diretos.map((d) => d.quantidade)).toEqual([1, 1, 1]);
  });

  it('items malformado (null/não-array/itens lixo) não quebra', () => {
    expect(montarPlanoReplicacao(null, [catalisador])).toEqual({ diretos: [], tintas: [], foraDoCatalogo: [] });
    expect(montarPlanoReplicacao('lixo', [catalisador])).toEqual({ diretos: [], tintas: [], foraDoCatalogo: [] });
    const plano = montarPlanoReplicacao([null, 42, { sem_codigo: true }], [catalisador]);
    expect(plano.diretos).toEqual([]);
    expect(plano.foraDoCatalogo).toEqual(['Item sem descrição']);
  });

  it('mantém a ordem dos itens do pedido original dentro de cada grupo', () => {
    const outro = produto({ id: 'outro', omie_codigo_produto: 444, descricao: 'THINNER' });
    const plano = montarPlanoReplicacao(
      [
        { descricao: 'THINNER', quantidade: 1, valor_unitario: 10, omie_codigo_produto: 444 },
        { descricao: 'CATALISADOR FC', quantidade: 2, valor_unitario: 50, omie_codigo_produto: 111 },
      ],
      [catalisador, outro],
    );
    expect(plano.diretos.map((d) => d.product.id)).toEqual(['outro', 'cat']);
  });
});
