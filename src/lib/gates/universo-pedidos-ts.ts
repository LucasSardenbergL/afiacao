// Gate do universo de pedidos de VENDA no TypeScript — a metade TS/edges da classe
// (docs/historico/universo-pedidos-classe-ts.md; a metade SQL é `scripts/universo-pedidos-sql-gate.ts`).
//
// A CLASSE: ler `public.sales_orders` como VENDA aplicando OUTRO universo que não o da autoridade —
// `status NOT IN (STATUS_NAO_VENDA)` + `deleted_at IS NULL` (`src/lib/farmer/universo-pedidos.ts`,
// espelho Deno em `supabase/functions/_shared/universo-pedidos.ts`). As formas vistas: sem filtro de
// status, `.neq('status','cancelado')`, denylist parcial num literal, filtro DEPOIS da query com uma
// constante paralela (`ORDER_STATUS_INVALIDOS`, `STATUS_INVALIDOS`, `STATUS_CANCELAMENTO`,
// `STATUS_NAO_FATURAVEL`), e o `deleted_at` esquecido — metade do contrato que a autoridade não aplica.
//
// AS FORMAS DE LER (por AST — comentário e string não são código para o parser; nenhum stripper aqui):
//   · from  — `X.from('sales_orders')`, com cast (`(db.from as F)('sales_orders')`, `'sales_orders' as
//     any`), genérico (`db.from<T>("sales_orders")`) e quebra de linha em qualquer ponto; a cadeia é
//     seguida PARA CIMA (`.select().not().is()…`) e, se termina numa variável (`let q = …`, `q = …`),
//     por toda cadeia enraizada nessa variável no MESMO escopo de função (`q = q.eq(…)`, `await q.order(…)`);
//   · embed — `.select('…, sales_orders!inner(…)')` lendo o pedido pai EMBEDADO a partir de outra tabela;
//     o filtro canônico ali é `sales_orders.status`/`sales_orders.deleted_at`.
//
// O CERTO: `.not('status', 'in', STATUS_NAO_VENDA_POSTGREST)` + `.is('deleted_at', null)` na cadeia,
// com a constante importada da autoridade (nunca uma lista literal). Leitura que NÃO é pergunta de
// venda de propósito — lookup por id, feed operacional — vai para o REGISTRO, com categoria e motivo.
//
// LIMITES DECLARADOS (o que o AST sem tipos não vê):
//   · a cadeia que atravessa RETORNO de função ou PARÂMETRO (`aplicarFiltros(db.from(…))`, `return
//     db.from(…)` completado pelo chamador) é julgada só pelo que se vê no site — sai NÃO-canônica e
//     cai no registro, que é o lado seguro;
//   · a variável é seguida pelo NOME dentro do escopo de função, sem análise de fluxo: um filtro posto
//     num ramo `if` conta como se valesse sempre;
//   · SQL cru em string (psql/`execute`) não é PostgREST — fora do alcance (é a metade SQL, ou
//     diagnóstico de script);
//   · RPC que devolve linhas de `sales_orders` com `status` para o consumidor filtrar
//     (`cockpit_itens_snapshot`) não é leitura `from` — quem a vigia é o detector de CONSTANTE
//     PARALELA abaixo, sobre o filtro que o consumidor aplica.
import tsInterop from "typescript";
// `import =` e não `const` (o porquê em erro-colapsado-em-vazio.ts: o Proxy de interop do vite-node).
import ts = tsInterop;

export type Operacao = "leitura" | "escrita" | "indefinida";

export interface SitioPedidos {
  arquivo: string;
  linha: number;
  via: "from" | "embed";
  operacao: Operacao;
  /**
   * A identidade do sítio no registro: os métodos da cadeia com a COLUNA de cada filtro, sem valores
   * (`select·eq(id)·maybeSingle`). Muda quando a PERGUNTA muda — um lookup por id que perde o
   * `.eq('id')` vira outro sítio e tem de ser reclassificado; acrescentar coluna ao select não muda.
   */
  forma: string;
  statusCanonico: boolean;
  deletedAt: boolean;
  /**
   * A leitura do COMPLEMENTO — o conjunto de exclusão de quem filtra em memória
   * (`algorithm-a-audit`): `.in('status', STATUS_NAO_VENDA)` lê os não-venda, `.not('deleted_at',
   * 'is', null)` lê os apagados. Cada uma é metade do complemento; o gate exige as DUAS no arquivo.
   */
  complementoStatus: boolean;
  complementoDeleted: boolean;
  /** Filtros de status que NÃO são o canônico (`neq(status,"cancelado")`), na ordem da cadeia. */
  statusParalelo: string[];
  /** Seguiu a cadeia por uma variável reatribuída (`let q = …; q = q.eq(…)`). */
  seguiuVariavel: boolean;
}

export type Classe = "canonico" | "complemento" | "escrita" | "fora";

/**
 * `canonico` — o par inteiro, e nenhum OUTRO filtro de status (estreitar por status é a allowlist
 * que esta classe matou: `faturado` sozinho escondia 10.281 pedidos). `complemento` — lê só o
 * conjunto de exclusão, pela lista da autoridade. `escrita` — insert/update/upsert/delete: o
 * universo é pergunta de LEITURA. `fora` — qualquer outra coisa: canônico por engano ou de
 * propósito, decide o REGISTRO.
 */
export function classificar(s: SitioPedidos): Classe {
  if (s.operacao === "escrita") return "escrita";
  if (s.statusParalelo.length > 0) return "fora";
  if (s.statusCanonico && s.deletedAt) return "canonico";
  if ((s.complementoStatus || s.complementoDeleted) && !s.statusCanonico && !s.deletedAt) return "complemento";
  return "fora";
}

const ESCRITA = new Set(["insert", "upsert", "update", "delete"]);
const FILTRO = new Set([
  "eq", "neq", "in", "not", "is", "gt", "gte", "lt", "lte", "like", "ilike", "filter", "match", "or",
  "contains", "containedBy", "overlaps", "textSearch",
]);
const CONSTANTE_CANONICA = "STATUS_NAO_VENDA_POSTGREST";
const LISTA_CANONICA = "STATUS_NAO_VENDA";

type Elo = { metodo: string; args: readonly ts.Expression[] };

function desembrulhar(n: ts.Expression): ts.Expression {
  let x = n;
  while (
    ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)
  ) x = x.expression;
  return x;
}

/** Sobe pelos embrulhos que não mudam o valor (parênteses, cast, `!`) — o nó "visível" da expressão. */
function embrulhoExterno(n: ts.Node): ts.Node {
  let x = n;
  while (
    x.parent && (
      ts.isParenthesizedExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isNonNullExpression(x.parent) ||
      ts.isTypeAssertionExpression(x.parent) || ts.isSatisfiesExpression(x.parent)
    )
  ) x = x.parent;
  return x;
}

function literal(n: ts.Expression | undefined): string | undefined {
  if (!n) return undefined;
  const x = desembrulhar(n);
  return ts.isStringLiteralLike(x) ? x.text : undefined;
}

function referencia(n: ts.Expression | undefined, nome: string): boolean {
  if (!n) return false;
  const x = desembrulhar(n);
  if (ts.isIdentifier(x)) return x.text === nome;
  if (ts.isPropertyAccessExpression(x)) return x.name.text === nome;
  return false;
}

const ehConstanteCanonica = (n: ts.Expression | undefined) => referencia(n, CONSTANTE_CANONICA);

/** `STATUS_NAO_VENDA`, `STATUS_NAO_VENDA as string[]` ou `[...STATUS_NAO_VENDA]` — nada além disso. */
function ehListaCanonica(n: ts.Expression | undefined): boolean {
  if (!n) return false;
  if (referencia(n, LISTA_CANONICA)) return true;
  const x = desembrulhar(n);
  return ts.isArrayLiteralExpression(x) && x.elements.length === 1 &&
    ts.isSpreadElement(x.elements[0]) && referencia(x.elements[0].expression, LISTA_CANONICA);
}

/** Cadeia de métodos ACIMA de `inicio` (`inicio.a().b()…`), e o nó onde ela termina. */
function cadeiaAcima(inicio: ts.Node): { elos: Elo[]; topo: ts.Node } {
  const elos: Elo[] = [];
  let cur = embrulhoExterno(inicio);
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur && p.parent &&
        ts.isCallExpression(p.parent) && p.parent.expression === p) {
      elos.push({ metodo: p.name.text, args: p.parent.arguments });
      cur = embrulhoExterno(p.parent);
      continue;
    }
    return { elos, topo: cur };
  }
}

/** Nome da variável que recebe a cadeia (`let q = <topo>` / `q = <topo>` / `const q = await <topo>`). */
function variavelDestino(topo: ts.Node): string | undefined {
  let n = topo;
  if (n.parent && ts.isAwaitExpression(n.parent)) n = embrulhoExterno(n.parent);
  const p = n.parent;
  if (!p) return undefined;
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n &&
      ts.isIdentifier(p.left)) return p.left.text;
  return undefined;
}

function escopoDeFuncao(n: ts.Node): ts.Node {
  let x: ts.Node | undefined = n.parent;
  while (x) {
    if (ts.isFunctionLike(x) || ts.isSourceFile(x)) return x;
    x = x.parent;
  }
  return n.getSourceFile();
}

/** Todas as cadeias `nome.metodo(…)…` no escopo, depois da posição `apos`. */
function cadeiasDaVariavel(escopo: ts.Node, nome: string, apos: number): Elo[] {
  const elos: Elo[] = [];
  const visita = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.pos >= apos) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const raiz = desembrulhar(callee.expression);
        if (ts.isIdentifier(raiz) && raiz.text === nome) {
          elos.push({ metodo: callee.name.text, args: n.arguments });
          elos.push(...cadeiaAcima(n).elos);
        }
      }
    }
    ts.forEachChild(n, visita);
  };
  visita(escopo);
  return elos;
}

function textoArg(a: ts.Expression): string {
  const l = literal(a);
  if (l !== undefined) return JSON.stringify(l);
  const x = desembrulhar(a);
  if (x.kind === ts.SyntaxKind.NullKeyword) return "null";
  return x.getText().replace(/\s+/g, " ").slice(0, 60);
}

function julgarElos(elos: readonly Elo[], prefixo: string) {
  const colStatus = `${prefixo}status`;
  const colDeleted = `${prefixo}deleted_at`;
  let statusCanonico = false;
  let deletedAt = false;
  let complementoStatus = false;
  let complementoDeleted = false;
  const statusParalelo: string[] = [];
  const ehNull = (a: ts.Expression | undefined) => !!a && desembrulhar(a).kind === ts.SyntaxKind.NullKeyword;
  for (const e of elos) {
    const col = literal(e.args[0]);
    if (e.metodo === "not" && col === colStatus && literal(e.args[1]) === "in" && ehConstanteCanonica(e.args[2])) {
      statusCanonico = true;
      continue;
    }
    if (e.metodo === "is" && col === colDeleted && ehNull(e.args[1])) {
      deletedAt = true;
      continue;
    }
    if (e.metodo === "in" && col === colStatus && ehListaCanonica(e.args[1])) {
      complementoStatus = true;
      continue;
    }
    if (e.metodo === "not" && col === colDeleted && literal(e.args[1]) === "is" && ehNull(e.args[2])) {
      complementoDeleted = true;
      continue;
    }
    const tocaStatus = col === colStatus ||
      (e.metodo === "or" && e.args.some((a) => /\bstatus\./.test(literal(a) ?? a.getText())));
    if (FILTRO.has(e.metodo) && tocaStatus) statusParalelo.push(`${e.metodo}(${e.args.map(textoArg).join(",")})`);
  }
  const operacao: Operacao = elos.some((e) => ESCRITA.has(e.metodo))
    ? "escrita"
    : elos.some((e) => e.metodo === "select") ? "leitura" : "indefinida";
  const forma = elos
    .map((e) => (FILTRO.has(e.metodo) || e.metodo === "order") ? `${e.metodo}(${literal(e.args[0]) ?? "·"})` : e.metodo)
    .join("·");
  return { operacao, forma, statusCanonico, deletedAt, complementoStatus, complementoDeleted, statusParalelo };
}

const EMBED = /\bsales_orders\s*(?:!\s*\w+\s*)?\(/;

// ── Constante paralela ──────────────────────────────────────────────────────────────────────
// A causa-raiz dos divergentes não era o site, era a CÓPIA da lista: `ORDER_STATUS_INVALIDOS`,
// `STATUS_INVALIDOS` (duas vezes), `STATUS_NAO_FATURAVEL` (src + edge), o literal do audit — cada
// uma nasceu certa para o seu dia e envelheceu sozinha quando a autoridade mudou (a do cockpit
// dizia espelhar VERBATIM a régua do v_caca, que o #2726 trocou por baixo dela).
//
// Assinatura: um literal de array (`[…]`, inclusive dentro de `new Set([…])`) ou uma string no
// formato do PostgREST (`"(a,b)"`, a forma do `.not('status','in',…)` cru) com DOIS ou mais
// membros distintos da autoridade, comparados sem caixa e sem acento. Dois, e não um: `cancelado`
// sozinho é vocabulário de meia dúzia de domínios (pedido de compra, título de AR, badge de UI) —
// medido 2026-10-01, 30 arrays com ≥1 membro, 8 com ≥2 (as 2 autoridades + as 6 cópias), e só UMA
// cópia com 1 membro (`STATUS_CANCELAMENTO`, sinônimos em caixa alta), erradicada na mesma leva.
// Esse é o limite declarado: cópia de UM status só não é distinguível de outro domínio.

export interface ConstanteParalela {
  arquivo: string;
  linha: number;
  /** Os membros da autoridade que a lista copia, normalizados e em ordem. */
  membros: string[];
}

export function normalizarStatus(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function detectarConstantesParalelas(
  arquivo: string,
  fonte: string,
  autoridade: readonly string[],
): ConstanteParalela[] {
  const aut = new Set(autoridade.map(normalizarStatus));
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const achadas: ConstanteParalela[] = [];
  const julgar = (n: ts.Node, valores: string[]) => {
    const membros = [...new Set(valores.map(normalizarStatus).filter((v) => aut.has(v)))].sort();
    if (membros.length >= 2) {
      achadas.push({ arquivo, linha: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, membros });
    }
  };
  const visita = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n)) {
      julgar(n, n.elements.filter(ts.isStringLiteralLike).map((e) => e.text));
    } else if (ts.isStringLiteralLike(n) && /^\s*\(.*\)\s*$/s.test(n.text)) {
      julgar(n, n.text.trim().slice(1, -1).split(",").map((v) => v.replace(/["'\s]/g, "")));
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return achadas;
}

export function detectarSitios(arquivo: string, fonte: string): SitioPedidos[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true,
    arquivo.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sitios: SitioPedidos[] = [];
  const linhaDe = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const registrar = (inicio: ts.CallExpression, via: "from" | "embed", elosIniciais: Elo[]) => {
    const { elos, topo } = cadeiaAcima(inicio);
    const todos = [...elosIniciais, ...elos];
    const nome = variavelDestino(topo);
    if (nome) todos.push(...cadeiasDaVariavel(escopoDeFuncao(topo), nome, topo.end));
    sitios.push({
      arquivo,
      linha: linhaDe(inicio),
      via,
      ...julgarElos(todos, via === "embed" ? "sales_orders." : ""),
      seguiuVariavel: nome !== undefined,
    });
  };

  const visita = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = desembrulhar(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && literal(n.arguments[0]) === "sales_orders") {
        registrar(n, "from", []);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "select" && EMBED.test(literal(n.arguments[0]) ?? "")) {
        // o elo `select` é o próprio `n`: a cadeia acima dele não o inclui
        registrar(n, "embed", [{ metodo: "select", args: n.arguments }]);
      }
    }
    ts.forEachChild(n, visita);
  };
  visita(sf);
  return sitios;
}
