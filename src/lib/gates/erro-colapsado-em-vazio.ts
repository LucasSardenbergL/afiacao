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

// Sem `export`: o knip reprova export sem consumidor, e ninguém precisa NOMEAR a forma —
// ela é alcançável pela estrutura de `SitioColapso`, que é o que o gate consome.
//
// `return-afirmativo` NÃO é silêncio — por isso o tipo deixou de se chamar
// `FormaDeSilencio`. As duas primeiras formas apagam o componente; a terceira o substitui
// por uma FRASE ("Todas as fichas… estão completas", com ✓ verde). O colapso é o mesmo
// — `data === undefined` de erro lido como vazio — mas o dano é maior, porque a ausência
// deixa de afirmar segurança por OMISSÃO e passa a afirmá-la com texto e ícone.
type FormaDeColapso = "return-null" | "ternario-null" | "jsx-&&" | "return-afirmativo";

export type SitioColapso = {
  hook: string;
  aliasData: string;
  linha: number;
  /** default na própria desestruturação (`data: x = []`) — o irmão "ausente→vazio". */
  padraoDefault: string | null;
  colapsos: { forma: FormaDeColapso; linha: number }[];
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

/** `return ( <div/> )` chega como ParenthesizedExpression — pode haver mais de uma camada. */
const desembrulhar = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ? desembrulhar(e.expression) : e;

/**
 * Texto literal que o usuário LÊ na tela. É o critério que separa a 3ª forma da 1ª: um
 * `return <Skeleton/>` não afirma nada, um `return <p>Ferramenta não encontrada</p>` afirma.
 * Só `JsxText` conta — texto por ATRIBUTO (`<EmptyState title="…"/>`) é outro eixo, medido
 * à parte e zerado em 2026-09-06 (docs/historico/o-check-verde-que-a-falha-acende.md).
 */
const textoVisivel = (no: ts.Node): boolean => {
  let achou = false;
  const v = (n: ts.Node) => {
    if (achou) return;
    if (ts.isJsxText(n) && n.text.trim() !== "") { achou = true; return; }
    ts.forEachChild(n, v);
  };
  v(no);
  return achou;
};

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

          const colapsos: SitioColapso["colapsos"] = [];
          const busca = (n: ts.Node): void => {
            if (ts.isIfStatement(n) && toca(n.expression)) {
              const vr = (x: ts.Node) => {
                if (ts.isReturnStatement(x)) {
                  if (ehSilencio(x.expression)) {
                    colapsos.push({ forma: "return-null", linha: linhaDe(x) });
                  } else if (x.expression) {
                    // MESMA guarda, outro desfecho: em vez de sumir, o componente MENTE.
                    const alvo = desembrulhar(x.expression);
                    const ehJsx = ts.isJsxElement(alvo) || ts.isJsxSelfClosingElement(alvo) || ts.isJsxFragment(alvo);
                    if (ehJsx && textoVisivel(alvo)) colapsos.push({ forma: "return-afirmativo", linha: linhaDe(x) });
                  }
                }
                ts.forEachChild(x, vr);
              };
              vr(n.thenStatement);
            }
            if (ts.isReturnStatement(n) && n.expression && ts.isConditionalExpression(n.expression)
                && toca(n.expression.condition)
                && (ehSilencio(n.expression.whenTrue) || ehSilencio(n.expression.whenFalse))) {
              colapsos.push({ forma: "ternario-null", linha: linhaDe(n) });
            }
            if (ts.isJsxExpression(n) && n.expression && ts.isBinaryExpression(n.expression)
                && n.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                && toca(n.expression.left)) {
              const dir = n.expression.right;
              if (ts.isJsxElement(dir) || ts.isJsxSelfClosingElement(dir) || ts.isJsxFragment(dir) || ts.isParenthesizedExpression(dir)) {
                colapsos.push({ forma: "jsx-&&", linha: linhaDe(n) });
              }
            }
            ts.forEachChild(n, busca);
          };
          busca(escopo);

          if (colapsos.length || padraoDefault) {
            sitios.push({ hook: chamada.expression.text, aliasData, linha: linhaDe(node), padraoDefault, colapsos });
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
    .filter((s) => s.colapsos.some((x) => x.forma === "return-null" || x.forma === "ternario-null"))
    .length;
}

/**
 * A 2ª forma FISCALIZADA: `return <JSX com texto>` guardado pela leitura — o colapso que
 * MENTE em vez de sumir (docs/historico/o-check-verde-que-a-falha-acende.md, 2026-09-06).
 *
 * POR QUE ESTA E NÃO `jsx-&&`, e o argumento é aritmético e não estético: `jsx-&&` são 93
 * sítios, idioma legítimo na maioria, e 21 deles INERTES — o hook engole o erro, a query
 * fica `success` com `[]`, e o "fix" seria diff plausível com zero mudança de
 * comportamento. Gatear aquilo faria a baseline crescer por motivo benigno, que é como um
 * gate morre. Aqui são 13 sítios e **13 de 13 são alcançáveis** (todos os hooks fazem
 * `if (error) throw error`): não há fatia inerte que vire ruído na baseline.
 *
 * O recorte NÃO é "todo `return` com texto" — isso pegaria empty state legítimo guardado
 * por outra coisa. É `return` com JsxText não-vazio guardado por condição que toca o `data`
 * de um hook cuja desestruturação NÃO liga `error`, que é o que `acharColapsos` já isola.
 *
 * DEDUPLICADO POR LINHA: um mesmo `return` é taintado por N hooks do componente, e contar
 * por hook INFLA — `ToolHistory:174` é UM sítio, não dois. (O gate é por arquivo, então
 * dedup por linha dentro do arquivo é a chave `(arquivo, linha)` do doc.)
 */
export function contarRetornoAfirmativo(conteudo: string, nomeArquivo: string): number {
  const linhas = new Set<number>();
  for (const s of acharColapsos(conteudo, nomeArquivo)) {
    for (const c of s.colapsos) if (c.forma === "return-afirmativo") linhas.add(c.linha);
  }
  return linhas.size;
}
