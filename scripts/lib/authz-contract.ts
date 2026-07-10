/**
 * authz-contract.ts — parser heurístico p/ o gate de autorização de funções SECURITY DEFINER.
 * ============================================================================================
 *
 * Fundação do check anti-regressão de gate (scripts/authz-gate-check.ts, chip task_fc0cc5bd,
 * follow-up do PR #1264). Lê o TEXTO das migrations — não o banco — porque o bug é "alguém
 * recriou a função sem o gate" e o detector barato é ler o SQL que entra no repo.
 * Decisão de arquitetura: Codex consult (2026-07-09), spec em
 * docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md.
 *
 * Heurístico (regex sobre corpo dollar-quoted), como o migration-objects.ts. Extrai o corpo,
 * remove comentários e mascara string-literais ANTES de procurar gate/tabela (senão um
 * `RAISE 'erro em inventory_position'` ou uma chamada em comentário viram falso-positivo).
 *
 * Limitações conhecidas (v1, por design — ver §"Fora do escopo" do spec): não verifica
 * SET search_path, GRANT/REVOKE/PUBLIC-default, tabela sensível via view/helper/SQL dinâmico,
 * ALTER/DROP FUNCTION, nem o enfraquecimento das próprias funções-gate. Não valida os ROLES
 * específicos de has_role (só a presença do gate em forma de bloqueio). Calibração:
 * minimizar FALSO-NEGATIVO (bloquear PR legítimo) — bloqueia na AUSÊNCIA da chamada do gate
 * (o bug real = remoção); forma-de-bloqueio ausente com a chamada presente vira WEAK (aviso),
 * não erro.
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
  /** cabeçalho entre os args e o `AS $tag$` (LANGUAGE/volatilidade/SECURITY/SET) */
  header: string;
}

export interface GateClause {
  /** nome da função-gate esperada (ex.: 'pode_ver_carteira_completa', 'has_role') */
  call: string;
  /** roles esperados quando call === 'has_role' (documental na v1; não bloqueante) */
  roles?: string[];
}
export interface RequiredGate {
  /** todas as cláusulas devem estar presentes */
  allOf?: GateClause[];
  /** pelo menos uma cláusula presente */
  anyOf?: GateClause[];
}
export interface GateResult {
  ok: boolean;
  /** funções-gate esperadas AUSENTES do corpo executável (erro → bloqueia) */
  missing: string[];
  /** funções-gate presentes mas NÃO em forma de bloqueio deny-if-false (aviso) */
  weak: string[];
}

/** remove comentários (linha/bloco) e mascara string-literais → '' */
export function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // comentário de bloco
    .replace(/--[^\n]*/g, ' ') // comentário de linha
    .replace(/'(?:[^']|'')*'/g, "''"); // string-literal → vazia
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extrai as definições de função de um SQL, com o corpo dollar-quoted já limpo.
 * O regex avança para depois de cada corpo, evitando re-match de CREATE FUNCTION aninhado.
 */
export function extractFunctionDefs(sql: string): FunctionDef[] {
  const defs: FunctionDef[] = [];
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(sql)) !== null) {
    const schema = (m[1] || 'public').toLowerCase();
    const name = m[2].toLowerCase();
    const parenIdx = m.index + m[0].length - 1; // no '(' de abertura dos args
    const args = balancedParens(sql, parenIdx);
    const signature = normalizeSignature(args);
    const afterArgs = parenIdx + args.length + 2; // logo após o ')' dos args
    const rest = sql.slice(afterArgs);
    const dq = /\bAS\s+(\$\w*\$)/i.exec(rest); // dollar-quote de abertura do corpo
    if (!dq) continue;
    const header = rest.slice(0, dq.index);
    const tag = dq[1];
    const bodyStart = afterArgs + dq.index + dq[0].length;
    const bodyEnd = sql.indexOf(tag, bodyStart); // fechamento (PG proíbe mesmo tag aninhado)
    if (bodyEnd === -1) continue;
    const rawBody = sql.slice(bodyStart, bodyEnd);
    defs.push({
      schema,
      name,
      signature,
      key: `function:${schema}.${name}(${signature})`,
      securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(header),
      body: stripNoise(rawBody),
      header: stripNoise(header),
    });
    fnRe.lastIndex = bodyEnd + tag.length;
  }
  return defs;
}

/** a chamada da função-gate aparece no corpo executável (presença) */
export function hasGateCall(body: string, call: string): boolean {
  return body.toLowerCase().includes(call.toLowerCase() + '(');
}

/**
 * forma de bloqueio deny-if-false: `IF … NOT … <gate>( … ) … THEN … RAISE`.
 * Tolerante ao COALESCE/OR/AND entre os tokens; case-insensitive. Não casa a mensagem.
 */
export function blocksOnCall(body: string, call: string): boolean {
  const c = escapeRe(call.toLowerCase());
  const re = new RegExp(`\\bif\\b[\\s\\S]{0,300}?\\bnot\\b[\\s\\S]{0,300}?${c}\\s*\\([\\s\\S]{0,400}?\\bthen\\b[\\s\\S]{0,200}?\\braise\\b`, 'i');
  return re.test(body.toLowerCase());
}

/**
 * avalia o requiredGate contra o corpo executável.
 *  - allOf: cada função-gate deve estar presente (ausente → missing/erro) e idealmente em forma
 *    de bloqueio (presente-sem-bloqueio → weak/aviso).
 *  - anyOf: basta 1 em forma de bloqueio → ok sem ruído (as outras podem ser uso-p/-detalhe, ex.
 *    pode_ver_carteira_completa decidindo mascaramento e não acesso). Se alguma está presente mas
 *    NENHUMA bloqueia → ok+weak (evita falso-negativo; sinaliza forma estranha). Nenhuma presente
 *    → missing/erro (o gate sumiu = o bug que o check existe p/ matar).
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
    return { ok: missing.length === 0, missing, weak };
  }

  const present = clauses.filter((cl) => hasGateCall(body, cl.call)).map((cl) => cl.call);
  const blocking = present.filter((call) => blocksOnCall(body, call));
  if (blocking.length > 0) return { ok: true, missing: [], weak: [] };
  if (present.length > 0) return { ok: true, missing: [], weak: present };
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
