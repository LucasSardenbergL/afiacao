import { describe, it, expect } from 'vitest';
import {
  indexarCatalogoAtivo,
  resolverItemNoCatalogo,
  type ProdutoCatalogoAtivo,
} from '../identidade-item';

/**
 * A identidade do item é o PAR (conta, código) — não o código sozinho.
 *
 * O banco declara isso: `omie_products` tem `UNIQUE (omie_codigo_produto, account)`. O motor
 * assumia unicidade GLOBAL do código e montava um `Map<number, string>` sobre as duas contas;
 * onde o schema permite duas linhas, o Map guarda uma — e a que sobrevive é a última que a
 * paginação escreveu. Estes casos são o estado que o schema autoriza e o dado de hoje ainda
 * não tem (medição de 20/08/2026: 0 colisões em 7.984 códigos). O teste existe para o dia em
 * que tiver: é a única forma de provar o guard, já que em produção ele é inerte por enquanto.
 */

const COD = 987654321;
const SKU_OBEN = 'sku-oben';
const SKU_COLACOR = 'sku-colacor';

/** O MESMO código Omie vivo nas duas contas — legal pelo UNIQUE, fatal para um Map global. */
const catalogoComColisao: ProdutoCatalogoAtivo[] = [
  { id: SKU_COLACOR, account: 'colacor', omie_codigo_produto: COD },
  { id: SKU_OBEN, account: 'oben', omie_codigo_produto: COD },
];

describe('identidade-item — colisão de código entre contas', () => {
  it('resolve o código na conta DO PEDIDO, não no último que a paginação escreveu', () => {
    const indice = indexarCatalogoAtivo(catalogoComColisao);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'oben', indice)).toEqual({
      ok: true,
      productId: SKU_OBEN,
    });
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'colacor', indice)).toEqual({
      ok: true,
      productId: SKU_COLACOR,
    });
  });

  it('a ORDEM do catálogo não muda o resultado — "last write wins" deixou de existir', () => {
    // Com o Map global, inverter a ordem invertia a resposta: era a prova de que o vencedor
    // era arbitrário. Aqui as duas ordens têm de dar o MESMO product_id.
    const direto = indexarCatalogoAtivo(catalogoComColisao);
    const invertido = indexarCatalogoAtivo([...catalogoComColisao].reverse());
    const item = { omie_codigo_produto: COD };
    expect(resolverItemNoCatalogo(item, 'oben', direto)).toEqual(resolverItemNoCatalogo(item, 'oben', invertido));
    expect(resolverItemNoCatalogo(item, 'oben', invertido)).toEqual({ ok: true, productId: SKU_OBEN });
  });

  it('código que só existe em OUTRA conta sai como `conta_divergente`, não como ausente', () => {
    // A discriminação é o sensor: `fora_do_catalogo_ativo` é o regime normal (39,9% dos itens
    // em prod são SKU inativo da própria conta). Somar os dois num contador só esconderia a
    // divergência dentro de um número que já é farto.
    const indice = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'oben', omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'colacor', indice)).toEqual({
      ok: false,
      motivo: 'conta_divergente',
    });
  });

  it('código que não existe em conta nenhuma sai como `fora_do_catalogo_ativo`', () => {
    const indice = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'oben', omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: 111 }, 'oben', indice)).toEqual({
      ok: false,
      motivo: 'fora_do_catalogo_ativo',
    });
  });
});

describe('identidade-item — `product_id` direto', () => {
  const indice = indexarCatalogoAtivo(catalogoComColisao);

  it('ativo e da MESMA conta entra', () => {
    expect(resolverItemNoCatalogo({ product_id: SKU_OBEN }, 'oben', indice)).toEqual({
      ok: true,
      productId: SKU_OBEN,
    });
  });

  it('ativo mas de OUTRA conta sai — presença no catálogo não basta', () => {
    // `productMap.has(product_id)` teria aceitado: o SKU existe e está ativo. O que não bate
    // é o dono. Este é o caso que separa "confrontar catálogo" de "confrontar identidade".
    expect(resolverItemNoCatalogo({ product_id: SKU_COLACOR }, 'oben', indice)).toEqual({
      ok: false,
      motivo: 'conta_divergente',
    });
  });

  it('fora do catálogo ativo sai — a garantia do writer é do INSTANTE da gravação', () => {
    // O writer (`useSalesOrderEdit`) grava `product_id` do catálogo `.eq('account').eq('ativo')`.
    // Nada impede o SKU de ser desativado DEPOIS: o item fica no histórico apontando para um
    // SKU que o motor não deve mais ofertar. O índice só conhece ativos — ausência já é veto.
    const soAtivos = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'oben', omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ product_id: 'sku-desativado-ontem' }, 'oben', soAtivos)).toEqual({
      ok: false,
      motivo: 'fora_do_catalogo_ativo',
    });
  });

  it('`product_id` inválido com código VÁLIDO não cai no fallback — ambiguidade descarta', () => {
    // Precisão > recall: dois identificadores discordando não autorizam escolher o que
    // funciona. O código resolveria para SKU_OBEN; o item sai assim mesmo.
    expect(
      resolverItemNoCatalogo({ product_id: 'sku-que-nao-existe', omie_codigo_produto: COD }, 'oben', indice),
    ).toEqual({ ok: false, motivo: 'fora_do_catalogo_ativo' });
  });
});

describe('identidade-item — ausência de conta e códigos degenerados', () => {
  it('ausência de conta casa só com ausência — não é coringa dos dois lados', () => {
    const semConta = indexarCatalogoAtivo([{ id: SKU_OBEN, omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, null, semConta)).toEqual({
      ok: true,
      productId: SKU_OBEN,
    });
    // Pedido COM conta contra catálogo SEM conta: divergente. É o modo de falha que aparece se
    // alguém tirar `account` do `select` de `omie_products` — e é melhor que ele grite aqui.
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'oben', semConta)).toEqual({
      ok: false,
      motivo: 'conta_divergente',
    });
    // E o simétrico: catálogo COM conta, pedido sem.
    const comConta = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'oben', omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, undefined, comConta)).toEqual({
      ok: false,
      motivo: 'conta_divergente',
    });
  });

  it('a caixa de `account` NÃO é normalizada — o UNIQUE do banco é case-sensitive', () => {
    // Baixar `OBEN` para `oben` aqui fundiria no leitor dois estados que o banco distingue.
    const indice = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'OBEN', omie_codigo_produto: COD }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'oben', indice)).toEqual({
      ok: false,
      motivo: 'conta_divergente',
    });
  });

  it('item sem identificador nenhum sai como `sem_identificador`', () => {
    const indice = indexarCatalogoAtivo(catalogoComColisao);
    expect(resolverItemNoCatalogo({}, 'oben', indice)).toEqual({ ok: false, motivo: 'sem_identificador' });
  });

  it('código `0`/`null`/`""` é ausência, não código — `Number(null) === 0` não vira SKU', () => {
    // A armadilha canônica do money-path: `Number(null)` é 0, e 0 casaria com um produto cujo
    // código também degradou para 0. O índice recusa os dois lados.
    const indice = indexarCatalogoAtivo([
      { id: 'sku-sem-codigo', account: 'oben', omie_codigo_produto: null },
      { id: 'sku-codigo-vazio', account: 'oben', omie_codigo_produto: '' },
    ]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: 0 }, 'oben', indice)).toEqual({
      ok: false,
      motivo: 'sem_identificador',
    });
    expect(resolverItemNoCatalogo({ omie_codigo_produto: '' }, 'oben', indice)).toEqual({
      ok: false,
      motivo: 'sem_identificador',
    });
  });

  it('código em STRING resolve igual ao numérico — o jsonb do Omie mistura os dois', () => {
    const indice = indexarCatalogoAtivo([{ id: SKU_OBEN, account: 'oben', omie_codigo_produto: String(COD) }]);
    expect(resolverItemNoCatalogo({ omie_codigo_produto: COD }, 'oben', indice)).toEqual({
      ok: true,
      productId: SKU_OBEN,
    });
  });
});
