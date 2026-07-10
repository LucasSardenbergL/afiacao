/**
 * authz-contract.ts — parser heurístico p/ o gate de autorização de funções SECURITY DEFINER.
 * ============================================================================================
 *
 * Fundação do check anti-regressão de gate (scripts/authz-gate-check.ts, chip task_fc0cc5bd,
 * follow-up do PR #1264). Lê o TEXTO das migrations — não o banco — porque o bug é "alguém
 * recriou a função sem o gate" e o detector barato é ler o SQL que entra no repo.
 * Decisão de arquitetura: Codex consult + challenge (2026-07-09), spec em
 * docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md.
 *
 * Heurístico (regex sobre corpo dollar/single-quoted), como o migration-objects.ts. Extrai o
 * corpo, remove comentários e mascara string-literais ANTES de procurar gate/tabela (senão um
 * `RAISE 'erro em inventory_position'` ou uma chamada em comentário viram falso-positivo).
 * Endurecido pelo challenge Codex: guard-shape exige NOT-do-gate + RAISE EXCEPTION (rejeita
 * `IS NOT NULL AND gate` e `RAISE NOTICE`); suporta quoted identifiers, corpo single-quoted e
 * `SECURITY DEFINER` depois do `AS`; um `CREATE FUNCTION` que o parser não consegue extrair vira
 * `unparsed` (o check trata como fail-closed) em vez de sumir em silêncio.
 *
 * Limitações conhecidas (v1, por design — ver §"Fora do escopo" do spec): não verifica
 * SET search_path, GRANT/REVOKE/PUBLIC-default, tabela sensível via view/helper/SQL dinâmico,
 * ALTER/DROP FUNCTION, nem o enfraquecimento das próprias funções-gate. Não valida os ROLES
 * específicos de has_role (só a presença do gate em forma de bloqueio).
 */
import { balancedParens, normalizeSignature } from './migration-objects';

/** tabelas de custo/preço/estoque (match por substring) */
export const SENSITIVE_TABLES = ['inventory_position', 'product_costs', 'sku_estoque_atual'];
/** colunas/conceitos sensíveis (match por palavra isolada, p/ não casar substrings inocentes) */
export const SENSITIVE_COLUMNS = ['cmc', 'custo', 'preco', 'cost_price', 'unit_price'];

export interface FunctionDef {
  schema: string;
  name: string;
  /** assinatura normalizada (lista de args) — distingue overloads */
  signature: string;
  /** `function:schema.name(signature)` — chave estável, mesma família do objectKey */
  key: string;
  securityDefiner: boolean;
  /** corpo executável: comentários removidos, string-literais mascaradas */
  body: string;
  /** cabeçalho entre os args e o `AS <corpo>` (LANGUAGE/volatilidade/SECURITY/SET) */
  header: string;
}
/** um CREATE FUNCTION detectado mas cujo corpo o parser não conseguiu extrair (fail-closed) */
export interface UnparsedFn {
  schema: string;
  name: string;
}
export interface ExtractResult {
  defs: FunctionDef[];
  unparsed: UnparsedFn[];
}

export interface GateClause {
  /** nome da função-gate esperada (ex.: 'pode_ver_carteira_completa', 'has_role') */
  call: string;
  /** roles esperados quando call === 'has_role' (documental na v1; não bloqueante) */
  roles?: string[];
}
export interface RequiredGate {
  allOf?: GateClause[];
  anyOf?: GateClause[];
}
export interface GateResult {
  ok: boolean;
  /** funções-gate esperadas AUSENTES do corpo executável */
  missing: string[];
  /** funções-gate presentes mas NÃO em forma de bloqueio deny-if-false */
  weak: string[];
}

/** remove comentários (linha/bloco) e mascara string-literais → '' */
export function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** remove aspas de um identificador quoted ("Foo" → foo) e normaliza p/ lowercase */
function unquoteIdent(raw: string | undefined): string {
  if (!raw) return '';
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').toLowerCase();
  return t.toLowerCase();
}

/** fim de um corpo single-quoted: próximo "'" que não seja o escape "''" */
function singleQuoteEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const q = s.indexOf("'", i);
    if (q === -1) return -1;
    if (s[q + 1] === "'") {
      i = q + 2; // '' escapado
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
 * O regex avança para depois de cada corpo, evitando re-match de CREATE FUNCTION aninhado/textual.
 */
export function extractFunctions(sql: string): ExtractResult {
  const defs: FunctionDef[] = [];
  const unparsed: UnparsedFn[] = [];
  FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_RE.exec(sql)) !== null) {
    const schema = unquoteIdent(m[1]) || 'public';
    const name = unquoteIdent(m[2]);
    const parenIdx = m.index + m[0].length - 1; // no '(' de abertura dos args
    const args = balancedParens(sql, parenIdx);
    const signature = normalizeSignature(args);
    const afterArgs = parenIdx + args.length + 2; // logo após o ')' dos args
    const rest = sql.slice(afterArgs);

    // corpo: `AS $tag$…$tag$` (dollar-quoted) OU `AS '…'` (single-quoted)
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
      unparsed.push({ schema, name }); // fail-closed: registra, não some em silêncio
      continue;
    }

    const header = rest.slice(0, headerEndRel);
    const semi = sql.indexOf(';', bodyEndAbs);
    const trailer = sql.slice(bodyEndAbs, semi === -1 ? sql.length : semi); // opções pós-AS (LANGUAGE/SECURITY)
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

/** compat: só as defs parseadas (usado por testes unitários simples) */
export function extractFunctionDefs(sql: string): FunctionDef[] {
  return extractFunctions(sql).defs;
}

/** a chamada da função-gate aparece no corpo executável (presença) */
export function hasGateCall(body: string, call: string): boolean {
  return body.toLowerCase().includes(call.toLowerCase() + '(');
}

/**
 * forma de bloqueio deny-if-false: `… NOT … <gate>( … ) … THEN … RAISE EXCEPTION`.
 * Endurecido (challenge Codex): neutraliza o NOT de `IS NOT [NULL]` (senão `IF v_uid IS NOT NULL
 * AND gate() THEN RAISE` — guard INVERTIDO — casaria); exige `RAISE EXCEPTION`, não `RAISE NOTICE`.
 * O gate deve vir DEPOIS de um NOT e ANTES do THEN…RAISE EXCEPTION.
 */
export function blocksOnCall(bodyRaw: string, call: string): boolean {
  const c = escapeRe(call.toLowerCase());
  const b = bodyRaw.toLowerCase().replace(/\bis\s+not\b/g, 'is§'); // «IS NOT» não é negação do gate
  const re = new RegExp(`\\bnot\\b[\\s\\S]{0,160}?${c}\\s*\\([\\s\\S]{0,320}?\\bthen\\b[\\s\\S]{0,180}?\\braise\\s+exception\\b`, 'i');
  return re.test(b);
}

/**
 * avalia o requiredGate contra o corpo executável.
 *  - allOf: cada função-gate deve estar presente (ausente → missing) e em forma de bloqueio
 *    (presente-sem-bloqueio → weak).
 *  - anyOf: basta 1 em forma de bloqueio → ok sem ruído. Se alguma está presente mas NENHUMA
 *    bloqueia → ok=false via weak (o consumidor decide; p/ função do manifest o check trata
 *    weak como erro — "gate decorativo não protege"). Nenhuma presente → missing.
 */
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

/** tabelas/colunas sensíveis referenciadas no corpo executável */
export function touchesSensitive(body: string): string[] {
  const b = body.toLowerCase();
  const hits = new Set<string>();
  for (const t of SENSITIVE_TABLES) if (b.includes(t)) hits.add(t);
  for (const w of SENSITIVE_COLUMNS) if (new RegExp(`\\b${escapeRe(w)}\\b`).test(b)) hits.add(w);
  return [...hits];
}
