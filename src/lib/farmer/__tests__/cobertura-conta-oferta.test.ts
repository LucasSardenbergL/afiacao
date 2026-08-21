import { describe, it, expect } from 'vitest';
import { acumularContaDeCompra, medirBundlesDeContaUnica, medirCoberturaContaDaOferta } from '../cobertura-conta-oferta';

/**
 * A unidade do sensor de conta da oferta. Os hooks provam a INTEGRAÇÃO (que o número chega ao
 * head); aqui ficam os estados de borda que a fixture de um motor inteiro não alcança sem
 * ginástica — sobretudo os dois "não sei", que precisam sair de `n` sem sair de `esperado`.
 */
const contas = (pares: Array<[string, string | null | undefined]>) => {
  const m = new Map<string, Set<string | null>>();
  for (const [cid, conta] of pares) acumularContaDeCompra(m, cid, conta);
  return m;
};

describe('medirCoberturaContaDaOferta', () => {
  it('conta como conforme a oferta cuja conta o cliente já compra', () => {
    const r = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-colacor' }],
      contas([['c1', 'colacor']]),
      new Map([['p-colacor', 'colacor']]),
    );
    expect(r).toEqual({ n: 1, esperado: 1 });
  });

  it('a oferta de conta ALHEIA sai de `n` e permanece em `esperado`', () => {
    const r = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-oben' }],
      contas([['c1', 'colacor']]),
      new Map([['p-oben', 'oben']]),
    );
    expect(r).toEqual({ n: 0, esperado: 1 });
  });

  it('cliente das DUAS empresas: qualquer uma das duas é conforme', () => {
    // O caso NORMAL — 47,4% dos clientes com recomendação viva. Se isto contasse como
    // divergência, o sensor acusaria o negócio de defeito.
    const r = medirCoberturaContaDaOferta(
      [
        { customerId: 'c1', productId: 'p-colacor' },
        { customerId: 'c1', productId: 'p-oben' },
      ],
      contas([['c1', 'colacor'], ['c1', 'oben']]),
      new Map([['p-colacor', 'colacor'], ['p-oben', 'oben']]),
    );
    expect(r).toEqual({ n: 2, esperado: 2 });
  });

  it('SKU sem conta conhecida é NÃO-conforme, não conforme por omissão', () => {
    // Fail-closed: se o catálogo chegar sem `account` (um `select` que perdeu a coluna),
    // o sensor tem de escurecer — não declarar 100%.
    const r = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-fantasma' }],
      contas([['c1', 'colacor']]),
      new Map([['p-outro', 'colacor']]),
    );
    expect(r).toEqual({ n: 0, esperado: 1 });
  });

  it('cliente sem nenhuma conta de compra conhecida é NÃO-conforme', () => {
    const r = medirCoberturaContaDaOferta(
      [{ customerId: 'c-sem-historico', productId: 'p-colacor' }],
      contas([['c1', 'colacor']]),
      new Map([['p-colacor', 'colacor']]),
    );
    expect(r).toEqual({ n: 0, esperado: 1 });
  });

  it('`account` ausente NÃO casa com `account` ausente — dois "não sei" não fazem um sim', () => {
    // Achado do challenge Codex xhigh. `undefined` e `null` colapsam em `null` (a regra do
    // `identidade-item.ts`), mas colapsar os ESTADOS não autoriza tratá-los como
    // correspondência: `null` é "não sei de que empresa é", e casar dois desconhecidos
    // fabrica conformidade — a mesma falha que `Number(null) === 0` comete com dinheiro.
    const semConta = contas([['c1', null], ['c2', undefined]]);
    expect(semConta.get('c1')).toEqual(semConta.get('c2'));

    const ambosSemConta = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-sem-conta' }],
      semConta,
      new Map([['p-sem-conta', null]]),
    );
    expect(ambosSemConta).toEqual({ n: 0, esperado: 1 });

    const alheio = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-colacor' }],
      semConta,
      new Map([['p-colacor', 'colacor']]),
    );
    expect(alheio).toEqual({ n: 0, esperado: 1 });
  });

  it('a conta NÃO é normalizada por caixa — `OBEN` e `oben` são estados distintos', () => {
    // Mesma decisão do `identidade-item.ts`: baixar a caixa aqui faria o leitor inventar uma
    // regra que o writer não garante (`account` é `text`, e o UNIQUE é case-sensitive).
    const r = medirCoberturaContaDaOferta(
      [{ customerId: 'c1', productId: 'p-oben' }],
      contas([['c1', 'OBEN']]),
      new Map([['p-oben', 'oben']]),
    );
    expect(r).toEqual({ n: 0, esperado: 1 });
  });

  it('sem oferta nenhuma, o sensor é 0/0 — e não 100% por vacuidade', () => {
    const r = medirCoberturaContaDaOferta([], contas([['c1', 'colacor']]), new Map());
    expect(r).toEqual({ n: 0, esperado: 0 });
  });

  it('`esperado` acompanha CADA oferta, inclusive o mesmo SKU repetido para clientes diferentes', () => {
    const r = medirCoberturaContaDaOferta(
      [
        { customerId: 'c1', productId: 'p-oben' },
        { customerId: 'c2', productId: 'p-oben' },
      ],
      contas([['c1', 'colacor'], ['c2', 'oben']]),
      new Map([['p-oben', 'oben']]),
    );
    expect(r).toEqual({ n: 1, esperado: 2 });
  });
});

describe('medirBundlesDeContaUnica', () => {
  const CONTAS = new Map<string, string | null>([
    ['p-colacor', 'colacor'],
    ['p-colacor-2', 'colacor'],
    ['p-oben', 'oben'],
    ['p-sem-conta', null],
  ]);

  it('bundle inteiro de uma conta só é conforme', () => {
    const r = medirBundlesDeContaUnica([{ products: [{ id: 'p-colacor' }, { id: 'p-colacor-2' }] }], CONTAS);
    expect(r).toEqual({ n: 1, esperado: 1 });
  });

  it('bundle MISTO é o defeito: "compre juntos" não atravessa dois CNPJs', () => {
    const r = medirBundlesDeContaUnica([{ products: [{ id: 'p-colacor' }, { id: 'p-oben' }] }], CONTAS);
    expect(r).toEqual({ n: 0, esperado: 1 });
  });

  it('bundle de UM SKU é conforme — não há mistura possível', () => {
    expect(medirBundlesDeContaUnica([{ products: [{ id: 'p-oben' }] }], CONTAS)).toEqual({ n: 1, esperado: 1 });
  });

  it('SKU sem conta conhecida NÃO atesta unicidade — fail-closed', () => {
    // Nem o `null` declarado nem o SKU ausente do índice podem produzir um "conforme": os dois
    // significam que ninguém conferiu de que empresa aquele item é.
    expect(medirBundlesDeContaUnica([{ products: [{ id: 'p-sem-conta' }] }], CONTAS)).toEqual({ n: 0, esperado: 1 });
    expect(medirBundlesDeContaUnica([{ products: [{ id: 'p-fantasma' }] }], CONTAS)).toEqual({ n: 0, esperado: 1 });
    expect(medirBundlesDeContaUnica([{ products: [{ id: 'p-oben' }, { id: 'p-fantasma' }] }], CONTAS)).toEqual({ n: 0, esperado: 1 });
  });

  it('bundle vazio não atesta nada', () => {
    expect(medirBundlesDeContaUnica([{ products: [] }], CONTAS)).toEqual({ n: 0, esperado: 1 });
  });

  it('sem bundle nenhum o sensor é 0/0, não 100% por vacuidade', () => {
    expect(medirBundlesDeContaUnica([], CONTAS)).toEqual({ n: 0, esperado: 0 });
  });
});
