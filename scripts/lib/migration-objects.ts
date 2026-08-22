/**
 * migration-objects.ts — extração de objetos SQL criados por uma migration + chave de colisão.
 * ============================================================================================
 *
 * Fundação compartilhada de:
 *  - scripts/audit-custom-migrations.ts  (inventário "o que cada migration cria")
 *  - scripts/wt-preflight-migration.ts   (detecta 2 migrations recriando o MESMO objeto)
 *
 * Heurístico (regex), não parser SQL completo — cobre os patterns do projeto. Acréscimos
 * sobre o extractObjects original (pedidos pelo Codex):
 *  - `view`  — o audit não detectava CREATE [OR REPLACE] [MATERIALIZED] VIEW (views v_grupo_*).
 *  - limpeza de comentário pelo stripper COMPARTILHADO `sql-comentarios.ts` — ver extractObjects.
 *  - assinatura de função — identidade PG = nome + tipos de arg; sem isso, overloads colidiriam
 *    falsamente (foo(int) vs foo(text)).
 *
 * Limitações conhecidas (fase 1, por design): não vê ALTER TABLE/FUNCTION, DROP+CREATE,
 * grants, nem SQL dinâmico; a assinatura é a lista de args normalizada (renomear param muda a
 * chave). O preflight degrada para "não detectado", nunca fabrica colisão.
 */

import { removerComentariosSql } from './sql-comentarios';

export type ObjectKind = 'table' | 'index' | 'function' | 'trigger' | 'cron_job' | 'enum_value' | 'rls_policy' | 'view';

export interface ExtractedObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  /** trigger/rls_policy: a tabela. enum_value: o nome do enum. */
  parent?: string;
  /** function: assinatura normalizada (lista de args) — distingue overloads. */
  signature?: string;
}

/** split por vírgula no nível 0 de parênteses (preserva numeric(10,2) etc.) */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** conteúdo entre o primeiro '(' em/após `from` e seu ')' correspondente (balanceado) */
export function balancedParens(s: string, from: number): string {
  const start = s.indexOf('(', from);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return '';
}

/** normaliza a assinatura de função para comparação de identidade (tipos de arg) */
export function normalizeSignature(argsRaw: string): string {
  return splitTopLevel(argsRaw)
    .map((a) =>
      a
        .replace(/\bDEFAULT\b[\s\S]*$/i, '')
        .replace(/=[\s\S]*$/, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean)
    .join(',');
}

/**
 * Extrai os objetos criados por uma migration.
 *
 * A limpeza de comentário é a COMPARTILHADA (`removerComentariosSql`), que entende a gramática do
 * Postgres. O `sql.replace(/--.*$/gm, '')` que morava aqui errava nos dois sentidos — a classe de
 * `docs/historico/gates-textuais-cegos.md`, aqui no eixo SQL:
 *  - comia de um `--` DENTRO de literal ou de identificador citado até o fim da linha, e a DDL
 *    seguinte sumia do inventário (ausência, o pior modo de falha de um audit);
 *  - não removia comentário de BLOCO, então DDL comentada para rollback entrava como objeto
 *    esperado — vermelho eterno, porque o banco nunca vai tê-la.
 * Medido no corpus de 483 migrations custom ao trocar: delta ZERO (1671 objetos antes e depois).
 * É endurecimento, não correção de falha ativa. Casos em migration-objects.test.ts.
 */
export function extractObjects(sql: string): ExtractedObject[] {
  const stripped = removerComentariosSql(sql);
  const objects: ExtractedObject[] = [];

  // CREATE [OR REPLACE] FUNCTION [schema.]name(args) — captura args via parênteses balanceados
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\(/gi;
  for (const m of stripped.matchAll(fnRe)) {
    const args = balancedParens(stripped, m.index! + m[0].length - 1);
    objects.push({ kind: 'function', schema: m[1] || 'public', name: m[2], signature: normalizeSignature(args) });
  }

  // CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] [schema.]name
  const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(viewRe)) {
    objects.push({ kind: 'view', schema: m[1] || 'public', name: m[2] });
  }

  // CREATE TABLE [IF NOT EXISTS] [schema.]name (
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s*\(/gi;
  for (const m of stripped.matchAll(tableRe)) {
    objects.push({ kind: 'table', schema: m[1] || 'public', name: m[2] });
  }

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [schema.]table
  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(indexRe)) {
    objects.push({ kind: 'index', schema: m[2] || 'public', name: m[1], parent: m[3] });
  }

  // CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name ... ON [schema.]table
  const trigRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)[\s\S]*?ON\s+(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(trigRe)) {
    objects.push({ kind: 'trigger', schema: m[2] || 'public', name: m[1], parent: m[3] });
  }

  // SELECT cron.schedule('jobname', ...)
  const cronRe = /cron\.schedule\s*\(\s*'([^']+)'/gi;
  for (const m of stripped.matchAll(cronRe)) {
    objects.push({ kind: 'cron_job', schema: 'cron', name: m[1] });
  }

  // ALTER TYPE [schema.]enum ADD VALUE [IF NOT EXISTS] 'value'
  const enumRe = /ALTER\s+TYPE\s+(?:(\w+)\.)?(\w+)\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
  for (const m of stripped.matchAll(enumRe)) {
    objects.push({ kind: 'enum_value', schema: m[1] || 'public', name: m[3], parent: m[2] });
  }

  // CREATE POLICY [IF NOT EXISTS] "nome com espaço"|nome ON [schema.]table
  // O nome CITADO é a forma majoritária no corpus e a classe `[^\s"]+` parava no 1º espaço:
  // 11% das policies sumiam do inventário (viravam AUSÊNCIA, não vermelho). Capturas aceitam
  // `%` só para RECONHECER a DDL gerada por `EXECUTE format(...)` e DESCARTÁ-LA — `%I` como
  // nome esperado é vermelho eterno; o certo é não inventariar. Ver migration-objects.test.ts.
  const policyRe = /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([\w%]+))\s+ON\s+(?:([\w%]+)\.)?([\w%]+)/gi;
  for (const m of stripped.matchAll(policyRe)) {
    const name = m[1] ?? m[2];
    const schema = m[3] || 'public';
    const parent = m[4];
    if ([name, schema, parent].some((s) => s.includes('%'))) continue;
    objects.push({ kind: 'rls_policy', schema, name, parent });
  }

  // dedupe por chave de colisão (IF NOT EXISTS pode repetir o mesmo objeto)
  const seen = new Set<string>();
  return objects.filter((o) => {
    const k = objectKey(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Chave estável de colisão. Dois objetos com a MESMA chave em migrations diferentes = a
 * "última a rodar vence" sobrescreve a outra. Function inclui assinatura (overloads são
 * objetos distintos); trigger/policy são por-tabela; enum_value é por-enum.
 */
export function objectKey(o: ExtractedObject): string {
  const base = `${o.schema}.${o.name}`;
  switch (o.kind) {
    case 'function':
      return `function:${base}(${o.signature ?? ''})`;
    case 'trigger':
      return `trigger:${o.schema}.${o.parent}.${o.name}`;
    case 'rls_policy':
      return `rls_policy:${o.schema}.${o.parent}.${o.name}`;
    case 'enum_value':
      return `enum_value:${o.schema}.${o.parent}:${o.name}`;
    case 'cron_job':
      return `cron_job:${o.name}`;
    default:
      return `${o.kind}:${base}`;
  }
}
