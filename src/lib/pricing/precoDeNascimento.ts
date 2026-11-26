/**
 * Preço de NASCIMENTO de um produto no pedido — a decisão que o Novo Pedido (`useUnifiedOrder`
 * `getProductPrice`) e a edição de pedido (`useSalesOrderEdit` `addProduct`) tomam com os MESMOS
 * insumos. Antes a edição nascia o item novo pela tabela pura, enquanto o pedido novo usava o último
 * praticado do cliente na janela, depois tabela × multiplicador do tier (revisão 2026-11-25, P0-7).
 * A regra em si é `precoPartida`; isto só escolhe os insumos da CONTA do produto.
 */
import { precoPartida, type Tier } from './precoPartida';

type ContaPreco = 'oben' | 'colacor';

export interface InsumosDoNascimento {
  /** Último preço praticado por `omie_codigo_produto`, separado por conta (códigos colidem entre contas). */
  precos: Record<ContaPreco, Record<number, number>>;
  datas: Record<ContaPreco, Record<number, string>>;
  tierPorConta: Record<ContaPreco, Tier | null> | null | undefined;
  multConfig: Record<ContaPreco, Partial<Record<Tier, number>>> | null | undefined;
}

export function precoDeNascimento(
  product: { account?: string | null; omie_codigo_produto: number; valor_unitario: number | null | undefined },
  insumos: InsumosDoNascimento,
  hoje: Date,
): number | null {
  const conta: ContaPreco = product.account === 'colacor' ? 'colacor' : 'oben';
  const praticado = insumos.precos[conta][product.omie_codigo_produto];
  const tier = insumos.tierPorConta?.[conta] ?? null;
  const mult = tier ? (insumos.multConfig?.[conta]?.[tier] ?? null) : null;
  const tabela = Number(product.valor_unitario);
  // Precedência de nascimento (spec §4): último praticado ≤180d > tabela×mult(tier) > tabela.
  const preco = precoPartida({
    tabela: product.valor_unitario != null && Number.isFinite(tabela) ? tabela : Number.NaN,
    ultimoPraticado: praticado && praticado > 0 ? praticado : null,
    ultimoPraticadoEm: insumos.datas[conta][product.omie_codigo_produto] ?? null,
    hoje,
    tier,
    mult,
  });
  // Sem praticado e sem tabela positiva não há preço: `null` (preço NÃO SABIDO — o guard do salvar
  // barra), nunca R$ 0,00 inventado. Ausente ≠ zero.
  return Number.isFinite(preco) && preco > 0 ? preco : null;
}
