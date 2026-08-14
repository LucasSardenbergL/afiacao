/**
 * authz-contract.ts — parser heurístico p/ o gate de autorização de funções SECURITY DEFINER.
 * ============================================================================================
 *
 * Fundação do check anti-regressão de gate (scripts/authz-gate-check.ts, chip task_fc0cc5bd,
 * follow-up do PR #1264). Lê o TEXTO das migrations — não o banco — porque o bug é "alguém
 * recriou a função sem o gate" e o detector barato é ler o SQL que entra no repo.
 * Decisão de arquitetura + endurecimento: Codex consult + challenge×2 (2026-07-09), spec em
 * docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md.
 *
 * Anti-falso-negativo (challenge Codex):
 *  - Comentários (de linha e de bloco) são removidos ANTES de parsear a estrutura — senão um
 *    `-- AS $x$ ...gate... $x$` comentado ou um `CREATE FUNCTION` comentado enganam o matcher.
 *  - O gate só conta como bloqueio se estiver NEGADO: `NOT [schema.]gate(` direto, ou dentro do
 *    grupo balanceado de um `NOT ( … )` (usa balancedParens, não janela fixa → sem falso-positivo
 *    em gate verboso e sem aceitar `NOT outra_coisa AND gate()`), seguido de `THEN … RAISE EXCEPTION`.
 *  - Suporta quoted identifiers, corpo single-quoted e `SECURITY DEFINER` depois do `AS`.
 *  - `CREATE FUNCTION` que o parser não extrai vira `unparsed` COM o texto bruto — fail-closed:
 *    o check bloqueia se o raw é SECDEF sensível, em vez de sumir em silêncio.
 *  - (2026-08-14) O RAISE tem de ser ALCANÇÁVEL: `IF false AND NOT gate() THEN RAISE …` tinha
 *    chamada, negação e RAISE, e passava — presença não é controle. Ver `raiseInIfBlock`.
 *  - (2026-08-14) O wrapper `(SELECT gate(…))` do idioma initplan quebrava a adjacência com o
 *    operador de negação e transformava gate legítimo em "decorativo". Ver `unwrapSelectScalar`.
 *    Os dois nasceram de uma medição, não de leitura: o detector foi rodado contra a definição
 *    real de `public.reposicao_pos_candidatos` e contra as formas sabotadas da revisão do #1718.
 *
 * Limitações conhecidas (v1 — ver §"Fora do escopo" do spec): não verifica SET search_path,
 * GRANT/REVOKE/PUBLIC-default, tabela sensível via view/helper/SQL dinâmico, ALTER/DROP FUNCTION,
 * enfraquecimento das próprias funções-gate, nem deny-por-RETURN (o contrato exige RAISE EXCEPTION).
 * blocksOnCall reconhece as formas COMUNS de negação (NOT / IS NOT TRUE / IS FALSE / = false /
 * IS DISTINCT FROM TRUE); uma forma exótica (ex.: `COALESCE(gate(),false) = false` literal, em vez
 * de `NOT COALESCE(gate(),false)`) pode gerar falso-POSITIVO — o autor reescreve na forma comum ou
 * classifica. É heurística de TEXTO: o alvo é a regressão ACIDENTAL, não evasão deliberada (uma
 * migration maliciosa passa por review humano; o complemento é o audit read-only periódico em PROD).
 */
import { balancedParens, normalizeSignature } from './migration-objects';

// Sem `export`: consumidos só por `touchesSensitive()` logo abaixo. Quem precisa da resposta
// chama a função, que é a superfície pública — a lista crua exportada convidava a duplicar a
// decisão de "o que é sensível" fora daqui.
const SENSITIVE_TABLES = ['inventory_position', 'product_costs', 'sku_estoque_atual'];
const SENSITIVE_COLUMNS = ['cmc', 'custo', 'preco', 'cost_price', 'unit_price'];

export interface FunctionDef {
  schema: string;
  name: string;
  signature: string;
  key: string;
  securityDefiner: boolean;
  body: string;
  header: string;
}
/**
 * um CREATE FUNCTION detectado mas cujo corpo o parser não extraiu — com o texto bruto p/ fail-closed.
 * Sem `export`: tipo de suporte de `ExtractResult`, que é a superfície pública.
 */
interface UnparsedFn {
  schema: string;
  name: string;
  raw: string;
}
export interface ExtractResult {
  defs: FunctionDef[];
  unparsed: UnparsedFn[];
}

// Sem `export`: tipo de suporte de `RequiredGate`, que é a superfície pública (o
// `authz-manifest.ts` importa só ela e constrói as cláusulas por literal).
interface GateClause {
  call: string;
  roles?: string[];
}
export interface RequiredGate {
  allOf?: GateClause[];
  anyOf?: GateClause[];
}
export interface GateResult {
  ok: boolean;
  missing: string[];
  weak: string[];
}

/** remove só comentários (linha/bloco); preserva strings e dollar-quotes */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** remove comentários E mascara string-literais → '' (corpo executável p/ busca de gate/tabela) */
export function stripNoise(sql: string): string {
  return stripComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquoteIdent(raw: string | undefined): string {
  if (!raw) return '';
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').toLowerCase();
  return t.toLowerCase();
}

function singleQuoteEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const q = s.indexOf("'", i);
    if (q === -1) return -1;
    if (s[q + 1] === "'") {
      i = q + 2;
      continue;
    }
    return q;
  }
  return -1;
}

const IDENT = '(?:"(?:[^"]|"")+"|\\w+)';
const FN_RE = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:(${IDENT})\\.)?(${IDENT})\\s*\\(`, 'gi');

/**
 * Extrai as definições de função (com corpo já limpo) + os CREATE FUNCTION que não deu p/ parsear.
 * Opera sobre o SQL SEM comentários (evita `AS $x$`/`CREATE FUNCTION` comentado enganarem).
 */
export function extractFunctions(sqlRaw: string): ExtractResult {
  const sql = stripComments(sqlRaw);
  const defs: FunctionDef[] = [];
  const unparsed: UnparsedFn[] = [];
  FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_RE.exec(sql)) !== null) {
    const schema = unquoteIdent(m[1]) || 'public';
    const name = unquoteIdent(m[2]);
    const parenIdx = m.index + m[0].length - 1;
    const args = balancedParens(sql, parenIdx);
    const signature = normalizeSignature(args);
    const afterArgs = parenIdx + args.length + 2;
    const rest = sql.slice(afterArgs);

    const asDollar = /\bAS\s+(\$\w*\$)/i.exec(rest);
    const asSingle = /\bAS\s+'/i.exec(rest);
    let body: string | null = null;
    let headerEndRel = 0;
    let bodyEndAbs = 0;
    if (asDollar && (!asSingle || asDollar.index <= asSingle.index)) {
      const tag = asDollar[1];
      const bs = afterArgs + asDollar.index + asDollar[0].length;
      const be = sql.indexOf(tag, bs);
      if (be !== -1) {
        body = sql.slice(bs, be);
        headerEndRel = asDollar.index;
        bodyEndAbs = be + tag.length;
      }
    } else if (asSingle) {
      const bs = afterArgs + asSingle.index + asSingle[0].length;
      const be = singleQuoteEnd(sql, bs);
      if (be !== -1) {
        body = sql.slice(bs, be);
        headerEndRel = asSingle.index;
        bodyEndAbs = be + 1;
      }
    }

    if (body === null) {
      const semi = sql.indexOf(';', afterArgs);
      const end = semi === -1 ? Math.min(sql.length, afterArgs + 1500) : semi;
      unparsed.push({ schema, name, raw: sql.slice(m.index, end) }); // fail-closed com o texto bruto
      continue;
    }

    const header = rest.slice(0, headerEndRel);
    const semi = sql.indexOf(';', bodyEndAbs);
    const trailer = sql.slice(bodyEndAbs, semi === -1 ? sql.length : semi);
    const securityDefiner = /\bSECURITY\s+DEFINER\b/i.test(header) || /\bSECURITY\s+DEFINER\b/i.test(trailer);

    defs.push({
      schema,
      name,
      signature,
      key: `function:${schema}.${name}(${signature})`,
      securityDefiner,
      body: stripNoise(body),
      header: stripNoise(header),
    });
    FN_RE.lastIndex = bodyEndAbs;
  }
  return { defs, unparsed };
}

export function extractFunctionDefs(sql: string): FunctionDef[] {
  return extractFunctions(sql).defs;
}

/** a chamada do gate aparece no corpo (tolera schema e whitespace antes do parêntese) */
export function hasGateCall(body: string, call: string): boolean {
  return new RegExp(`(?:\\w+\\.)?${escapeRe(call.toLowerCase())}\\s*\\(`, 'i').test(body.toLowerCase());
}

/** índice logo após o ')' que fecha a chamada cujo '(' começa em/após `openFrom` */
function callClose(b: string, openFrom: number): number {
  const open = b.indexOf('(', openFrom);
  if (open === -1) return b.length;
  return open + balancedParens(b, open).length + 2;
}

/**
 * desembrulha `( SELECT <expr> )` → ` <expr> `, repetindo até estabilizar.
 *
 * Existe porque a forma que o repo REALMENTE escreve não é a canônica:
 *   `AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN`
 * O `(SELECT …)` é o idioma initplan do Supabase (avalia o gate 1× por statement, não por linha).
 * Sem desembrulhar, o operador de negação não fica adjacente ao `)` da chamada — sobra um `)` de
 * wrapper no meio — e o passo (c) de `blocksOnCall` lia um gate legítimo como DECORATIVO. Falha
 * FECHADA, mas na cara do autor certo: era exatamente por isso que `reposicao_pos_candidatos` não
 * podia entrar no AUTHZ_MANIFEST — registrá-la deixava o CI vermelho por falso positivo, e a RPC
 * ficou fora do contrato de gate. Medido em 2026-08-14 sobre a definição real da 20260813195914;
 * as formas `(SELECT g()) = false` e a com quebra de linha antes do operador falhavam pelo mesmo
 * motivo. Lição: um detector calibrado só na forma canônica não vigia o código que existe.
 *
 * Conservador em dois pontos, de propósito:
 *  · só SELECT ESCALAR (sem FROM/WHERE/GROUP BY/UNION) — `(SELECT x FROM t)` é subquery de verdade
 *    e seu valor não é o valor de `x`;
 *  · só casa `(` seguido de `select` — `foo(gate())` NÃO é wrapper, então `NOT foo(gate())` segue
 *    não contando como bloqueio (ali quem é negado é `foo`, e afirmar o contrário seria afrouxar).
 */
function unwrapSelectScalar(b: string): string {
  for (let volta = 0; volta < 6; volta++) {
    let mudou = false;
    let out = '';
    let i = 0;
    while (i < b.length) {
      if (b[i] === '(') {
        const inner = balancedParens(b, i);
        const m = /^\s*select\s+([\s\S]+)$/i.exec(inner);
        if (m && !/\b(?:from|where|group\s+by|union)\b/i.test(m[1])) {
          out += ' ' + m[1] + ' ';
          i += inner.length + 2;
          mudou = true;
          continue;
        }
      }
      out += b[i];
      i++;
    }
    b = out;
    if (!mudou) break;
  }
  return b;
}

/** literal constante-falso na CABEÇA de uma condição (`false …`, `(1=0) …`) */
const CABECA_CONSTANTE_FALSA = /^\s*\(*\s*(?:false|1\s*=\s*0|0\s*=\s*1)\b/i;

/** índice logo após o `IF` que abre o bloco onde `antesDe` está — ignorando os `IF` de `END IF`. */
function aberturaDoIf(b: string, antesDe: number): number {
  const trecho = b.slice(0, antesDe);
  const ms = [...trecho.matchAll(/\bif\b/gi)].filter(
    (m) => !/\bend\s*$/i.test(trecho.slice(Math.max(0, m.index! - 8), m.index!)),
  );
  return ms.length ? ms[ms.length - 1].index! + 2 : -1;
}

/**
 * a partir de `from`, o bloco IF que o segue (…THEN … END IF) contém RAISE EXCEPTION ANTES do
 * END IF? Limitar ao bloco do gate evita o falso-negativo `IF NOT gate THEN RETURN; END IF;` +
 * um RAISE EXCEPTION de validação logo abaixo (challenge Codex ×3).
 *
 * ⚠️ E o RAISE precisa ser ALCANÇÁVEL. `IF false AND NOT gate() THEN RAISE EXCEPTION …` tem a
 * chamada, a negação e o RAISE — tudo o que um detector de TEXTO procura — e não executa nunca.
 * Medido em 2026-08-14: esta função dizia `true` para essa forma. É o caso 1 da revisão do #1718
 * (`/codex challenge`, gpt-5.6-sol) sobre a pós-condição por regex da 20260813195914: sentinela
 * textual prova PRESENÇA, nunca que a chamada GOVERNA o ramo.
 *
 * LIMITE DECLARADO: pega o literal na CABEÇA da condição (`IF false AND …`, `IF (1=0) AND …`) —
 * a forma de quem "desliga o gate um minutinho". NÃO pega `IF x AND false AND …`; para isso seria
 * preciso avaliar a expressão, e este arquivo é heurística de TEXTO contra regressão ACIDENTAL
 * (ver o cabeçalho). A defesa contra evasão é a asserção EXECUTADA — N1 de
 * db/test-pos-candidatos-guard-temporal.sh roda a RPC como não-staff e exige 42501.
 * Nunca casa `IF NOT COALESCE(gate(), false)`: ali o `false` é argumento, não cabeça da condição.
 */
function raiseInIfBlock(b: string, from: number): boolean {
  const seg = b.slice(from, from + 800);
  const then = /\bthen\b/i.exec(seg);
  if (!then) return false;
  const ifIdx = aberturaDoIf(b, from);
  if (ifIdx !== -1 && CABECA_CONSTANTE_FALSA.test(b.slice(ifIdx, from))) return false; // ramo morto
  const after = seg.slice(then.index + then[0].length);
  const endif = /\bend\s+if\b/i.exec(after);
  const block = endif ? after.slice(0, endif.index) : after.slice(0, 300);
  return /\braise\s+exception\b/i.test(block);
}

/**
 * forma de bloqueio deny-if-false: o gate NEGADO leva a RAISE EXCEPTION no MESMO bloco IF.
 * Reconhece as formas comuns de negação (challenge Codex ×3):
 *   `NOT [schema.]gate(…)` · gate dentro de `NOT ( … )` · `gate(…) IS NOT TRUE` · `IS FALSE` ·
 *   `= false` · `IS DISTINCT FROM TRUE`. Usa o escopo do parêntese (não janela fixa), então rejeita
 *   `NOT outra_coisa AND gate()` / `NOT (x IS NULL) AND gate()` (guard invertido) e não tem
 *   falso-positivo em gate verboso. Exige RAISE EXCEPTION antes do END IF (não NOTICE, não RETURN).
 */
export function blocksOnCall(bodyRaw: string, call: string): boolean {
  // desembrulha ANTES de medir: os 3 passos abaixo dependem de adjacência textual, e o wrapper
  // `(SELECT …)` do idioma initplan a quebra sem mudar a semântica. Ver unwrapSelectScalar.
  const b = unwrapSelectScalar(bodyRaw.toLowerCase());
  const gate = escapeRe(call.toLowerCase());
  const gateCallRe = new RegExp(`(?:\\w+\\.)?${gate}\\s*\\(`, 'i');
  const negEnds: number[] = [];

  // (a) NOT [schema.]gate(
  for (const m of b.matchAll(new RegExp(`\\bnot\\s+(?:\\w+\\.)?${gate}\\s*\\(`, 'gi'))) {
    negEnds.push(callClose(b, m.index! + m[0].length - 1));
  }
  // (b) gate dentro de NOT ( … )
  for (const m of b.matchAll(/\bnot\s*\(/gi)) {
    const open = m.index! + m[0].length - 1;
    const inner = balancedParens(b, open);
    if (gateCallRe.test(inner)) negEnds.push(open + inner.length + 2);
  }
  // (c) gate(…) IS NOT TRUE | IS FALSE | = false | IS DISTINCT FROM TRUE
  for (const m of b.matchAll(new RegExp(gateCallRe.source, 'gi'))) {
    const close = callClose(b, m.index! + m[0].length - 1);
    const tail = b.slice(close, close + 40).replace(/^\s+/, '');
    if (/^(?:is\s+not\s+true|is\s+false|=\s*false|is\s+distinct\s+from\s+true)/i.test(tail)) {
      negEnds.push(close);
    }
  }

  return negEnds.some((pos) => raiseInIfBlock(b, pos));
}

export function checkGate(body: string, req: RequiredGate): GateResult {
  const isAll = Boolean(req.allOf);
  const clauses = req.allOf ?? req.anyOf ?? [];

  if (isAll) {
    const missing: string[] = [];
    const weak: string[] = [];
    for (const cl of clauses) {
      if (!hasGateCall(body, cl.call)) missing.push(cl.call);
      else if (!blocksOnCall(body, cl.call)) weak.push(cl.call);
    }
    return { ok: missing.length === 0 && weak.length === 0, missing, weak };
  }

  const present = clauses.filter((cl) => hasGateCall(body, cl.call)).map((cl) => cl.call);
  const blocking = present.filter((call) => blocksOnCall(body, call));
  if (blocking.length > 0) return { ok: true, missing: [], weak: [] };
  if (present.length > 0) return { ok: false, missing: [], weak: present };
  return { ok: false, missing: clauses.map((c) => c.call), weak: [] };
}

export function touchesSensitive(text: string): string[] {
  const b = text.toLowerCase();
  const hits = new Set<string>();
  for (const t of SENSITIVE_TABLES) if (b.includes(t)) hits.add(t);
  for (const w of SENSITIVE_COLUMNS) if (new RegExp(`\\b${escapeRe(w)}\\b`).test(b)) hits.add(w);
  return [...hits];
}

/** o texto bruto de uma função não-parseável é uma SECDEF que toca dado sensível? (fail-closed) */
export function rawIsSensitiveSecdef(raw: string): string[] {
  if (!/\bSECURITY\s+DEFINER\b/i.test(raw)) return [];
  return touchesSensitive(stripNoise(raw));
}
