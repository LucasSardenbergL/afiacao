#!/usr/bin/env bun
/**
 * audit-rls-prod.ts — a QUARTA guarda: AUDITORIA de prod (READ-ONLY via psql-ro) da RLS VIVA.
 *
 * Os três audits anteriores cobrem EXECUTE de função (`authz:funcoes:prod`), grant de TABELA
 * (`authz:grants:prod`) e o gate no corpo vivo das RPCs (`authz:audit:prod`). Nenhum lê
 * `pg_class.relrowsecurity`, `relforcerowsecurity` ou `pg_policy` — então `ALTER TABLE … DISABLE
 * ROW LEVEL SECURITY` e `CREATE/ALTER POLICY` colados no SQL Editor do Lovable saem VERDE nos
 * três. O gate estático do CI pega o DISABLE **escrito em migration** e só nas 3 tabelas de
 * `AUTHZ_TABELAS_FECHADAS`; o que sobra é o que não passa por migration, que é o modo normal de
 * operar este banco.
 *
 * Uso:   bun run authz:rls:prod ; echo $?   → 0 bate · 1 divergência · 2 não consegui medir
 * Dente: db/test-audit-rls-prod.sh (PG17 descartável — sabota cada regra, exige vermelho, exige o
 *        verde de volta, e prova o EFEITO da RLS sob SET ROLE authenticated + GUC do JWT)
 *
 * Em TypeScript e não em bash pelo mesmo motivo do audit de grants: assim ele IMPORTA o contrato
 * que o CI já tipa, em vez de duplicar a lista num `.sql` que envelheceria em silêncio.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compararRlsProd, type MedicaoRls, type MedPolicy } from '../scripts/lib/authz-rls';
import {
  AUTHZ_RLS_ESPERADO,
  AUTHZ_RLS_PREDICADOS,
  PREDICADOS_PLATAFORMA,
  type TabelaRls,
  type PredicadoEsperado,
} from '../scripts/authz-rls-esperado';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** Erro de EXECUÇÃO (não de contrato): exit 2, distinto do exit 1 de divergência. Medição que não
 *  aconteceu NUNCA pode sair 0 — ausência de dado não é aprovação. */
function erroFatal(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

interface Contrato {
  contrato: Record<string, TabelaRls>;
  predicados: Record<string, PredicadoEsperado>;
  plataforma: ReadonlySet<string>;
}

/** Contrato real, ou o sintético quando o harness PG17 injeta AUTHZ_RLS_TEST_JSON. */
function carregarContrato(): Contrato {
  const raw = process.env.AUTHZ_RLS_TEST_JSON;
  if (!raw) {
    return {
      contrato: AUTHZ_RLS_ESPERADO,
      predicados: AUTHZ_RLS_PREDICADOS,
      plataforma: PREDICADOS_PLATAFORMA,
    };
  }
  console.log('⚠️  contrato de TESTE (AUTHZ_RLS_TEST_JSON) — não é o contrato real do repo.');
  try {
    const p = JSON.parse(raw) as {
      contrato: Record<string, TabelaRls>;
      predicados?: Record<string, PredicadoEsperado>;
      plataforma?: string[];
    };
    return {
      contrato: p.contrato,
      predicados: p.predicados ?? {},
      plataforma: new Set(p.plataforma ?? []),
    };
  } catch (e) {
    erroFatal(`AUTHZ_RLS_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
}

/**
 * Uma invocação do psql para as quatro medições. Cada uma sai em UMA linha, prefixada por
 * `JSON:<chave>|`, porque o `psqlrc` do psql-ro ecoa `SET` e qualquer parser precisa sobreviver a
 * linhas que não são dado.
 *
 * 🔴 `jsonb_agg` e NÃO `json_agg`, e isso não é preferência: `json_agg` insere uma QUEBRA DE LINHA
 * entre elementos (medido — a primeira versão desta query voltou 7 linhas para 7 tabelas). Um
 * parser de "uma linha por chave" leria só o primeiro elemento e mediria 1 policy em vez de 19:
 * medição truncada, nenhuma divergência, ✅ falso. `jsonb_agg` emite compacto, numa linha só.
 *
 * As tabelas entram QUALIFICADAS, direto das chaves do contrato, e são resolvidas por
 * `to_regclass` — nada de assumir `public`. O `LEFT JOIN` sobre `unnest` garante uma linha por
 * tabela DECLARADA mesmo quando ela não existe: ausência tem de virar dado, não silêncio.
 */
function montarQuery(chaves: string[]): string {
  const lista = chaves.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
  const tabs = `(SELECT ARRAY[${lista}]::text[])`;
  return `
SELECT 'JSON:universal|'||jsonb_build_object(
         'totalTabelas', count(*),
         'tabelasSemRls', coalesce(jsonb_agg(n.nspname||'.'||c.relname ORDER BY 1)
                                     FILTER (WHERE NOT c.relrowsecurity), '[]'::jsonb))::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r';

SELECT 'JSON:tabelas|'||coalesce(jsonb_agg(x)::text,'[]') FROM (
  SELECT t AS tabela, (c.oid IS NOT NULL) AS existe,
         coalesce(c.relrowsecurity,false) AS rls, coalesce(c.relforcerowsecurity,false) AS force
    FROM unnest(${tabs}) t
    LEFT JOIN pg_class c ON c.oid = to_regclass(t) AND c.relkind='r'
   ORDER BY t) x;

SELECT 'JSON:policies|'||coalesce(jsonb_agg(x)::text,'[]') FROM (
  SELECT t AS tabela, p.polname AS nome, p.polcmd::text AS cmd, p.polpermissive AS permissiva,
         (CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
               ELSE array_to_string(ARRAY(SELECT r.rolname FROM pg_roles r
                                           WHERE r.oid = ANY(p.polroles) ORDER BY r.rolname),'+') END) AS roles,
         md5(regexp_replace(btrim(pg_get_expr(p.polqual, p.polrelid)), '\\s+', ' ', 'g')) AS "qualMd5",
         md5(regexp_replace(btrim(pg_get_expr(p.polwithcheck, p.polrelid)), '\\s+', ' ', 'g')) AS "wcMd5"
    FROM unnest(${tabs}) t JOIN pg_policy p ON p.polrelid = to_regclass(t)
   ORDER BY t, p.polname) x;

SELECT 'JSON:predicados|'||coalesce(jsonb_agg(x)::text,'[]') FROM (
  SELECT DISTINCT n.nspname||'.'||f.proname AS funcao, f.prosecdef AS secdef,
         coalesce(array_to_string(f.proconfig,','),'') AS cfg,
         md5(regexp_replace(btrim(f.prosrc), '\\s+', ' ', 'g')) AS "srcMd5"
    FROM unnest(${tabs}) t
    JOIN pg_policy p ON p.polrelid = to_regclass(t)
    JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid
                    AND d.refclassid='pg_proc'::regclass
    JOIN pg_proc f ON f.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = f.pronamespace
   ORDER BY 1) x;
`;
}

/** Lê a linha `JSON:<chave>|…`. Chave ausente = medição quebrada = exit 2, jamais lista vazia. */
function extrair(saida: string, chave: string): unknown {
  const pref = `JSON:${chave}|`;
  const linha = saida.split('\n').find((l) => l.startsWith(pref));
  if (linha === undefined) {
    erroFatal(
      `medição incompleta: a saída do psql não trouxe a linha "${pref}". A query mudou de forma ` +
        `ou a conexão falhou — NÃO trate como "nada divergente".`,
    );
  }
  try {
    return JSON.parse(linha.slice(pref.length));
  } catch (e) {
    erroFatal(`linha "${pref}" não é JSON válido: ${(e as Error).message}`);
  }
}

function medir(chaves: string[]): MedicaoRls {
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(chaves)], { encoding: 'utf8' });
  } catch (e) {
    // psql-ro ausente, sem rede, sintaxe rejeitada ou timeout caem todos aqui.
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }

  const universal = extrair(saida, 'universal') as MedicaoRls['universal'];
  const tabelas = extrair(saida, 'tabelas') as MedicaoRls['tabelas'];
  const policies = extrair(saida, 'policies') as MedPolicy[];
  const predicados = extrair(saida, 'predicados') as MedicaoRls['predicados'];

  // Pisos de sanidade. Cada um existe porque o modo de falha que ele pega se apresenta como
  // sucesso: nenhuma tabela medida ⇒ nenhuma violação ⇒ ✅ sobre o vazio.
  if (!Number.isInteger(universal?.totalTabelas) || universal.totalTabelas < 1) {
    erroFatal(
      `medição inconsistente: o schema public devolveu ${universal?.totalTabelas} tabela(s). ` +
        `Zero tabelas não é "zero violações" — é medição quebrada.`,
    );
  }
  if (tabelas.length !== chaves.length) {
    erroFatal(
      `medição inconsistente: ${tabelas.length} linha(s) de tabela para ${chaves.length} ` +
        `declarada(s). O LEFT JOIN devolve uma linha por tabela DECLARADA sempre, inclusive para ` +
        `a que não existe — vir menos significa que o parser ou a query quebrou.`,
    );
  }
  return { universal, tabelas, policies, predicados };
}

function main(): void {
  const { contrato, predicados, plataforma } = carregarContrato();
  const chaves = Object.keys(contrato);
  if (chaves.length === 0) erroFatal('contrato de RLS vazio — não há o que reconciliar.');

  const med = medir(chaves);
  const findings = compararRlsProd(med, contrato, predicados, plataforma);
  const erros = findings.filter((f) => f.level === 'error');
  const avisos = findings.filter((f) => f.level === 'warn');

  for (const a of avisos) console.log(`⚠️  [${a.codigo}] ${a.msg}`);
  for (const e of erros) console.error(`❌ [${e.codigo}] ${e.msg}`);

  if (erros.length > 0) {
    console.error(
      `\naudit-rls — ${erros.length} divergencia(s) entre a RLS de prod e o contrato ` +
        `(scripts/authz-rls-esperado.ts).`,
    );
    process.exit(1);
  }
  // O denominador vai na linha do veredito de propósito: "✅" sem denominador não distingue
  // "conferi 19 policies" de "conferi zero" (docs/historico/fase-sem-sinal.md).
  console.log(
    `✅ audit-rls — ${med.universal.totalTabelas} tabela(s) em public com RLS ligada (0 desligada); ` +
      `${chaves.length} tabela(s) curada(s), ${med.policies.length} policy(ies) e ` +
      `${med.predicados.length} funcao(oes)-predicado batem com o contrato.`,
  );
}

main();
