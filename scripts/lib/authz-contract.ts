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
 *
 * Limitações conhecidas (v1 — ver §"Fora do escopo" do spec): não verifica SET search_path,
 * GRANT/REVOKE/PUBLIC-default, tabela sensível via view/helper/SQL dinâmico, ALTER/DROP FUNCTION,
 * enfraquecimento das próprias funções-gate, nem deny-por-RETURN (o contrato exige RAISE EXCEPTION).
 */
import { balancedParens, normalizeSignature } from './migration-objects';

export const SENSITIVE_TABLES = ['inventory_position', 'product_costs', 'sku_estoque_atual'];
export const SENSITIVE_COLUMNS = ['cmc', 'custo', 'preco', 'cost_price', 'unit_price'];

export interface FunctionDef {
  schema: string;
  name: string;
  signature: string;
  key: string;
  securityDefiner: boolean;
  body: string;
  header: string;
}
/** um CREATE FUNCTION detectado mas cujo corpo o parser não extraiu — com o texto bruto p/ fail-closed */
export interface UnparsedFn {
  schema: string;
  name: string;
  raw: string;
}
export interface ExtractResult {
  defs: FunctionDef[];
  unparsed: UnparsedFn[];
}

export interface GateClause {
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

export function hasGateCall(body: string, call: string): boolean {
  return body.toLowerCase().includes(call.toLowerCase() + '(');
}

/**
 * forma de bloqueio deny-if-false: o gate NEGADO leva a RAISE EXCEPTION.
 * O gate conta como negado se (a) `NOT [schema.]gate(` direto, ou (b) dentro do grupo balanceado
 * de um `NOT ( … )`. Usa o escopo do parêntese (não janela fixa) → rejeita `NOT outra_coisa AND
 * gate()` e `NOT (x IS NULL) AND gate()` (guard invertido), e não tem falso-positivo em gate
 * verboso. Depois da negação, exige `THEN … RAISE EXCEPTION` (não NOTICE, não RETURN).
 */
export function blocksOnCall(bodyRaw: string, call: string): boolean {
  const b = bodyRaw.toLowerCase();
  const gate = escapeRe(call.toLowerCase());
  const gateCallRe = new RegExp(`(?:\\w+\\.)?${gate}\\s*\\(`, 'i');
  const raiseAfter = (from: number): boolean => /\bthen\b[\s\S]{0,240}?\braise\s+exception\b/i.test(b.slice(from, from + 600));

  // (a) NOT [schema.]gate( direto
  const directRe = new RegExp(`\\bnot\\s+(?:\\w+\\.)?${gate}\\s*\\(`, 'gi');
  for (const m of b.matchAll(directRe)) {
    if (raiseAfter(m.index! + m[0].length)) return true;
  }
  // (b) NOT ( … gate( … ) — gate dentro do grupo balanceado do NOT
  const notParenRe = /\bnot\s*\(/gi;
  for (const m of b.matchAll(notParenRe)) {
    const openParen = m.index! + m[0].length - 1;
    const inner = balancedParens(b, openParen);
    if (gateCallRe.test(inner) && raiseAfter(openParen + inner.length + 2)) return true;
  }
  return false;
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
