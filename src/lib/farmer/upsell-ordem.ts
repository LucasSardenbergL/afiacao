/**
 * A ORDEM do up-sell — o que decide o top-2 depois que o custo saiu do browser.
 *
 * O motor calculava `affinityScore = TAXA_CONVERSAO_UP_SELL * (health/100) * engagement * 0.8`
 * para CADA candidato: nenhum termo depende do produto, então todos os candidatos do mesmo
 * cliente empatavam, o `sort` (estável em V8) preservava a ordem de inserção e o `slice(0,2)`
 * devolvia os dois primeiros da varredura do `productList` — que vem de `fetchAllPages` com
 * `.order('id')`. O top-2 do up-sell era a ordem de uuid do catálogo.
 *
 * MEDIDO em prod (psql-ro, 20/08/2026): 422 ofertas up_sell vivas (= 211 pares
 * `(farmer,cliente)` × 2 vagas) cabem em 15 SKUs de 2.463 vendáveis; a mediana de candidatos
 * elegíveis por cliente é **2.068**; 229 das 422 (54%) estão no rank 1 ou 2 POR ID entre os
 * elegíveis do seu `current_product_id`; e uma simulação determinística do motor (ordem de
 * inserção do Map + ordem de `id`) reproduz 203/422 ofertas exatamente.
 *
 * O conserto NÃO reintroduz margem no browser — o custo saiu de lá de propósito, e
 * `get_skus_margem_positiva()` responde "este SKU é vendável?", não compara a rentabilidade
 * de DOIS SKUs. Ele usa atributos que o motor já tem na mão, sem leitura nova:
 *
 *   GATE  · mesma `familia` E mesma `unidade`. O comentário do motor promete "sugerir a LINHA
 *           superior" — sem noção de linha, "qualquer coisa mais cara" não é up-sell, é o
 *           catálogo inteiro. A `unidade` entra junto porque **19 das 81 famílias misturam
 *           unidades, cobrindo 1.080 dos 3.140 SKUs ativos (34%)**: sem ela, "o próximo preço
 *           acima" compara preço-por-unidade com preço-por-caixa (achado do challenge Codex).
 *   ORDEM · lexicográfica, NÃO um score composto ponderado: 1º menor RAZÃO de preço,
 *           2º popularidade.
 *
 * Efeito medido do conjunto (gate + dedup): mediana de candidatos DISTINTOS por cliente
 * 2.068 → 175; 1.057 dos 1.073 clientes seguem com up-sell (16 perdem).
 *
 * ⚠️ Deliberadamente SEM recorte de `account`: o #1823 mediu e descartou o filtro de conta
 * (47,4% dos clientes compram pelas duas empresas do grupo), e
 * `cross-sell-conta-da-oferta.test.tsx` exige que a oferta cross-empresa continue saindo.
 *
 * ⚠️ E deliberadamente SEM tocar `affinityScore`, que segue `= pij`. A tentação é gravar a
 * ordem no score (ex.: `pij × 1,1/razão`) para ela sobreviver à persistência — e é uma
 * armadilha: `farmer_melhor_individual_atomico` e `usePropostaPreview` leem
 * `affinity_score` **sem filtrar `recommendation_type`**, comparando cross-sell com up-sell.
 * Ali a MAGNITUDE é usada como dado cardinal, e `1,1/r`, `(1,1/r)²` ou uma exponencial dão a
 * mesma ordem local com resultados diferentes — escolher uma seria afirmar, sem dado, como a
 * afinidade decai com preço. Isso é inventar score. A ordem vive no ARRAY, e a tela do
 * vendedor (`FarmerRecommendations.tsx`) renderiza o array do hook, não o banco.
 */

/**
 * Piso de "materialmente mais caro" — o mesmo literal `1.1` que o motor já usava, agora
 * nomeado porque a razão de preço é medida contra ele.
 */
export const PISO_RAZAO_UP_SELL = 1.1;

/** Quantas vagas de up-sell chegam ao vendedor por cliente. */
export const VAGAS_UP_SELL = 2;

/**
 * A LINHA de um SKU: o par que torna "versão superior" uma afirmação verificável.
 *
 * Sai das colunas DEDICADAS `omie_products.familia`/`unidade`, não da cópia em
 * `metadata->>'descricao_familia'`. As duas hoje têm divergência ZERO em prod (3.140 de
 * 3.140), mas a coluna é a autoridade e a cópia é derivada — depender da derivada é aceitar
 * um contrato que ninguém garante. (`subfamilia` existe no schema e está 100% VAZIA em prod:
 * não serve de recorte, por mais atraente que o nome seja.)
 */
export interface LinhaDeProduto {
  familia: string | null;
  unidade: string | null;
}

/**
 * A chave de ordenação de um candidato. Os dois campos são atributos OBSERVADOS (preço de
 * tabela e histórico de compra), não um score derivado — é o que separa "ordenar por sinal"
 * de "inventar mérito".
 */
export interface ChaveUpSell {
  /** `preço do candidato / preço pago no item atual`. Menor = salto menor = linha mais próxima. */
  razaoPreco: number;
  /** Ocorrências do candidato no histórico global. Maior primeiro. Só desempata. */
  popularidade: number;
}

/**
 * Normaliza um campo de linha. `null` para ausente/vazio/não-string em vez de `''`: string
 * vazia empataria com string vazia e faria dois SKUs sem família virarem "a mesma linha" — a
 * versão textual do `Number(null) === 0`.
 */
export function campoDeLinha(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const limpo = bruto.trim();
  return limpo === '' ? null : limpo;
}

/**
 * O gate de elegibilidade: candidato e item atual são da MESMA linha?
 *
 * FAIL-CLOSED quando qualquer lado tem família OU unidade desconhecida. Sem os dois não há
 * como afirmar que um SKU é a versão superior do outro, e `precisão > recall` manda não
 * ofertar em vez de ofertar na dúvida. Em prod isso não descarta ninguém hoje (`familia` e
 * `unidade` estão em 3.140 de 3.140 ativos) — o fail-closed existe para o dia em que um SKU
 * entrar sem elas.
 */
export function mesmaLinha(atual: LinhaDeProduto, candidato: LinhaDeProduto): boolean {
  if (atual.familia === null || atual.unidade === null) return false;
  if (candidato.familia === null || candidato.unidade === null) return false;
  return atual.familia === candidato.familia && atual.unidade === candidato.unidade;
}

/**
 * Ordem lexicográfica: menor salto primeiro; empatados, o mais vendido primeiro.
 *
 * A razão é ADIMENSIONAL de propósito. O laço externo do motor percorre os itens JÁ COMPRADOS,
 * então candidatos vindos de itens diferentes disputam as mesmas 2 vagas: uma diferença em
 * REAIS não é comparável entre um item de R$ 50 e um de R$ 5.000, e a razão é.
 */
export function compararCandidatosUpSell(a: ChaveUpSell, b: ChaveUpSell): number {
  if (a.razaoPreco !== b.razaoPreco) return a.razaoPreco - b.razaoPreco;
  return b.popularidade - a.popularidade;
}

/**
 * Duas chaves são indistinguíveis?
 *
 * Igualdade EXATA, sem epsilon, e é o certo aqui: um epsilon inventaria empates entre SKUs de
 * preços distintos — e o empate é exatamente o que este módulo existe para CONTAR com
 * honestidade, não para produzir.
 *
 * NÃO exportada de propósito: só `posicoesDecididasPorSinal` a usa, e um `export` sem
 * consumidor reprova no `bunx knip` do health stack (que o `bun run test` não cobre).
 */
function candidatosEmpatam(a: ChaveUpSell, b: ChaveUpSell): boolean {
  return a.razaoPreco === b.razaoPreco && a.popularidade === b.popularidade;
}

/**
 * Quantas das posições EMITIDAS foram decididas por sinal — o numerador do
 * `upsell_ordem_decidida`.
 *
 * Uma posição é ARBITRÁRIA quando existe candidato DESCARTADO com a chave idêntica: aí quem
 * entrou e quem ficou de fora é sorteio, e o desenho é mostrar isso em vez de fingir ranking.
 * Como `chavesOrdenadas` já está ordenada, os empatados são contíguos — basta comparar com o
 * PRIMEIRO descartado.
 *
 * Empate que NÃO cruza o corte não conta: dois candidatos idênticos que cabem ambos no top-2
 * não custaram vaga a ninguém, e chamá-los de arbitrários encheria o sensor de ruído.
 *
 * Medido em prod sobre o cutoff REAL (união dos itens comprados, já deduplicada): **8,3%**
 * dos 1.033 clientes que descartam algum candidato têm empate na vaga 2. A 1ª medição deu
 * 3,8% porque media por `(cliente, item comprado)` — granularidade errada, já que o top-2 é
 * escolhido sobre a união (correção do challenge Codex).
 */
export function posicoesDecididasPorSinal(
  chavesOrdenadas: readonly ChaveUpSell[],
  vagas: number,
): number {
  const emitidas = Math.min(vagas, chavesOrdenadas.length);
  if (chavesOrdenadas.length <= vagas) return emitidas;

  const primeiroDescartado = chavesOrdenadas[vagas];
  let decididas = 0;
  for (let i = 0; i < emitidas; i++) {
    if (!candidatosEmpatam(chavesOrdenadas[i], primeiroDescartado)) decididas++;
  }
  return decididas;
}
