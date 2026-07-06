export type Confianca = 'alta' | 'media' | 'baixa' | 'oculto';
export type TipoSinal = 'piso' | 'auto_ref' | 'benchmark' | 'nenhum';

export interface ReguaPrecoInput {
  precoAtual: number; // unit_price líquido no carrinho
  cmc: number | null; // custo médio contábil; null se sem cobertura
  cmcConfiavel: boolean; // false = proxy → aviso sem botão
  aliquotaVenda: number; // (icms+pis+cofins)/receita, 0..1
  precosCliente: number[]; // preços recentes (180d) que ESTE cliente pagou neste SKU
  comparaveis: { preco: number; clienteId: string }[]; // vendas comparáveis (EXCLUI cliente atual)
  caps: { alta: number; media: number }; // cap de aumento por confiança, ex {alta:0.10, media:0.05}
  // F2 — custo do prazo (opcionais; ausentes = comportamento à vista, 100% retrocompatível):
  prazoDias?: number[] | null; // dias de vencimento de cada parcela, parseado da condição selecionada
  custoCapitalAnual?: number | null; // taxa de custo de capital do prazo (fração a.a.), ausente → degrada
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
