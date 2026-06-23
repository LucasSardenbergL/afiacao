// Recomposição do custo de produto FABRICADO a partir da Estrutura (malha) do Omie.
//
// O Omie NÃO entrega um custo de produção pronto: `geral/malha/ConsultarEstrutura` devolve os
// COMPONENTES (idProdMalha + quantProdMalha + percPerdaProdMalha) + `custoProducao { vMOD, vGGF }`
// SEPARADOS. Esta função recompõe: Σ(quantidade × (1 + perda%) × cmc_do_insumo) + vMOD + vGGF.
//
// Money-path (degradação honesta — ausente ≠ zero, NUNCA fabricar custo):
//   - 1 único insumo sem cmc conhecido → custo NULL (não soma parcial) + status missing_component_cost.
//   - estrutura vazia (sem componente e sem MOD/GGF) → custo NULL + empty_structure.
//   - sanity de UNIDADE: custo absurdo vs preço de venda → custo NULL + suspeito_unidade. A 1ª
//     execução real vira a validação empírica: se a quantidade/unidade da estrutura não casa com a
//     unidade do cmc do insumo, o custo explode/some e a defesa pega — em vez de poluir a Caça.
//
// Só `recomporCustoProducao` é exportado (a edge importa a função; os tipos são internos). ESPELHADO
// VERBATIM em supabase/functions/_shared/recompor-custo-producao.ts (Deno não importa de src/); a
// paridade é provada por recomporCustoProducao.parity.test.ts.

interface ComponenteEstrutura {
  /** nCodProduto do Omie (= omie_products.omie_codigo_produto). */
  codigo: number;
  /** Quantidade do componente por unidade do produto fabricado (unidade de estoque do Omie). */
  quantidade: number;
  /** Percentual de perda do componente (percPerdaProdMalha do Omie). Consumo real =
   *  quantidade × (1 + percPerda/100). Default 0 (sem perda declarada). */
  percPerda?: number;
}

type CustoProducaoStatus =
  | 'ok'
  | 'empty_structure'
  | 'missing_component_cost'
  | 'suspeito_unidade';

interface SanityLimites {
  /** Custo acima de precoVenda × fatorMax → suspeito (default 3). */
  fatorMax: number;
  /** Custo abaixo de precoVenda × fatorMin → suspeito (default 0.02). */
  fatorMin: number;
}

/** Defaults heurísticos do sanity de unidade. Custo > 3× preço ou < 2% do preço ⇒ provável erro
 *  de unidade (não prejuízo real, que vive na banda intermediária). Configurável por chamada. */
const LIMITES_SANITY: SanityLimites = { fatorMax: 3, fatorMin: 0.02 };

interface RecomporInput {
  componentes: ComponenteEstrutura[];
  vMOD: number;
  vGGF: number;
  /** cmc do insumo por nCodProduto; null/undefined/<=0 = sem custo conhecido. */
  cmcPorCodigo: Map<number, number | null | undefined>;
  /** valor_unitario (preço de venda) do fabricado, p/ o sanity de unidade (opcional). */
  precoVenda?: number | null;
  limites?: SanityLimites;
}

interface RecomporResult {
  custo: number | null;
  status: CustoProducaoStatus;
  /** nCodProduto dos componentes sem cmc conhecido (diagnóstico/log). */
  faltantes: number[];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function recomporCustoProducao(input: RecomporInput): RecomporResult {
  const componentes = input.componentes ?? [];
  const mod = num(input.vMOD);
  const ggf = num(input.vGGF);
  const lim = input.limites ?? LIMITES_SANITY;

  if (componentes.length === 0 && mod === 0 && ggf === 0) {
    return { custo: null, status: 'empty_structure', faltantes: [] };
  }

  let materiaPrima = 0;
  const faltantes: number[] = [];
  for (const c of componentes) {
    const cmc = input.cmcPorCodigo.get(c.codigo);
    // ausente ≠ zero: cmc null/0 = custo do insumo DESCONHECIDO → não dá pra somar o total.
    if (cmc == null || !(cmc > 0)) {
      faltantes.push(c.codigo);
      continue;
    }
    const q = num(c.quantidade);
    // perda da malha (percPerdaProdMalha): consumo real = quantidade × (1 + perda%).
    const qEfetiva = q * (1 + num(c.percPerda) / 100);
    if (qEfetiva > 0) materiaPrima += qEfetiva * cmc;
  }

  // 1 insumo sem custo conhecido invalida o total inteiro (nunca custo parcial/fabricado).
  if (faltantes.length > 0) {
    return { custo: null, status: 'missing_component_cost', faltantes };
  }

  const custo = materiaPrima + mod + ggf;
  if (!(custo > 0)) {
    return { custo: null, status: 'empty_structure', faltantes: [] };
  }

  // sanity de unidade: custo absurdo vs preço → degrada (provável quantidade/unidade errada).
  // A banda intermediária (inclui margem negativa REAL) passa de propósito — prejuízo é dado, não erro.
  const preco = input.precoVenda;
  if (preco != null && preco > 0 && (custo > preco * lim.fatorMax || custo < preco * lim.fatorMin)) {
    return { custo: null, status: 'suspeito_unidade', faltantes: [] };
  }

  return { custo: Math.round(custo * 100) / 100, status: 'ok', faltantes: [] };
}
