// Detector da classe "erro colapsado em vazio" — parser TS de verdade, não regex.
//
// A CLASSE (docs/historico/fase-sem-sinal.md, #1859 e a revisão retroativa de 2026-08-22):
// um hook react-query que LANÇA no erro deixa `data === undefined`, a MESMA condição de
// "vazio" e de "nunca carregou". Um componente que devolve silêncio por `!data` sem ler
// `error` colapsa esses estados numa tela em branco só — e quando a tela é um ALERTA ou um
// painel de SAÚDE, a ausência AFIRMA segurança.
//
// POR QUE AST E NÃO GREP: a tentação é testar "trata erro?" com um grep de `error` no
// arquivo. Isso dá FALSO NEGATIVO em cima dos casos piores — `text-status-error` do Tailwind
// casa, e o arquivo passa como se lesse o erro. (Aconteceu na análise que originou este
// gate.) A pergunta certa é estrutural: a DESESTRUTURAÇÃO liga `error`? Só o parser
// responde isso.
import ts from "typescript";

/** Chaves que provam que o componente TEM acesso ao estado de falha da query. */
const CHAVES_DE_ERRO = new Set([
  "error", "isError", "isLoadingError", "isRefetchError", "failureReason", "status",
]);

export type FormaDeSilencio = "return-null" | "ternario-null" | "jsx-&&";

export type SitioColapso = {
  hook: string;
  aliasData: string;
  linha: number;
  /** default na própria desestruturação (`data: x = []`) — o irmão "ausente→vazio". */
  padraoDefault: string | null;
  silencios: { forma: FormaDeSilencio; linha: number }[];
};

const identsDe = (no: ts.Node): Set<string> => {
  const s = new Set<string>();
  const v = (n: ts.Node) => { if (ts.isIdentifier(n)) s.add(n.text); ts.forEachChild(n, v); };
  v(no);
  return s;
};

const ehSilencio = (e: ts.Expression | undefined): boolean =>
  !e || e.kind === ts.SyntaxKind.NullKeyword
  || (ts.isIdentifier(e) && e.text === "undefined")
  || (ts.isJsxFragment(e) && e.children.every((c) => ts.isJsxText(c) && c.text.trim() === ""));

const funcaoDona = (n: ts.Node): ts.Node | undefined => {
  let f: ts.Node | undefined = n.parent;
  while (f && !(ts.isFunctionDeclaration(f) || ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isMethodDeclaration(f))) f = f.parent;
  return f;
};

/**
 * Sítios em que um `data` de hook é lido SEM o `error` do mesmo hook e vira silêncio.
 *
 * O vínculo alias→silêncio propaga por DERIVADAS (ponto fixo): o silêncio quase nunca
 * pendura no alias cru, e sim numa variável tirada dele — `const check = data?.find(...)`
 * seguido de `if (!check) return null` foi exatamente como o DataHealthBanner escapou da
 * primeira versão desta varredura.
 */
export function acharColapsos(conteudo: string, nomeArquivo: string): SitioColapso[] {
  const sf = ts.createSourceFile(
    nomeArquivo, conteudo, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    nomeArquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sitios: SitioColapso[] = [];
  const linhaDe = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visita = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const chamada = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(chamada) && ts.isIdentifier(chamada.expression) && /^use[A-Z]/.test(chamada.expression.text)) {
        let aliasData: string | null = null;
        let padraoDefault: string | null = null;
        let temErro = false;
        let temRest = false;
        for (const el of node.name.elements) {
          if (el.dotDotDotToken) { temRest = true; continue; }
          const prop = el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf);
          if (CHAVES_DE_ERRO.has(prop)) temErro = true;
          if (prop === "data") {
            aliasData = el.name.getText(sf);
            padraoDefault = el.initializer ? el.initializer.getText(sf) : null;
          }
        }
        // `...rest` pode carregar o `error`; não dá para afirmar o colapso — precisão > recall.
        if (aliasData && !temErro && !temRest) {
          const escopo = funcaoDona(node) ?? sf;

          const marcados = new Set([aliasData]);
          const declaracoes: ts.VariableDeclaration[] = [];
          const coleta = (n: ts.Node) => {
            if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) declaracoes.push(n);
            ts.forEachChild(n, coleta);
          };
          coleta(escopo);
          for (let i = 0; i < 6; i++) {
            let mudou = false;
            for (const d of declaracoes) {
              if (marcados.has((d.name as ts.Identifier).text)) continue;
              for (const id of identsDe(d.initializer!)) {
                if (marcados.has(id)) { marcados.add((d.name as ts.Identifier).text); mudou = true; break; }
              }
            }
            if (!mudou) break;
          }
          const toca = (no: ts.Node) => [...identsDe(no)].some((id) => marcados.has(id));

          const silencios: SitioColapso["silencios"] = [];
          const busca = (n: ts.Node): void => {
            if (ts.isIfStatement(n) && toca(n.expression)) {
              const vr = (x: ts.Node) => {
                if (ts.isReturnStatement(x) && ehSilencio(x.expression)) silencios.push({ forma: "return-null", linha: linhaDe(x) });
                ts.forEachChild(x, vr);
              };
              vr(n.thenStatement);
            }
            if (ts.isReturnStatement(n) && n.expression && ts.isConditionalExpression(n.expression)
                && toca(n.expression.condition)
                && (ehSilencio(n.expression.whenTrue) || ehSilencio(n.expression.whenFalse))) {
              silencios.push({ forma: "ternario-null", linha: linhaDe(n) });
            }
            if (ts.isJsxExpression(n) && n.expression && ts.isBinaryExpression(n.expression)
                && n.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                && toca(n.expression.left)) {
              const dir = n.expression.right;
              if (ts.isJsxElement(dir) || ts.isJsxSelfClosingElement(dir) || ts.isJsxFragment(dir) || ts.isParenthesizedExpression(dir)) {
                silencios.push({ forma: "jsx-&&", linha: linhaDe(n) });
              }
            }
            ts.forEachChild(n, busca);
          };
          busca(escopo);

          if (silencios.length || padraoDefault) {
            sitios.push({ hook: chamada.expression.text, aliasData, linha: linhaDe(node), padraoDefault, silencios });
          }
        }
      }
    }
    ts.forEachChild(node, visita);
  };
  visita(sf);
  return sitios;
}

/**
 * A forma FISCALIZADA pelo gate: auto-ocultação TOTAL do componente.
 *
 * `return null` (ou ternário para null) guardado pela leitura apaga o componente inteiro
 * sem deixar rastro — foi a forma do #1859 e de todos os sítios de maior dano medidos
 * (banner de saúde de dados, pilha de alertas de fluxo de caixa, painel de saúde da
 * carteira). A forma `jsx-&&` fica de FORA de propósito: some um trecho e a página
 * continua na tela, e ela é idioma legítimo em 82 sítios do repo — gatear os dois faria a
 * baseline crescer por motivo benigno e ensinaria a atualizá-la no automático, que é como
 * um gate morre. Ela está MEDIDA e registrada em docs/agent/money-path.md.
 */
export function contarAutoOcultacao(conteudo: string, nomeArquivo: string): number {
  return acharColapsos(conteudo, nomeArquivo)
    .filter((s) => s.silencios.some((x) => x.forma === "return-null" || x.forma === "ternario-null"))
    .length;
}
