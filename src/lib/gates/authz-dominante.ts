// Detector da classe "gate que existe no arquivo mas não guarda o caminho caro" — parser TS
// de verdade, não regex.
//
// A CLASSE (#2086 → esta correção): o gate `ia-paga-sem-cota-gate` perguntava se o arquivo
// MENCIONA `authorizeCronOrStaff` para decidir se a edge é staff-only e, portanto, isenta de
// cota. `generate-bundle-argument` menciona — mas dentro de `if (decisaoSonda.tipo !==
// "disparo")`, ou seja, o helper guarda só o ramo da SONDA. O caminho de DISPARO, o que gasta
// token na Anthropic, passava com `getUser()` pelado. O gate ficou VERDE em cima da
// vulnerabilidade: falso-negativo, a direção cara.
//
// A pergunta certa não é "o arquivo cita o helper", é "TODA requisição passa por ele" —
// dominância. Um `authorize` no topo do handler domina; um aninhado num ramo não domina, e o
// arquivo tem então DOIS caminhos de auth, dos quais o gate não sabe qual guarda a chamada
// paga.
//
// POR QUE AST E NÃO CONTAGEM DE CHAVES: medir aninhamento contando `{`/`}` no texto quebra
// dentro de template literal — e edges de IA são feitas de prompt, com `${...}` e chaves em
// prosa. É a mesma armadilha do stripper compartilhado (`limpeza-fonte`): regex não sabe o
// que é string. Só o parser responde "este nó está dentro de um ramo?".
import ts from "typescript";

/** Helpers de autorização de fronteira do `_shared/auth.ts`. */
const HELPERS_AUTHZ = /^authorize(CronOrStaff|Master|Staff)$/;

/**
 * Tabela de papéis. Nem toda edge usa o helper: `analyze-unified-order` faz a checagem INLINE
 * (`from("user_roles")` → 403 se não for employee/master), e reprovar uma edge realmente
 * gateada seria o vermelho que ensina a ignorar o vermelho. A forma varia; a exigência de
 * dominância, não.
 */
const TABELA_DE_PAPEIS = "user_roles";

export type SitioAuthz = {
  /** Nome do helper, ou `from("user_roles")` para a checagem inline. */
  helper: string;
  linha: number;
  /** true = executa em TODA requisição; false = aninhado num ramo (guarda só parte do fluxo). */
  domina: boolean;
};

const nomeDoChamado = (no: ts.CallExpression): string | null => {
  const alvo = no.expression;
  if (ts.isIdentifier(alvo)) return alvo.text;
  if (ts.isPropertyAccessExpression(alvo)) return alvo.name.text;
  return null;
};

/**
 * O nó roda incondicionalmente dentro da função que o contém?
 *
 * Sobe a cadeia de pais até o `SourceFile`. Quebra a dominância quando o nó está no lado
 * CONDICIONAL de uma construção — e só nele: `if ((await authorize(req)).ok)` tem a chamada na
 * CONDIÇÃO, que roda sempre, enquanto `if (x) { await authorize(req) }` tem a chamada no ramo,
 * que não roda sempre. `try {}` e `finally {}` preservam; `catch {}` não.
 *
 * Fronteira de função: uma é esperada (o callback do `Deno.serve`). Duas ou mais significam
 * que a chamada mora num helper interno, cuja invocação pode ela mesma ser condicional — o
 * detector não segue a chamada, então trata como NÃO dominante (fail-closed).
 */
const rodaSempre = (no: ts.Node): boolean => {
  let atual: ts.Node = no;
  let fronteirasDeFuncao = 0;

  for (let pai = atual.parent; pai; atual = pai, pai = pai.parent) {
    if (ts.isIfStatement(pai) && atual !== pai.expression) return false;
    if (ts.isSwitchStatement(pai) && atual !== pai.expression) return false;
    if (ts.isConditionalExpression(pai) && atual !== pai.condition) return false;
    if (ts.isCatchClause(pai)) return false;
    if (
      ts.isWhileStatement(pai) || ts.isDoStatement(pai) || ts.isForStatement(pai)
      || ts.isForInStatement(pai) || ts.isForOfStatement(pai)
    ) return false;
    // Curto-circuito: só o operando DIREITO é condicional.
    if (
      ts.isBinaryExpression(pai) && atual === pai.right
      && (pai.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || pai.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || pai.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) return false;
    if (ts.isFunctionLike(pai) && ++fronteirasDeFuncao > 1) return false;
  }
  return true;
};

/** `from("user_roles")` — a checagem de papel feita à mão, sem o helper compartilhado. */
const ehLeituraDePapeis = (no: ts.CallExpression): boolean => {
  const alvo = no.expression;
  if (!ts.isPropertyAccessExpression(alvo) || alvo.name.text !== "from") return false;
  const [arg] = no.arguments;
  return !!arg && ts.isStringLiteralLike(arg) && arg.text === TABELA_DE_PAPEIS;
};

/** Todos os sítios de autorização de fronteira da fonte, com a dominância de cada um. */
export function sitiosAuthz(fonte: string, nomeArquivo = "edge.ts"): SitioAuthz[] {
  const arquivo = ts.createSourceFile(nomeArquivo, fonte, ts.ScriptTarget.ESNext, true);
  const achados: SitioAuthz[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isCallExpression(no)) {
      const nome = nomeDoChamado(no);
      const rotulo = nome && HELPERS_AUTHZ.test(nome)
        ? nome
        : ehLeituraDePapeis(no)
          ? `from("${TABELA_DE_PAPEIS}")`
          : null;
      if (rotulo) {
        achados.push({
          helper: rotulo,
          linha: arquivo.getLineAndCharacterOfPosition(no.getStart(arquivo)).line + 1,
          domina: rodaSempre(no),
        });
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arquivo);
  return achados;
}

/**
 * A fonte é guardada por um gate de staff que vale para TODA requisição?
 *
 * É este o predicado que autoriza tratar uma edge como "staff-only, isenta de cota". Um
 * arquivo que só tem `authorize` aninhado responde `false` mesmo mencionando o helper — que é
 * exatamente o caso que o gate anterior deixava passar.
 */
export function temAuthzDominante(fonte: string): boolean {
  return sitiosAuthz(fonte).some((s) => s.domina);
}
