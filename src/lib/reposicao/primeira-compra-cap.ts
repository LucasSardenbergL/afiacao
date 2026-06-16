// Cap da PRIMEIRA COMPRA (cold-start, reposição). Compra-teste conservadora: não infla segurança,
// capa a cobertura por classe ABC. É o ORÁCULO testável da fórmula espelhada VERBATIM no SQL da
// v_sku_parametros_sugeridos (trilha CANDIDATO_PRIMEIRA_COMPRA). A UI usa pra exibir/explicar a
// quantidade-teste; a RPC promover_candidato_primeira_compra aplica os valores em sku_parametros.
//
// Revisado adversarialmente com codex (2 consults). Decisões travadas:
//   • cap_dias por classe: A=30 / B=21 / C=14 (conservador).
//   • ponto E lote são AMBOS capados pela cobertura (ceil(d × cap_dias)) — capar só o lote deixava o
//     ponto estourar em LT longo (buraco financeiro apontado pelo codex).
//   • estoque_maximo = ponto + lote. O motor (gerar_pedidos_sugeridos_ciclo) compra
//     `estoque_maximo − estoque_efetivo`: disparando no ponto compra ~lote; em estoque 0 compra ponto+lote.
//   • sem z-score / sem estoque de segurança (compra-teste, não reposição plena).
//   • pisos de 1 em tudo; estoque_maximo sempre > ponto (senão o motor não tem o que comprar).

export function capDiasPorClasse(classeAbc: string | null | undefined): number {
  switch (classeAbc) {
    case "A":
      return 30;
    case "B":
      return 21;
    default:
      return 14; // C, Z, null
  }
}

export interface ParametrosPrimeiraCompraInput {
  qcEoq: number; // qtde_compra_ciclo (EOQ) calculada pela view
  demandaDiaria: number; // demanda_media_diaria
  leadTime: number; // lt (dias úteis)
  classe: string | null | undefined; // classe_abc_proposta
}

export interface ParametrosPrimeiraCompra {
  lote: number; // quanto recompor por ciclo (capado pela cobertura)
  pontoPedido: number; // dispara a compra (demanda no LT, capada pela cobertura)
  estoqueMaximo: number; // teto que o motor recompõe (= ponto + lote; sempre > ponto)
  capDias: number;
}

export function calcularParametrosPrimeiraCompra(
  i: ParametrosPrimeiraCompraInput,
): ParametrosPrimeiraCompra {
  const capDias = capDiasPorClasse(i.classe);
  const d = Number.isFinite(i.demandaDiaria) && i.demandaDiaria > 0 ? i.demandaDiaria : 0;
  const lt = Number.isFinite(i.leadTime) && i.leadTime > 0 ? i.leadTime : 0;
  const eoq = Number.isFinite(i.qcEoq) && i.qcEoq > 0 ? i.qcEoq : 1;

  const capCobertura = Math.ceil(d * capDias);
  const demandaNoLt = Math.ceil(d * lt);

  const pontoPedido = Math.max(1, Math.min(demandaNoLt, capCobertura));
  const lote = Math.max(1, Math.min(Math.max(eoq, 1), capCobertura));
  const estoqueMaximo = pontoPedido + lote;

  return { lote, pontoPedido, estoqueMaximo, capDias };
}
