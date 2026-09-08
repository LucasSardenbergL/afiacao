/**
 * O contrato da RPC `farmer_melhores_individuais_por_cliente` — e a validação que impede a
 * resposta malformada de virar veredicto na tela.
 *
 * IDENTIDADE E ELEIÇÃO SÃO CAMPOS SEPARADOS, e essa é a peça central do desenho:
 *
 *   `produtos`       — os SKUs que a tela vai NOMEAR. Sempre ≥ 1.
 *   `produto_eleito` — não-nulo **se e somente se** `situacao === 'eleito'`.
 *
 * Um campo único obrigava a escolher entre "só o eleito tem identidade" — e aí a tela não tem
 * nome para mostrar quando não houve eleição, que é a maioria dos casos medidos — e "todo estado
 * carrega product_id", que faz a tela renderizar um vencedor por descuido. Identificar produtos
 * não exige afirmar prioridade entre eles.
 *
 * `candidatos` tem UM significado: o tamanho do grupo registrado. Em `[A:1, B:1, C:2]` saem
 * `produtos=[A,B]` e `candidatos=3`, e a tela diz "2 de 3" — a frase verdadeira.
 */

export type SituacaoIndividual =
  | 'eleito'
  | 'empatado'
  | 'unico_registrado'
  | 'ordem_indisponivel'
  | 'referencia_ambigua';

const SITUACOES = new Set<string>([
  'eleito',
  'empatado',
  'unico_registrado',
  'ordem_indisponivel',
  'referencia_ambigua',
]);

/** Os três estados que nomeiam o GRUPO INTEIRO — para eles `produtos` tem de cobrir tudo. */
const NOMEIAM_O_GRUPO = new Set<string>([
  'unico_registrado',
  'ordem_indisponivel',
  'referencia_ambigua',
]);

export interface LinhaMelhorIndividual {
  customer_user_id: string;
  recommendation_type: 'cross_sell' | 'up_sell';
  situacao: SituacaoIndividual;
  produtos: string[];
  produto_eleito: string | null;
  candidatos: number;
  affinity_score: number | null;
  run_id: string | null;
}

/**
 * Formato uuid. Checar `typeof === 'string'` NÃO basta (achado do challenge): um
 * `customer_user_id` inválido some silenciosamente na consulta pela chave do Map — e sumir é
 * indistinguível de "este cliente não tem oferta", que é um VEREDICTO na tela. Um SKU inválido
 * viraria `produto_nao_resolve`, culpando o catálogo por um defeito da resposta.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida a resposta INTEIRA — e lança, em vez de filtrar.
 *
 * Descartar as linhas inválidas transformaria falha em ausência: o Map ficaria parcial e seria
 * apresentado como completo. O consumidor trata a exceção como `leitura_falhou`, que vale para a
 * carteira inteira e é honesto sobre o que não se sabe.
 *
 * Os invariantes ENTRE campos são o ponto. Campo a campo,
 * `{situacao:'empatado', candidatos:1, produtos:[]}` passa em "tipo reconhecido", "inteiro ≥ 1" e
 * "sem eleito fora de eleito" — e não representa empate nenhum.
 */
export function validarRespostaMelhorIndividual(data: unknown): LinhaMelhorIndividual[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `farmer_melhores_individuais_por_cliente devolveu ${data === null ? 'null' : typeof data} em vez de array`,
    );
  }

  const vistos = new Set<string>();
  return data.map((bruta, i) => {
    const l = (bruta ?? {}) as Record<string, unknown>;
    const onde = `linha ${i}`;

    if (typeof l.customer_user_id !== 'string' || !UUID.test(l.customer_user_id)) {
      throw new Error(`${onde}: customer_user_id não é uuid`);
    }
    if (l.recommendation_type !== 'cross_sell' && l.recommendation_type !== 'up_sell') {
      throw new Error(`${onde}: tipo desconhecido ${String(l.recommendation_type)}`);
    }
    const chave = `${l.customer_user_id}:${l.recommendation_type}`;
    if (vistos.has(chave)) throw new Error(`${onde}: (cliente,tipo) duplicado`);
    vistos.add(chave);

    const situacao = l.situacao;
    if (typeof situacao !== 'string' || !SITUACOES.has(situacao)) {
      throw new Error(`${onde}: situacao inválida ${String(situacao)}`);
    }
    const candidatos = l.candidatos;
    if (typeof candidatos !== 'number' || !Number.isInteger(candidatos) || candidatos < 1) {
      throw new Error(`${onde}: candidatos precisa ser inteiro >= 1`);
    }
    const produtos = l.produtos;
    if (!Array.isArray(produtos) || produtos.length < 1) {
      throw new Error(`${onde}: produtos precisa ser array não-vazio`);
    }
    if (!produtos.every((p) => typeof p === 'string' && UUID.test(p))) {
      throw new Error(`${onde}: produtos contém item que não é uuid`);
    }
    if (new Set(produtos).size !== produtos.length) {
      throw new Error(`${onde}: produtos com duplicata`);
    }
    if (produtos.length > candidatos) {
      throw new Error(`${onde}: produtos (${produtos.length}) excede candidatos (${candidatos})`);
    }

    const eleito = situacao === 'eleito';
    const temEleito = l.produto_eleito != null;
    if (temEleito !== eleito) {
      throw new Error(`${onde}: produto_eleito não-nulo tem de ser exatamente o estado eleito`);
    }
    if (eleito && !produtos.includes(l.produto_eleito as string)) {
      throw new Error(`${onde}: produto_eleito fora de produtos`);
    }

    // Cardinalidade POR estado — o que a validação campo a campo não alcança.
    if (eleito && (produtos.length !== 1 || candidatos < 2)) {
      throw new Error(`${onde}: eleito exige 1 produto nomeado e >= 2 candidatos`);
    }
    if (situacao === 'empatado' && (produtos.length < 2 || candidatos < 2)) {
      throw new Error(`${onde}: empatado exige >= 2 produtos e >= 2 candidatos`);
    }
    // Os três estados sem ordenação confiável prometem transportar TODOS os registrados. Sem
    // esta igualdade, `ordem_indisponivel` com candidatos=3 e produtos=[A,B] passaria — e a
    // tela diria "3 registradas" mostrando 2, escondendo uma oferta sem dizer que escondeu.
    if (NOMEIAM_O_GRUPO.has(situacao) && produtos.length !== candidatos) {
      throw new Error(
        `${onde}: ${situacao} exige produtos (${produtos.length}) = candidatos (${candidatos})`,
      );
    }
    if (situacao === 'unico_registrado' && candidatos !== 1) {
      throw new Error(`${onde}: unico_registrado exige exatamente 1 candidato`);
    }

    if (l.run_id != null && (typeof l.run_id !== 'string' || !UUID.test(l.run_id))) {
      throw new Error(`${onde}: run_id presente mas não é uuid`);
    }
    if (l.affinity_score != null && typeof l.affinity_score !== 'number' && typeof l.affinity_score !== 'string') {
      throw new Error(`${onde}: affinity_score em formato inesperado`);
    }

    return l as unknown as LinhaMelhorIndividual;
  });
}
