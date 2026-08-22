// Contrato de LEITURA single-shot no money-path — "erro ≠ ausente ≠ zero".
//
// Irmã single-shot da classe da paginação (money-path §6/§7): lá a página que falhava
// virava "fim da lista"; aqui a LEITURA que falha vira "a tabela está vazia". O furo é o
// mesmo — `data:null` de uma resposta com `error` sendo coalescido com `?? []`/`?? 0` —,
// só que sem laço nenhum, então o gate de paginação (que exige `.range(`) não o enxerga.
//
// Três estados que o `?? 0` COLAPSA num só, e que este módulo separa:
//   1. ERRO de transporte (RLS, timeout 57014, 500)  → o valor é DESCONHECIDO;
//   2. AUSÊNCIA de linha (`data: null`/`[]` SEM erro) → estado legítimo do negócio;
//   3. ZERO de verdade (a linha existe e vale 0).
// Colapsar (1) em (3) é fabricar número: a projeção de caixa sai calculada sobre saldo 0
// e a tela não tem como saber (money-path §2). Colapsar (2) em (3) costuma ser o
// comportamento DESEJADO e existente — por isso este módulo não mexe nele.
//
// Duas saídas, porque a decisão certa depende do consumidor (money-path §7 — "consertar o
// helper não conserta a tela"):
//   - `exigirLeitura`  → LANÇA no erro. Para o dado sem o qual o número é mentira.
//   - `tolerarLeitura` → devolve MOTIVO no erro. Para o dado que já degrada honesto
//                        (valor vira `null`/"—") e só precisa dizer POR QUÊ.
//
// ⚠️ PII: `error.message` do PostgREST encaminha o MESSAGE do Postgres, que pode
// interpolar valor de linha (`RAISE EXCEPTION` com ID/CPF, erro de cast reproduzindo o
// valor inválido). O `serve()` das edges devolve `String(err.message)` ao CLIENTE, então
// a mensagem daqui carrega só domínio FECHADO — nome da fonte (constante do código) e
// código de domínio fechado. O texto original fica em `cause` — passada pelo OPTIONS do
// `Error`, e por isso NÃO-ENUMERÁVEL: invisível a `JSON.stringify`/spread, acessível a
// quem a pede pelo nome (o log da edge). A versão que atribuía `this.cause = erro` fazia
// a propriedade enumerável e a garantia era falsa. (money-path: "garantia de privacidade
// afirmada sem verificar o SINK" — verificar o sink é medir, não reler o comentário.)

export type ErroPostgrest = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type RespostaLeitura<T> = {
  data: T | null;
  error: ErroPostgrest | null;
};

/**
 * Código em DOMÍNIO fechado — não só em FORMA.
 *
 * A versão anterior era `^[A-Za-z0-9_]{1,12}$`, que valida forma e nada mais: um CPF sem
 * pontuação tem 11 dígitos e passava INTEIRO para a mensagem pública, pela porta que existe
 * justamente para fechá-la (`codigoDoErro({ code: '52998224725' }) === '52998224725'`, medido
 * no challenge Codex desta entrega). O domínio real é pequeno e enumerável, então é ele que
 * vale: SQLSTATE tem EXATAMENTE 5 caracteres, o PostgREST usa `PGRST` + 3 dígitos, e os
 * códigos INTERNOS desta família são seis — nenhum deles colide com SQLSTATE (que não tem `_`
 * nem passa de 5 chars, e portanto não alcança nenhum deles).
 *
 * Fora do domínio vira `desconhecido`: perder a granularidade de um código exótico custa menos
 * que devolver texto do servidor com nome de "código sanitizado".
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const CODIGO_POSTGREST = /^PGRST[0-9]{3}$/;
const CODIGOS_INTERNOS = new Set([
  'MALFORMADA',
  'SEM_LINHAS',
  'REJEITADA',
  // Violação do CONTRATO do keyset — erro de programação do call-site, não de transporte. Três
  // códigos e não um: o MODO da violação é constante do código (domínio fechado) e por isso pode
  // ser público, enquanto o VALOR da chave que o revelou é dado da LINHA e fica em `cause`.
  'KEYSET_CHAVE_AUSENTE',
  'KEYSET_FORA_DE_ORDEM',
  'KEYSET_CHAVE_REPETIDA',
]);

export function codigoDoErro(erro: ErroPostgrest | null | undefined): string {
  const bruto = erro?.code;
  if (typeof bruto !== 'string') return 'desconhecido';
  if (CODIGOS_INTERNOS.has(bruto)) return bruto;
  if (SQLSTATE.test(bruto) || CODIGO_POSTGREST.test(bruto)) return bruto;
  return 'desconhecido';
}

export class FalhaLeituraCritica extends Error {
  readonly fonte: string;
  readonly codigo: string;

  constructor(fonte: string, erro: ErroPostgrest | null | undefined) {
    const codigo = codigoDoErro(erro);
    // Mensagem = domínio fechado. Vai ao cliente pelo catch do serve().
    // `SEM_LINHAS` não é falha de transporte (a leitura funcionou e voltou vazia), então
    // ganha texto próprio — dizer "falhou" mandaria o leitor caçar um erro que não houve.
    // `cause` vai pelo OPTIONS do `Error`, nunca por atribuição: `this.cause = x` cria uma
    // propriedade PRÓPRIA e ENUMERÁVEL, e aí `JSON.stringify(err)` e `{ ...err }` carregam o
    // objeto cru do PostgREST inteiro — `message`, `details` e `hint`, que são onde o Postgres
    // interpola valor de linha. Era assim até o challenge Codex desta entrega medir o sink:
    // `JSON.stringify(new FalhaLeituraCritica('x', {message:'CPF 52998224725...'}))` devolvia o
    // CPF. Nenhum consumidor serializava o Error inteiro, então era munição carregada e não
    // tiro disparado — mas a garantia estava afirmada sem o sink verificado, que é o pecado
    // que esta família existe para combater. Pelo options a propriedade é não-enumerável:
    // segue acessível a quem a pede pelo nome (o log da edge), invisível a quem serializa.
    super(
      codigo === 'SEM_LINHAS'
        ? `${fonte} não tem nenhuma linha para esta empresa — valor DESCONHECIDO, não zero. Verifique o cadastro.`
        : codigo === 'MALFORMADA'
        ? `Leitura de ${fonte} veio malformada (data null sem erro) — DESCONHECIDO, não lista vazia.`
        : `Leitura de ${fonte} falhou (código ${codigo}) — dado indisponível, não zero.`,
      { cause: erro ?? undefined },
    );
    this.name = 'FalhaLeituraCritica';
    this.fonte = fonte;
    this.codigo = codigo;
  }
}

/**
 * Leitura cujo valor NÃO pode ser substituído por zero/vazio.
 * - `error` presente → LANÇA `FalhaLeituraCritica`.
 * - sem `error`      → devolve `data` como veio (`null`/`[]` seguem significando ausência,
 *                      e o caller mantém o `?? 0`/`?? []` que já tinha).
 */
export function exigirLeitura<T>(res: RespostaLeitura<T>, fonte: string): T | null {
  if (res.error) throw new FalhaLeituraCritica(fonte, res.error);
  return res.data;
}

/**
 * Fonte cuja LISTA VAZIA não é um fato — é ausência de cadastro, e portanto o valor
 * agregado é DESCONHECIDO, não zero.
 *
 * Quarta variante, e a mais sutil: `exigirLeitura` separa "falhou" de "não tem linha",
 * mas para uma soma o "não tem linha" ainda vira `0` no `reduce`. Só linhas EXISTENTES
 * somando zero provam saldo zero; nenhuma linha prova apenas que ninguém cadastrou.
 * Para `fin_contas_correntes` os dois desfechos são numericamente idênticos (`saldo_cc = 0`)
 * e disparam o mesmo alerta de caixa negativo — exatamente o falso positivo que o contrato
 * desta família existe para eliminar.
 *
 * Use SÓ onde a lista vazia é implausível como estado de negócio. Não serve para eventos
 * recorrentes/eventuais (empresa sem evento cadastrado é normal), nem para DRE ou estoque
 * (ausência de balancete é estado legítimo e já avisado na UI).
 */
export function exigirLinhas<T>(res: RespostaLeitura<T>, fonte: string): T {
  const dados = exigirLeitura(res, fonte);
  if (dados == null || (Array.isArray(dados) && dados.length === 0)) {
    throw new FalhaLeituraCritica(fonte, { code: 'SEM_LINHAS' });
  }
  return dados;
}

/**
 * Códigos que significam "a coluna/relação pedida não existe no schema" — o único caso em
 * que uma leitura de coluna OPCIONAL pode ser engolida (a feature ainda não foi migrada).
 * `42703` undefined_column · `42P01` undefined_table · `PGRST204`/`PGRST202` são as
 * variantes do PostgREST para coluna/função inexistente no cache de schema.
 */
const COLUNA_AUSENTE = new Set(['42703', '42P01', 'PGRST204', 'PGRST202']);

/**
 * Leitura de coluna OPCIONAL: tolera só o erro de "coluna ainda não existe" e LANÇA em
 * qualquer outro. Sem esta distinção, um timeout ou um 42501 desliga silenciosamente o
 * guard que a coluna alimenta — e "feature não migrada" vira indistinguível de "o banco
 * piscou". (Achado do challenge Codex nesta entrega: "coluna opcional não justifica
 * engolir qualquer erro".)
 */
export function tolerarColunaAusente<T>(res: RespostaLeitura<T>, fonte: string): T | null {
  if (res.error) {
    if (COLUNA_AUSENTE.has(codigoDoErro(res.error))) return null;
    throw new FalhaLeituraCritica(fonte, res.error);
  }
  return res.data;
}

/**
 * Leitura que JÁ degrada honesto (valor vira `null` e a UI mostra "—"): o erro não
 * derruba o cálculo, mas para de se disfarçar de "não tem linha".
 * Devolve o motivo em domínio fechado, pronto para um canal de confiança.
 */
export function tolerarLeitura<T>(
  res: RespostaLeitura<T>,
  fonte: string,
): { dados: T | null; motivo: string | null } {
  if (res.error) {
    return {
      dados: null,
      motivo: `Leitura de ${fonte} falhou (código ${codigoDoErro(res.error)}) — indisponível, não zero.`,
    };
  }
  return { dados: res.data, motivo: null };
}
