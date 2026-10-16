import { addDias, type DataISO } from './datas';

/** Uma linha de pedido_compra_item como o motor a deixou no ciclo (spec §5.1). */
export interface LinhaMotor {
  pedidoId: number;
  /** split_parent_id ?? id — pai e filhos de split avaliados juntos (spec §5.4). */
  pedidoRaizId: number;
  sku: string;
  qtdeFinal: number;
  /** fator_embalagem_portal: embalagens por unidade; passo = 1/fator. */
  fatorEmbalagem: number | null;
  precoUnitario: number | null;
  precoVendaMedio: number | null;
  /** estoque_atual da linha = físico + a caminho − comprometido (pode ser negativo). */
  estoqueEfetivo: number;
  pontoPedido: number;
  /** preco_sem_desconto quando a linha está em promoção; senão null. */
  precoCheioPromocao: number | null;
}

export interface Embalagem {
  pedidoRaizId: number;
  sku: string;
  /** 1-based; k só pode ser aceita se k−1 foi (prefixo). */
  k: number;
  qtde: number;
  /** qtde × preço × (1 + frete); null se preço ausente. */
  desembolso: number | null;
  dataPagamento: DataISO;
}

export interface Lags {
  faturamentoP10: number;
  vencimentoP10: number;
}

export function passoDaLinha(l: LinhaMotor): number {
  return l.fatorEmbalagem && l.fatorEmbalagem > 0 ? 1 / l.fatorEmbalagem : 1;
}

/** Pagamento mais cedo plausível (risco de caixa): pedido + p10 faturamento + p10 vencimento. */
export function dataPagamentoPrevista(dataPedido: DataISO, lags: Lags): DataISO {
  return addDias(dataPedido, lags.faturamentoP10 + lags.vencimentoP10);
}

export function quebrarEmEmbalagens(
  l: LinhaMotor,
  p: { fretePerc: number; dataPagamento: DataISO },
): Embalagem[] {
  if (!(l.qtdeFinal > 0)) return [];
  const passo = passoDaLinha(l);
  const n = Math.ceil(l.qtdeFinal / passo - 1e-9);
  const out: Embalagem[] = [];
  for (let k = 1; k <= n; k++) {
    const qtde = k < n ? passo : l.qtdeFinal - (n - 1) * passo;
    out.push({
      pedidoRaizId: l.pedidoRaizId,
      sku: l.sku,
      k,
      qtde,
      desembolso: l.precoUnitario == null ? null : qtde * l.precoUnitario * (1 + p.fretePerc),
      dataPagamento: p.dataPagamento,
    });
  }
  return out;
}
