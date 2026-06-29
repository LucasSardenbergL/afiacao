// Oráculo puro da defasagem de repasse POR CLIENTE (Fase 2b). A RPC
// get_defasagem_cliente (SQL numeric) é a AUTORIDADE em runtime — a UI lê o status
// da RPC, não deste helper. Este helper documenta a regra e é o oráculo do teste;
// por ser float (JS), pode divergir da RPC (numeric exato) em fronteiras decimais —
// NÃO usar pra decisão em runtime. A lógica SQL da RPC deve bater 1:1 com isto.
//
// Doutrina (money-path): PRECISÃO > recall. Alerta errado na frente do cliente é
// PIOR que silêncio. "Ausente ≠ zero": nunca fabricar número. Na dúvida → neutro.

export type StatusDefasagem =
  | 'defasado'
  | 'em_dia'
  | 'sem_historico'
  | 'sem_alta'
  | 'revisar'
  | 'sem_custo_atual_fresco'
  | 'sem_data_confiavel'
  | 'neutro';

export interface DefasagemInput {
  pNow: number;                  // preço que a vendedora vai praticar (carrinho)
  pLast: number | null;          // preço líquido da última compra deste cliente (âncora)
  cLast: number | null;          // CMC as-of a data da âncora (cmc_snapshot)
  cNow: number | null;           // CMC atual (inventory_position freshest)
  temAncora: boolean;            // existe order_items real do (cliente, produto)
  descontoNaoProvado: boolean;   // discount>0 em order_items OU sales_orders
  cNowFresco: boolean;           // inventory_position.synced_at dentro da janela (G6)
  dataConfiavel: boolean;        // dInc/proveniência boa da data da âncora (G7)
  ancoraMeses: number | null;    // idade da âncora em meses
  qtyRatioOk: boolean;           // quantity âncora vs carrinho na mesma ordem de grandeza (G5)
}

export interface DefasagemResult {
  status: StatusDefasagem;
  pReq: number | null;           // preço de equilíbrio do repasse = pLast*(cNow/cLast), arred2
  altaCustoPerc: number | null;  // (cNow/cLast - 1) * 100
  motivo: string;                // motivo honesto
}

export const DEFASAGEM_CONST = {
  TOL_PP: 3,            // tolerância em pontos percentuais (Codex #5)
  PISO_ALTA_PERC: 2,    // alta de custo mínima p/ sair do ruído de CMC
  PISO_ACAO_PERC: 2,    // piso de ação em % de pNow
  PISO_ACAO_REAIS: 1,   // piso de ação em R$ absolutos
  ANCORA_MESES_MAX: 18, // âncora mais velha que isso → neutro
  QUARENTENA_PERC: 50,  // alta de custo > isso → revisar (provável erro de cadastro/unidade)
} as const;

/** Arredonda a 2 casas (centavo). */
function arred2(n: number): number {
  return Math.round(n * 100) / 100;
}

function finitoPositivo(n: number | null): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

export function avaliarDefasagem(i: DefasagemInput): DefasagemResult {
  const neutro = (motivo: string): DefasagemResult =>
    ({ status: 'neutro', pReq: null, altaCustoPerc: null, motivo });

  // Ordem dos guards = fiel à spec §5.2-5.4. Degradação honesta antes de qualquer cálculo.
  if (!i.temAncora) {
    return { status: 'sem_historico', pReq: null, altaCustoPerc: null, motivo: 'sem_historico' };
  }
  if (i.descontoNaoProvado) {
    return neutro('desconto_nao_provado');
  }
  if (!i.dataConfiavel) {
    return { status: 'sem_data_confiavel', pReq: null, altaCustoPerc: null, motivo: 'sem_data_confiavel' };
  }
  if (!i.cNowFresco) {
    return { status: 'sem_custo_atual_fresco', pReq: null, altaCustoPerc: null, motivo: 'sem_custo_atual_fresco' };
  }
  // pLast/cLast/cNow têm que ser finitos e > 0 (NaN/≤0 → neutro; "ausente ≠ zero").
  if (!finitoPositivo(i.pLast) || !finitoPositivo(i.cLast) || !finitoPositivo(i.cNow)) {
    return neutro('sem_base');
  }
  const pLast = i.pLast;
  const cLast = i.cLast;
  const cNow = i.cNow;

  if (!i.qtyRatioOk) {
    return { status: 'revisar', pReq: null, altaCustoPerc: null, motivo: 'qty_divergente' };
  }
  if (i.ancoraMeses != null && i.ancoraMeses > DEFASAGEM_CONST.ANCORA_MESES_MAX) {
    return neutro('ancora_antiga');
  }

  const razaoCusto = cNow / cLast;

  // G4 quarentena: alta absurda (> +50%) → revisar, NÃO alerta de repasse.
  if (razaoCusto - 1 > DEFASAGEM_CONST.QUARENTENA_PERC / 100) {
    return { status: 'revisar', pReq: null, altaCustoPerc: null, motivo: 'quarentena_custo' };
  }

  // G1: vendeu no/abaixo do custo → não herda markup de prejuízo.
  if (pLast <= cLast) {
    return neutro('prejuizo_ancora');
  }

  // Só avalia se o custo SUBIU.
  if (cNow <= cLast) {
    return { status: 'sem_alta', pReq: null, altaCustoPerc: null, motivo: 'custo_nao_subiu' };
  }

  const alta = razaoCusto - 1; // fração
  // Piso de alta: abaixo de 2% é ruído de CMC → sem_alta.
  if (alta < DEFASAGEM_CONST.PISO_ALTA_PERC / 100) {
    return { status: 'sem_alta', pReq: null, altaCustoPerc: null, motivo: 'alta_ruido' };
  }

  const pReq = arred2(pLast * razaoCusto);
  const altaCustoPerc = alta * 100;

  // defasado SE (pNow/pLast - 1) < alta - TOL_PP/100.
  const subiuPreco = pNowFrac(i.pNow, pLast);
  const defasadoPorRazao = subiuPreco < alta - DEFASAGEM_CONST.TOL_PP / 100;

  if (!defasadoPorRazao) {
    return { status: 'em_dia', pReq, altaCustoPerc, motivo: 'preco_acompanhou' };
  }

  // Piso de ação (anti-arredondamento): só defasado se o gap em REAIS (arredondado a
  // centavo) ≥ max(2% de pNow, R$1,00). Centavo nunca dispara.
  const gapReais = arred2(pReq) - arred2(i.pNow);
  const pisoAcao = Math.max((DEFASAGEM_CONST.PISO_ACAO_PERC / 100) * i.pNow, DEFASAGEM_CONST.PISO_ACAO_REAIS);
  if (gapReais < pisoAcao) {
    return { status: 'em_dia', pReq, altaCustoPerc, motivo: 'gap_abaixo_do_piso' };
  }

  return { status: 'defasado', pReq, altaCustoPerc, motivo: 'custo_subiu_preco_nao_acompanhou' };
}

/** Fração de variação do preço praticado vs o da âncora. pNow pode ser ≤0/NaN → trata como 0 (não subiu). */
function pNowFrac(pNow: number, pLast: number): number {
  if (!Number.isFinite(pNow) || pNow <= 0) return -1; // preço inválido/zerado = "não subiu" (favorece detectar defasagem? não — segue a regra: subiu pouco)
  return pNow / pLast - 1;
}
