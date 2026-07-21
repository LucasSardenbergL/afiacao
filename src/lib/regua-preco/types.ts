export type Confianca = 'alta' | 'media' | 'baixa' | 'oculto';
export type TipoSinal = 'piso' | 'auto_ref' | 'benchmark' | 'nenhum';

/**
 * Veredito do piso, decidido no SERVIDOR (`get_regua_preco`). FU4-F fase 2.
 *
 * O cliente NÃO calcula mais o piso: sem isto, quem consegue avaliar `preço < piso` offline acha
 * o piso por busca binária, e mascarar o número seria teatro. `piso`/`gapPct` só vêm preenchidos
 * para quem tem `private.cap_custo_ler` — para a vendedora eles chegam `null` e o sinal continua.
 */
export interface PisoVeredito {
  abaixoPiso: boolean; // A DECISÃO — vale para todo mundo, com ou sem o número
  disponivel: boolean; // o servidor conseguiu calcular o piso (distingue "acima" de "sem custo")
  piso: number | null; // null = mascarado (sem capability) OU indisponível — ver `disponivel`
  gapPct: number | null; // piso/preço−1; mesmo gate (é invertível para o piso)
  cmcConfiavel: boolean; // false = custo estimado → aviso sem botão
  prazoAplicado: boolean; // o piso já inclui o custo do prazo (F2), calculado no servidor
}

export interface ReguaPrecoInput {
  precoAtual: number; // unit_price líquido no carrinho
  piso: PisoVeredito; // veio pronto do servidor — substituiu cmc + aliquotaVenda + custoCapitalAnual
  precosCliente: number[]; // preços recentes (180d) que ESTE cliente pagou neste SKU
  comparaveis: { preco: number; clienteId: string }[]; // vendas comparáveis (EXCLUI cliente atual)
  caps: { alta: number; media: number }; // cap de aumento por confiança, ex {alta:0.10, media:0.05}
  prazoDias?: number[] | null; // só para a CÓPIA do recibo ("0/30/60 dias"); prazo não é custo
}

export interface ReguaPrecoResult {
  sinal: TipoSinal;
  confianca: Confianca; // qualidade da EVIDÊNCIA (nunca "chance de aceite")
  precoReferencia: number | null; // alvo sugerido capado; null se sem ação (baixa/oculto/proxy)
  observedGapPct: number | null; // teto/atual - 1 — oportunidade OBSERVADA (não capada) — p/ log
  suggestedGapPct: number | null; // alvo capado/atual - 1 — o que a UI sugere
  pisoMC: number | null;
  abaixoPiso: boolean;
  capLimitou: boolean; // o cap reduziu a sugestão abaixo do teto
  discordancia: boolean; // auto_ref e benchmark apontam direções opostas
  recibos: string[];
  disclaimers: string[]; // SEMPRE inclui os 2 fixos
  reasonCodes: string[]; // 'cmc_proxy','sinais_discordantes','preco_acima_referencias',...
}

export const DISCLAIMERS_FIXOS = [
  'Não estimamos aceite do cliente.',
  'Frete não considerado.', // F2: frete SEMPRE fora do piso. O prazo é tratado à parte (condicional):
  // recibo "Piso inclui o custo do prazo…" quando aplicado, ou "Prazo de recebimento não considerado." ao degradar.
];
