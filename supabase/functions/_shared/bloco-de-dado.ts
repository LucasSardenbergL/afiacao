// bloco-de-dado.ts — DADO do request (ou de cadastro) na mensagem do usuário, nunca no system.
// Puro, sem import remoto: roda sob `deno test --no-remote` (bloco-de-dado_test.ts).
//
// Por que existe (scanner Lovable Security, lote 7 — 2026-11-18): três edges de IA interpolavam
// texto que não é do operador no SYSTEM prompt — nome de categoria e de ferramenta digitado no
// cadastro, razão social, descrição de produto do Omie. O que está no system o modelo lê como
// instrução. O padrão é o do `copilot-analyze/copiloto-prompt.ts` (lote 6, #3947):
//   · o system prompt é constante e diz quais blocos da mensagem são dado;
//   · cada dado vai num bloco `<nome>…</nome>` da mensagem do usuário;
//   · o texto de um bloco não consegue abrir nem fechar um bloco (`neutralizar`).
//
// Limite declarado (o mesmo do copiloto): entidade HTML (`&lt;/x&gt;`) e caractere parecido
// (`＜`) passam como vieram. O delimitador é uma fronteira de leitura para o modelo, não um
// parser. O que protege a saída continua sendo a tool forçada e a normalização de cada edge.

const NOME_VALIDO = /^[a-z][a-z0-9_]*$/;

export interface BlocosDeDado<N extends string> {
  /** Os nomes reservados, na ordem declarada. */
  readonly nomes: readonly N[];
  /** Tira do texto a capacidade de abrir ou fechar QUALQUER bloco reservado. */
  neutralizar(texto: string): string;
  /** `<nome>\n…\n</nome>`, com o conteúdo neutralizado. */
  bloco(nome: N, conteudo: string): string;
}

/**
 * Cria o par `neutralizar`/`bloco` para um conjunto fixo de nomes. Todos os nomes de uma mensagem
 * entram no MESMO conjunto: o texto de um bloco não pode fechar nem o próprio bloco nem abrir outro.
 * `</categorias_cadastradas>` vira `</_categorias_cadastradas>`, que não é delimitador; cobre
 * maiúsculas e espaço ou quebra de linha em volta da barra.
 */
export function criarBlocosDeDado<N extends string>(nomes: readonly N[]): BlocosDeDado<N> {
  if (nomes.length === 0) throw new Error("criarBlocosDeDado: lista de nomes vazia");
  for (const n of nomes) {
    // O nome entra cru na regex: só minúscula, dígito e sublinhado, para não precisar escapar.
    if (!NOME_VALIDO.test(n)) throw new Error(`criarBlocosDeDado: nome de bloco inválido: ${JSON.stringify(n)}`);
  }
  const re = new RegExp(`<\\s*(/?)\\s*(${nomes.join("|")})`, "gi");
  const neutralizar = (texto: string) => texto.replace(re, "<$1_$2");
  return {
    nomes,
    neutralizar,
    bloco: (nome, conteudo) => `<${nome}>\n${neutralizar(conteudo)}\n</${nome}>`,
  };
}

/** Texto de cadastro numa linha e com teto: um item não carrega um bloco de instruções. */
export function textoCurto(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, max) : "";
}
