import ts from 'typescript';

/**
 * Detector da classe **"o hook expõe a falha e o consumidor não a lê"**.
 *
 * Irmão de `erro-colapsado-em-vazio.ts`, e não uma extensão dele, por uma razão estrutural:
 * aquele detector persegue a binding `data` do react-query (`if (prop === "data")`) e decide
 * tudo DENTRO de um arquivo. Esta classe mora em hooks de **payload próprio** —
 * `useFarmerScoring` devolve `{ clientScores, agenda, erro }`, `useCrossSellEngine` devolve
 * `{ recommendations, erro }`, `useCatalisadorLinksMap` devolve `{ byKey, isError }` — então
 * saber o que é payload e o que é sinal exige ler o ARQUIVO DO HOOK, não o do consumidor. Daí
 * a API em dois passos: `mapearHooksComSinal` varre as fontes uma vez, `acharSinaisIgnorados`
 * usa o mapa por arquivo.
 *
 * Por que a classe sobreviveu a 3 PRs (#1565 → #1579 → #1697): o gate vizinho não a vê. O
 * `CHAVES_DE_ERRO` dele não tem `erro` (só `error`/`isError`/…), e sem binding `data` ele nem
 * considera o sítio — o `CarteiraBoard` pré-fix passava LIMPO por ele. Medido em 2026-10-09.
 *
 * O dano: sob falha de leitura o payload sai vazio e a tela afirma "não existe" onde a verdade
 * é "não consegui ler" — board com três colunas "Nada aqui", `summary` devolvendo
 * `{ avgHealth: 0 }` literal, selo degradando a "sob consulta". É o `Number(null) === 0` do
 * CLAUDE.md numa camada acima: ausente ≠ zero.
 */

/** Campos que um hook deste repo usa para DECLARAR falha de leitura. */
const CHAVES_DE_SINAL = new Set(['erro', 'isError', 'error', 'loadError', 'estado']);

export type HookComSinal = {
  /** campo que o hook expõe para declarar a falha (`erro`, `isError`, …). */
  campo: string;
  /** arquivo onde o hook é declarado — um consumidor dentro dele não conta. */
  arquivo: string;
};

export type SinalIgnorado = {
  hook: string;
  /** campo de sinal que o consumidor deixou de destruturar. */
  campo: string;
  linha: number;
};

const ehNomeDeHook = (n: string) => /^use[A-Z]/.test(n);

const chaveDaProp = (p: ts.ObjectLiteralElementLike): string | null => {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isStringLiteral(p.name)) return p.name.text;
  return null;
};

const parse = (conteudo: string, nomeArquivo: string) =>
  ts.createSourceFile(nomeArquivo, conteudo, ts.ScriptTarget.Latest, true);

/**
 * Passo 1 — quais hooks EXPÕEM um sinal de falha, e com que nome.
 *
 * Só conta `return { … }` literal: é a forma que permite AFIRMAR o nome do campo. Hook que
 * devolve `useQuery(...)` cru (pass-through) é a forma que o detector vizinho cobre pela
 * binding `data`, e hook que ENGOLE o erro (`if (error) return {}`) é a classe-irmã — em
 * nenhum dos dois há campo a destruturar, logo não há o que exigir do consumidor aqui.
 */
export function mapearHooksComSinal(
  fontes: { arquivo: string; conteudo: string }[],
): Map<string, HookComSinal> {
  const mapa = new Map<string, HookComSinal>();
  for (const { arquivo, conteudo } of fontes) {
    const sf = parse(conteudo, arquivo);
    const visitar = (n: ts.Node): void => {
      let nome: string | null = null;
      if (ts.isFunctionDeclaration(n) && n.name) nome = n.name.text;
      if (
        ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) nome = n.name.text;

      if (nome && ehNomeDeHook(nome)) {
        const alvo = nome;
        const acharReturn = (m: ts.Node): void => {
          if (ts.isReturnStatement(m) && m.expression) {
            let e: ts.Expression = m.expression;
            if (ts.isParenthesizedExpression(e)) e = e.expression;
            if (ts.isObjectLiteralExpression(e)) {
              for (const p of e.properties) {
                const k = chaveDaProp(p);
                if (k && CHAVES_DE_SINAL.has(k)) mapa.set(alvo, { campo: k, arquivo });
              }
            }
          }
          ts.forEachChild(m, acharReturn);
        };
        ts.forEachChild(n, acharReturn);
      }
      ts.forEachChild(n, visitar);
    };
    visitar(sf);
  }
  return mapa;
}

/**
 * Passo 2 — sítios que chamam um hook do mapa e NÃO destruturam o sinal.
 *
 * Absolvições deliberadas (precisão > recall, como no gate vizinho — baseline só é confiável
 * se não mentir):
 * - `...rest` pode carregar o sinal; não dá para afirmar o colapso.
 * - guardar o retorno inteiro (`const q = useX()`) torna as chaves não-enumeráveis aqui.
 * - o arquivo do próprio hook (um hook que consome o outro declara o repasse ali mesmo).
 */
export function acharSinaisIgnorados(
  conteudo: string,
  nomeArquivo: string,
  hooks: Map<string, HookComSinal>,
): SinalIgnorado[] {
  const sf = parse(conteudo, nomeArquivo);
  const achados: SinalIgnorado[] = [];
  const visitar = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression)
    ) {
      const hook = n.initializer.expression.text;
      const reg = hooks.get(hook);
      if (reg && reg.arquivo !== nomeArquivo && ts.isObjectBindingPattern(n.name)) {
        let temSinal = false;
        let opaco = false;
        for (const el of n.name.elements) {
          if (el.dotDotDotToken) { opaco = true; continue; }
          const prop = el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf);
          if (prop === reg.campo) temSinal = true;
        }
        if (!temSinal && !opaco) {
          achados.push({
            hook,
            campo: reg.campo,
            linha: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return achados;
}
