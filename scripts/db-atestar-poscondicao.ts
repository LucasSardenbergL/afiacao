#!/usr/bin/env bun
/**
 * db-atestar-poscondicao.ts — a PÓS-CONDIÇÃO read-only de uma migration aplicada FORA do envelope.
 * ============================================================================================
 *
 * ## Por que existe (rodada 2 do vigia do Publish, M2)
 *
 * O vigia só libera o front por migration quando há recibo `aplicada` em `public.db_aplicacoes` —
 * e só o `bun run db:aplicar` grava recibo. Migration colada no SQL Editor (ou aplicada pelo MCP)
 * nunca ganha recibo, e o front fica RETIDO até alguém gravar `liberar` à mão (5 de 5 episódios
 * RETIDO de 22–27/11 terminaram com Publish por fora). O `db:aplicar --atestar` fecha esse buraco
 * SEM virar declaração pura: o recibo só nasce depois que o BANCO mostra os objetos que a
 * migration cria — e, para função, o CORPO byte a byte (`md5(prosrc)`), porque função que existe
 * com o corpo VELHO é exatamente o drift que um "existe?" deixaria passar.
 *
 * ## O que este módulo faz
 *
 * Lê o `.sql`, separa os comandos (respeitando comentário, string e dollar-quote) e classifica cada
 * um. Os que ele sabe PROVAR viram uma linha de checagem SQL que imprime `OK <objeto>` ou
 * `FALTA <objeto>`; os que ele NÃO sabe provar (DML, GRANT/REVOKE, DO, DROP, `SELECT cron.*`…) saem
 * listados como `NAO_PROVAVEL`, e o `--atestar` recusa — a menos que venha um `--pos <arquivo>`
 * commitado com a prova escrita à mão (que precisa imprimir `POSCONDICAO_OK`).
 *
 * Fail-closed por construção: o que não casa um padrão conhecido é NAO_PROVAVEL, nunca "ignorado".
 * As únicas exceções explícitas são o envelope da migration de SQL Editor (`BEGIN`/`COMMIT`) e
 * `COMMENT ON` — metadado que não muda comportamento.
 *
 * Uso: bun scripts/db-atestar-poscondicao.ts <arquivo.sql> [--dos <dir>]
 *   --dos <dir>: cada bloco DO vai para <dir>/do-NNN.sql (o db-aplicar roda cada um na sessão READ ONLY)
 *   stdout: o SQL da pós-condição (para o psql-ro), terminando em `POSCONDICAO_FIM`
 *   stderr: `NAO_PROVAVEL <comando resumido>` por comando sem prova automática
 *   exit: 0 = tudo provável · 3 = há NAO_PROVAVEL (o SQL sai mesmo assim) · 2 = mecânica
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Checagem = { objeto: string; sql: string };
export type Acl = { tipo: 'acl'; grant: boolean; kind: 'f' | 'r'; obj: string; roles: string[]; privs: string[] };
export type Drop = { tipo: 'drop'; chave: string; checagem: Checagem };
export type Classificacao =
  | { tipo: 'checagens'; checagens: Checagem[]; cria?: string[] }
  | { tipo: 'ignorado'; motivo: string }
  | { tipo: 'do'; corpo: string }
  | Acl
  | Drop
  | { tipo: 'nao_provavel'; resumo: string };

/** Separa o arquivo em comandos, sem comentários, respeitando '…', "…" e $tag$…$tag$. */
export function separarComandos(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++;
      cur += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      let prof = 1;
      i += 2;
      while (i < n && prof > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { prof++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { prof--; i += 2; continue; }
        i++;
      }
      cur += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const fim = sql.indexOf(tag, i + tag.length);
        if (fim < 0) throw new Error(`dollar-quote ${tag} sem fechamento`);
        cur += sql.slice(i, fim + tag.length);
        i = fim + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** literal SQL seguro */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNOME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

/** identificador como o catálogo o guarda: sem aspas preserva caixa; sem aspas, minúsculo */
function ident(s: string): string {
  const t = s.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}

/** `a.b` → [schema, nome] (schema default public) */
export function qualificar(q: string): [string, string] {
  const partes: string[] = [];
  const re = new RegExp(IDENT, 'g');
  for (const m of q.matchAll(re)) partes.push(ident(m[0]));
  return partes.length === 2 ? [partes[0], partes[1]] : ['public', partes[0]];
}

/** tipos de uma assinatura, sem nomes de parâmetro/DEFAULT, minúsculos e com espaço único — chave de comparação */
export function normSig(args: string): string {
  return virgulasDeTopo(args)
    .map((a) => a.replace(/\s+DEFAULT\s+.*$/i, '').replace(/\s*=\s*.*$/, '').trim())
    .filter(Boolean)
    .map((a) => {
      const t = a.replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '').split(/\s+/);
      // `nome tipo…` → `tipo…` (o 1º token é nome quando há mais de um e não é um tipo composto conhecido)
      const tipos = new Set(['double', 'character', 'timestamp', 'time', 'bit']);
      return (t.length > 1 && !tipos.has(t[0].toLowerCase()) ? t.slice(1) : t).join(' ').toLowerCase();
    })
    .join(', ');
}
/** `public.f(a uuid, b jsonb)` → `public.f(uuid, jsonb)`, o texto que o to_regprocedure entende */
export function sigCanon(alvo: string): string {
  const m = /^(.*?)\s*\((.*)\)$/.exec(alvo.trim());
  if (!m) return alvo.trim();
  const [s, n] = qualificar(m[1]);
  return `${s}.${n}(${normSig(m[2])})`;
}

function md5(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

/** divide por vírgula de topo (fora de parênteses e de string) */
function virgulasDeTopo(s: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let cur = '';
  let q: string | null = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(') prof++;
    if (c === ')') prof--;
    if (c === ',' && prof === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const regclass = (s: string, n: string, obj: string, kind: string): Checagem => ({
  objeto: `${obj} ${s}.${n}`,
  sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(n)} AND c.relkind IN (${kind})) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(`${obj} ${s}.${n}`)}`,
});

export function classificar(cmd: string): Classificacao {
  const norm = cmd.replace(/\s+/g, ' ').trim();
  const resumo = norm.slice(0, 120);
  let m: RegExpExecArray | null;

  if (/^(BEGIN|COMMIT|START TRANSACTION)( (WORK|TRANSACTION))?$/i.test(norm)) return { tipo: 'ignorado', motivo: 'envelope de transação' };
  if (/^COMMENT ON /i.test(norm)) return { tipo: 'ignorado', motivo: 'COMMENT ON (metadado)' };

  // FUNÇÃO: o corpo tem de ser o MESMO (md5 do prosrc) — "existe" não prova (corpo velho é o drift)
  m = new RegExp(String.raw`^CREATE (?:OR REPLACE )?FUNCTION ${QNOME}\s*\(`, 'i').exec(norm);
  if (m) {
    const [s, n] = qualificar(m[1]);
    // o corpo, do comando ORIGINAL (não normalizado): AS $tag$ … $tag$
    const b = /\bAS\s+(\$([A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*?)\1/i.exec(cmd);
    if (!b) return { tipo: 'nao_provavel', resumo: `${resumo} (função sem corpo dollar-quoted)` };
    const obj = `funcao ${s}.${n} corpo md5=${md5(b[3]).slice(0, 12)}`;
    const sig = new RegExp(String.raw`^CREATE (?:OR REPLACE )?FUNCTION ${QNOME}\s*\(([^)]*)\)`, 'i').exec(norm);
    return {
      tipo: 'checagens',
      cria: [`funcao:${s}.${n}`, ...(sig ? [`funcao:${s}.${n}(${normSig(sig[2])})`] : [])],
      checagens: [{
        objeto: obj,
        sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = ${lit(s)} AND p.proname = ${lit(n)} AND md5(p.prosrc) = ${lit(md5(b[3]))}) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}`,
      }],
    };
  }
  m = new RegExp(String.raw`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?${QNOME}`, 'i').exec(norm);
  if (m) {
    const [s, n] = qualificar(m[1]);
    return { tipo: 'checagens', checagens: [regclass(s, n, 'tabela', "'r','p'")], cria: [`rel:${s}.${n}`] };
  }
  m = new RegExp(String.raw`^CREATE (?:OR REPLACE )?VIEW ${QNOME}`, 'i').exec(norm);
  if (m) {
    const [s, n] = qualificar(m[1]);
    const ch: Checagem[] = [regclass(s, n, 'view', "'v'")];
    // `security_invoker` omitido num replace RESETA a opção (CLAUDE.md): se o arquivo a declara, o banco tem de tê-la
    const si = /security_invoker\s*=\s*(on|true|off|false)/i.exec(norm);
    if (si) {
      const v = /^(on|true)$/i.test(si[1]) ? 'true' : 'false';
      const obj = `view ${s}.${n} security_invoker=${v}`;
      ch.push({
        objeto: obj,
        sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(n)} AND coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), 'false') IN (${v === 'true' ? "'true','on'" : "'false','off'"})) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}`,
      });
    }
    return { tipo: 'checagens', checagens: ch, cria: [`rel:${s}.${n}`] };
  }
  m = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(${IDENT}) ON (?:ONLY )?${QNOME}`, 'i').exec(norm);
  if (m) {
    const [s] = qualificar(m[2]);
    const n = ident(m[1]);
    // VÁLIDO: um CREATE INDEX CONCURRENTLY que falha deixa o índice INVÁLIDO para trás (existe, não serve)
    const obj = `indice ${s}.${n} valido`;
    return {
      tipo: 'checagens',
      cria: [`rel:${s}.${n}`],
      checagens: [{ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace JOIN pg_index x ON x.indexrelid = c.oid WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(n)} AND x.indisvalid) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` }],
    };
  }
  m = new RegExp(String.raw`^CREATE POLICY (${IDENT}) ON ${QNOME}`, 'i').exec(norm);
  if (m) {
    const [s, t] = qualificar(m[2]);
    const p = ident(m[1]);
    const obj = `policy ${p} em ${s}.${t}`;
    return {
      tipo: 'checagens',
      cria: [`policy:${s}.${t}.${p}`],
      checagens: [{ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = ${lit(s)} AND tablename = ${lit(t)} AND policyname = ${lit(p)}) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` }],
    };
  }
  m = new RegExp(String.raw`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER (${IDENT}) .*? ON ${QNOME}`, 'i').exec(norm);
  if (m) {
    const [s, t] = qualificar(m[2]);
    const g = ident(m[1]);
    const obj = `trigger ${g} em ${s}.${t}`;
    return {
      tipo: 'checagens',
      cria: [`trigger:${s}.${t}.${g}`],
      checagens: [{ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(t)} AND tg.tgname = ${lit(g)} AND NOT tg.tgisinternal) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` }],
    };
  }
  if (/^NOTIFY pgrst\b/i.test(norm)) return { tipo: 'ignorado', motivo: 'NOTIFY pgrst (recarga de cache, sem estado)' };
  if (/^SET (LOCAL )?(search_path|statement_timeout|lock_timeout|client_min_messages)\b/i.test(norm)) return { tipo: 'ignorado', motivo: 'SET de sessão' };
  // DO: roda na sessão READ ONLY — bloco idempotente que acha o estado certo não escreve e passa; o que
  // precisaria escrever o próprio banco recusa (cannot execute … in a read-only transaction)
  if (/^DO\b/i.test(norm)) return { tipo: 'do', corpo: cmd };
  m = /^(GRANT|REVOKE) (?:GRANT OPTION FOR )?(.+?) ON (FUNCTION |TABLE )?(.+?) (TO|FROM) (.+?)(?: WITH GRANT OPTION)?(?: CASCADE| RESTRICT)?$/i.exec(norm);
  if (m) {
    const funcao = /^FUNCTION/i.test(m[3] ?? '');
    const alvo = m[4].trim();
    if (/^(ALL (TABLES|FUNCTIONS|SEQUENCES|ROUTINES) IN SCHEMA|SCHEMA|SEQUENCE|PROCEDURE|ROUTINE)\b/i.test(alvo) || /\(/.test(m[2])) {
      return { tipo: 'nao_provavel', resumo };
    }
    if (funcao && !/\(.*\)$/.test(alvo)) return { tipo: 'nao_provavel', resumo: `${resumo} (função sem assinatura)` };
    const roles = virgulasDeTopo(m[6]).map((r) => (/^PUBLIC$/i.test(r) ? 'PUBLIC' : ident(r)));
    const todos = funcao ? ['EXECUTE'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const privs = /^ALL( PRIVILEGES)?$/i.test(m[2].trim()) ? todos : virgulasDeTopo(m[2]).map((x) => x.toUpperCase());
    if (privs.some((x) => !todos.includes(x))) return { tipo: 'nao_provavel', resumo };
    const obj = funcao ? sigCanon(alvo) : (() => { const [a, b2] = qualificar(alvo); return `${a}.${b2}`; })();
    return { tipo: 'acl', grant: /^GRANT/i.test(m[1]), kind: funcao ? 'f' : 'r', obj, roles, privs };
  }
  m = new RegExp(String.raw`^DROP (TRIGGER|POLICY) (?:IF EXISTS )?(${IDENT}) ON ${QNOME}(?: CASCADE| RESTRICT)?$`, 'i').exec(norm);
  if (m) {
    const [s, t] = qualificar(m[3]);
    const nome = ident(m[2]);
    const k = m[1].toUpperCase() === 'TRIGGER' ? 'trigger' : 'policy';
    const obj = `${k} ${nome} em ${s}.${t} ausente`;
    const q = k === 'trigger'
      ? `SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(t)} AND tg.tgname = ${lit(nome)}`
      : `SELECT 1 FROM pg_policies WHERE schemaname = ${lit(s)} AND tablename = ${lit(t)} AND policyname = ${lit(nome)}`;
    return { tipo: 'drop', chave: `${k}:${s}.${t}.${nome}`, checagem: { objeto: obj, sql: `SELECT CASE WHEN NOT EXISTS (${q}) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` } };
  }
  m = new RegExp(String.raw`^DROP FUNCTION (?:IF EXISTS )?${QNOME}\s*\(([^)]*)\)(?: CASCADE| RESTRICT)?$`, 'i').exec(norm);
  if (m) {
    const [s, n] = qualificar(m[1]);
    const sig = `${s}.${n}(${normSig(m[2])})`;
    const obj = `funcao ${sig} ausente`;
    return { tipo: 'drop', chave: `funcao:${sig}`, checagem: { objeto: obj, sql: `SELECT CASE WHEN to_regprocedure(${lit(sigCanon(`${m[1]}(${m[2]})`))}) IS NULL THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` } };
  }
  m = new RegExp(String.raw`^DROP (VIEW|TABLE|INDEX|MATERIALIZED VIEW) (?:IF EXISTS )?${QNOME}(?: CASCADE| RESTRICT)?$`, 'i').exec(norm);
  if (m) {
    const [s, n] = qualificar(m[2]);
    const obj = `${m[1].toLowerCase()} ${s}.${n} ausente`;
    return { tipo: 'drop', chave: `rel:${s}.${n}`, checagem: { objeto: obj, sql: `SELECT CASE WHEN to_regclass(${lit(`"${s}"."${n}"`)}) IS NULL THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` } };
  }
  m = /^CREATE EXTENSION (?:IF NOT EXISTS )?("?[A-Za-z0-9_-]+"?)/i.exec(norm);
  if (m) {
    const e = m[1].replace(/"/g, '');
    const obj = `extensao ${e}`;
    return { tipo: 'checagens', checagens: [{ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = ${lit(e)}) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` }] };
  }
  m = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${QNOME} (.*)$`, 'i').exec(norm);
  if (m) {
    const [s, t] = qualificar(m[1]);
    const ch: Checagem[] = [];
    for (const acao of virgulasDeTopo(m[2])) {
      let a: RegExpExecArray | null;
      if ((a = new RegExp(String.raw`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${IDENT})\s`, 'i').exec(`${acao} `)) && !/^ADD (CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(acao)) {
        const col = ident(a[1]);
        const obj = `coluna ${s}.${t}.${col}`;
        ch.push({ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(t)} AND at.attname = ${lit(col)} AND NOT at.attisdropped) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` });
      } else if ((a = new RegExp(String.raw`^ADD CONSTRAINT (${IDENT})\s`, 'i').exec(`${acao} `))) {
        const k = ident(a[1]);
        const obj = `constraint ${k} em ${s}.${t}`;
        ch.push({ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(t)} AND k.conname = ${lit(k)}) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` });
      } else if (/^ENABLE ROW LEVEL SECURITY$/i.test(acao)) {
        const obj = `rls ligada em ${s}.${t}`;
        ch.push({ objeto: obj, sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = ${lit(s)} AND c.relname = ${lit(t)} AND c.relrowsecurity) THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(obj)}` });
      } else {
        return { tipo: 'nao_provavel', resumo: `${resumo} (ação: ${acao.slice(0, 60)})` };
      }
    }
    return { tipo: 'checagens', checagens: ch };
  }
  return { tipo: 'nao_provavel', resumo };
}

export interface Plano { sql: string; naoProvaveis: string[]; nChecagens: number; dos: string[] }

/** a checagem da ACL FINAL de (objeto, papel, privilégio): entrada direta no aclexplode, não has_*_privilege
 *  (que soma PUBLIC e herança — a pergunta aqui é "o efeito do GRANT/REVOKE está no banco?") */
function checagemAcl(kind: 'f' | 'r', obj: string, role: string, priv: string, esperado: boolean): Checagem {
  const rotulo = `acl ${kind === 'f' ? 'funcao' : 'tabela'} ${obj} ${role} ${priv}=${esperado ? 'sim' : 'nao'}`;
  const oid = kind === 'f' ? `to_regprocedure(${lit(obj)})` : `to_regclass(${lit(obj.split('.').map((x) => `"${x}"`).join('.'))})`;
  const acl = kind === 'f'
    ? `SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = ${oid}`
    : `SELECT 1 FROM pg_class p, aclexplode(coalesce(p.relacl, acldefault('r', p.relowner))) a WHERE p.oid = ${oid}`;
  const grantee = role === 'PUBLIC' ? '0' : `(SELECT oid FROM pg_roles WHERE rolname = ${lit(role)})`;
  return {
    objeto: rotulo,
    sql: `SELECT CASE WHEN ${oid} IS NULL THEN 'FALTA' WHEN EXISTS (${acl} AND a.grantee = ${grantee} AND a.privilege_type = ${lit(priv)}) = ${esperado} THEN 'OK' ELSE 'FALTA' END || ' ' || ${lit(rotulo)}`,
  };
}

export function planejar(fonte: string): Plano {
  const classes = separarComandos(fonte).map(classificar);
  const checagens: Checagem[] = [];
  const naoProvaveis: string[] = [];
  const dos: string[] = [];
  const acl = new Map<string, { kind: 'f' | 'r'; obj: string; role: string; priv: string; v: boolean }>();
  classes.forEach((c, i) => {
    if (c.tipo === 'checagens') checagens.push(...c.checagens);
    else if (c.tipo === 'nao_provavel') naoProvaveis.push(c.resumo);
    else if (c.tipo === 'do') dos.push(c.corpo);
    else if (c.tipo === 'acl') {
      for (const role of c.roles) for (const priv of c.privs) acl.set(`${c.kind}|${c.obj}|${role}|${priv}`, { kind: c.kind, obj: c.obj, role, priv, v: c.grant });
    } else if (c.tipo === 'drop') {
      // recriado DEPOIS no arquivo → o DROP é só o caminho para o CREATE (a checagem do CREATE vale)
      const depois = classes.slice(i + 1).some((d) => d.tipo === 'checagens' && (d.cria ?? []).some((k) => k === c.chave || (c.chave.startsWith('funcao:') && k === c.chave)));
      if (!depois) checagens.push(c.checagem);
    }
  });
  for (const a of acl.values()) checagens.push(checagemAcl(a.kind, a.obj, a.role, a.priv, a.v));
  const linhas = checagens.map((c) => `${c.sql};`);
  linhas.push(`SELECT 'POSCONDICAO_FIM n=' || ${checagens.length};`);
  return { sql: `${linhas.join('\n')}\n`, naoProvaveis, nChecagens: checagens.length, dos };
}

export function main(argv: string[]): number {
  const arq = argv[0];
  if (!arq) {
    console.error('uso: bun scripts/db-atestar-poscondicao.ts <arquivo.sql>');
    return 2;
  }
  let fonte: string;
  try {
    fonte = readFileSync(arq, 'utf8');
  } catch (e) {
    console.error(`MECANICA: não li ${arq}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let p: Plano;
  try {
    p = planejar(fonte);
  } catch (e) {
    console.error(`MECANICA: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  process.stdout.write(p.sql);
  const iDos = argv.indexOf('--dos');
  if (iDos >= 0 && argv[iDos + 1]) {
    p.dos.forEach((d, i) => writeFileSync(`${argv[iDos + 1]}/do-${String(i + 1).padStart(3, '0')}.sql`, `${d};\n`));
  } else if (p.dos.length > 0) {
    for (const d of p.dos) console.error(`NAO_PROVAVEL ${d.replace(/\s+/g, ' ').slice(0, 120)} (bloco DO sem --dos)`);
    p.naoProvaveis.push(...p.dos);
  }
  for (const n of p.naoProvaveis) console.error(`NAO_PROVAVEL ${n}`);
  return p.naoProvaveis.length > 0 ? 3 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
