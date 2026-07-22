// ════════════════════════════════════════════════════════════════════════════════════════════
// FU4-F fase 3 (PR-A) — projeção fail-closed da resposta da edge `recommend`
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// POR QUE ISTO É UMA FUNÇÃO PURA E SEPARADA: a suíte de edge roda com `--no-remote`, então um teste
// não pode importar `index.ts` (que faz `Deno.serve` no topo e puxa o SDK remoto). Lógica pura em
// `_shared/` + teste ao lado é o padrão do repo (paginate.ts, omie-paginacao.ts).
//
// O QUE ESTA CAMADA PROTEGE. Antes, a edge devolvia `_admin.cost_final` a TODO staff e o browser
// apagava o campo DEPOIS de receber (useRecommendationEngine.ts:69-75) — a resposta de rede já
// tinha entregue o custo. A decisão de quem vê número acontece aqui, no servidor.
//
// A SUPERFÍCIE DE INVERSÃO É MAIOR QUE `cost_final` — enumerada do código, não por analogia:
//   · margin                      → custo = price − margin
//   · eip = probability × margem  → e `probability` é devolvido ⇒ divisão dá a margem
//   · eiltv                       → idem, via kappa/recorrência
//   · cost_final, cost_ranking    → literais
//   · score_final + weights + sub-scores → score_final = wA·assocN + wP·eipN + wS·simN + wC·ctxN − pen;
//     com pesos e sub-scores conhecidos isola-se eipN, e minMaxNorm é invertível a menos de afim
//     sobre o conjunto ⇒ duas âncoras conhecidas fixam a afim e recuperam as margens
//   · explanation_text            → o R$ ia EMBUTIDO NA PROSA (nenhum nulificar-campo pega isso)
//
// Por isso `_admin` some INTEIRO (não nulificado campo a campo), `score_final` migra para dentro
// dele, `weights` sai do meta, e o texto perde o número.
//
// ⚠️ O QUE NÃO FECHA, de propósito: a ORDEM do array. Ela embute margem via score_final. É o
// produto da feature (o ranqueamento) e foi mantida por decisão do dono — declarado no PR.
// ════════════════════════════════════════════════════════════════════════════════════════════

export interface CandidatoProjetavel {
  product_id: string;
  codigo: string;
  descricao: string;
  price: number;
  margin: number | null;
  probability: number;
  eip: number;
  eiltv: number;
  score_final: number;
  recommendation_type: string;
  explanation_text: string;
  explanation_key: string;
  estoque: number;
  cost_final: number | null;
  cost_source: string;
  cost_confidence: number;
  cost_ranking: number | null;
  assoc_score: number;
  sim_score: number;
  ctx_score: number;
  penalties: number;
  familia: string | null;
}

export interface Pesos {
  wA: number;
  wP: number;
  wS: number;
  wC: number;
}

/**
 * Texto do ramo "margem" da explicação.
 *
 * O ramo em si FICA mesmo sem a capability: ele é conteúdo legítimo de venda ("este item tem alto
 * potencial de margem"). Some só o R$.
 *
 * ⚠️ Resíduo aceito e declarado: o ramo dispara com `margemExibida > 50`, então vê-lo prova
 * `margem > 50` ⇒ `custo < preço − 50`. Limiar FIXO ⇒ 1 desigualdade por SKU, não busca binária.
 * Suprimir o ramo degradaria a explicação para "boa adição ao mix" — conteúdo real destruído para
 * fechar 1 bit.
 */
export function textoExplicacaoMargem(
  descricao: string,
  margemExibida: number,
  podeCusto: boolean,
): string {
  return podeCusto
    ? `${descricao} tem alto potencial de margem (R$ ${margemExibida.toFixed(2)})`
    : `${descricao} tem alto potencial de margem`;
}

/**
 * Quantos candidatos devolver.
 *
 * O `recommendation_config` já distinguia `top_n_vendedor` (5) de `top_n_admin` (20), mas o código
 * devolvia `top_n_admin` para TODO MUNDO — a intenção da config estava escrita e não aplicada.
 * Aplicar reduz 4× a superfície do canal de ordenação e implementa o que a config já dizia.
 */
export function limiteCandidatos(topN: number, topNAdmin: number, podeCusto: boolean): number {
  return podeCusto ? topNAdmin : topN;
}

/**
 * Remove valores em reais de texto livre.
 *
 * ⚠️ POR QUE EXISTE (achado do Codex, gpt-5.6-sol xhigh, 2026-07-20): a lista branca de campos
 * protege contra campo NOVO, mas `explanation_text` JÁ está nela e carrega texto arbitrário. Um
 * ramo futuro que escrevesse `"Custo interno R$ 7,77"` vazaria pela projeção que se declara
 * fail-closed. O limite de segurança estava no PRODUTOR, não aqui.
 *
 * ⚠️ LIMITE HONESTO: isto pega a forma marcada com `R$`, que é a regressão realista (foi
 * exatamente o que existia). NÃO pega `"custo unitario: 7.77"` sem marcador. Texto livre segue
 * sendo responsabilidade do produtor — a defesa aqui é profundidade, e o gate primário continua
 * sendo `textoExplicacaoMargem(..., podeCusto)` no caller.
 */
export function removerValores(texto: string): string {
  // R$ seguido de numero com separadores pt-BR ou en-US (1.234,56 / 1,234.56 / 7.77 / 7,77)
  return texto.replace(/R\$\s*-?\d[\d.,]*/g, "R$ —");
}

/**
 * Projeta um candidato para a resposta.
 *
 * Fail-closed por CONSTRUÇÃO: o objeto do caso negativo é montado do zero com a lista branca de
 * campos, em vez de copiar o candidato e deletar os sensíveis. Campo novo no Candidate não vaza
 * sozinho — precisa ser adicionado aqui de propósito. E o único campo de texto livre da lista
 * branca passa por `removerValores` (ver o limite declarado acima).
 */
export function projetarCandidato(c: CandidatoProjetavel, podeCusto: boolean): Record<string, unknown> {
  const base = {
    product_id: c.product_id,
    codigo: c.codigo,
    descricao: c.descricao,
    price: c.price,
    probability: c.probability,
    estoque: c.estoque,
    recommendation_type: c.recommendation_type,
    explanation_text: c.explanation_text,
    explanation_key: c.explanation_key,
  };

  if (!podeCusto) {
    // Chaves PRESENTES com valor null: o contrato do cliente não muda de forma, e `fmt()` já
    // renderiza "—" para null. Degradação honesta — "não posso mostrar", não "vale zero".
    return {
      ...base,
      explanation_text: removerValores(c.explanation_text),
      margin: null,
      eip: null,
    };
  }

  return {
    ...base,
    margin: c.margin,
    // EIP é money (R$ de lucro esperado): null quando o custo não é confiável (margin null).
    eip: c.margin != null ? c.eip : null,
    _admin: {
      score_final: c.score_final,
      cost_final: c.cost_final,
      cost_source: c.cost_source,
      cost_confidence: c.cost_confidence,
      estimated_cost_for_ranking: c.cost_ranking,
      assoc_score: c.assoc_score,
      sim_score: c.sim_score,
      ctx_score: c.ctx_score,
      penalties: c.penalties,
      familia: c.familia,
      eiltv: c.margin != null ? c.eiltv : null,
    },
  };
}

/**
 * Meta da resposta. `weights` é insumo da inversão de `score_final` ⇒ só com a capability.
 *
 * ⚠️ MAS ISTO É DEFENSE-IN-DEPTH, NÃO BARREIRA — e dizer o contrário seria mentir. A tabela
 * `recommendation_config` (de onde os pesos saem) tem policy `master OR employee`: o mesmo usuário
 * de quem escondemos `weights` aqui lê `w_assoc/w_eip/w_sim/w_ctx` com um `select`. Idem
 * `farmer_association_rules`, que reconstrói `assoc_score`.
 *
 * O que realmente encarece a inversão é `score_final` ter saído da resposta (ele mora em `_admin`
 * agora): sobra só a ORDEM, que dá desigualdades, não valores. Fechar `recommendation_config` é
 * follow-up com dependência real de frontend (`useAnalyticsSync` lê E escreve a tabela numa tela
 * de tuning), então não entrou aqui.
 */
export function projetarMeta(
  totalCandidates: number,
  modo: "profit" | "ltv",
  pesos: Pesos,
  topN: number,
  podeCusto: boolean,
): Record<string, unknown> {
  const base = { total_candidates: totalCandidates, mode: modo, top_n: topN };
  return podeCusto ? { ...base, weights: pesos } : base;
}
