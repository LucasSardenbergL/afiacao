#!/usr/bin/env bun
/**
 * audit-grants-funcoes-fechadas.ts — AUDITORIA de prod (READ-ONLY via psql-ro) do EXECUTE das
 * funções sensíveis classificadas. Segunda camada da Parte E; a primeira é o gate estático
 * (scripts/lib/authz-funcoes.ts → Parte E do `authz:check`).
 *
 * Por que DUAS e nenhuma sozinha basta:
 *   · o gate estático lê o REPO — pega o `DROP FUNCTION`+`CREATE` sem REVOKE e o `GRANT` novo
 *     dentro do PR, antes de virar produção, mas é CEGO ao `GRANT EXECUTE` colado à mão no SQL
 *     Editor e à função cujo fecho NUNCA esteve no repo (medido: `public.cmc_ledger_capture` está
 *     fechada em prod e nenhuma migration a fecha — o gate estático não tem o que vigiar nela);
 *   · este audit lê o BANCO — vê a verdade, inclusive a migration que mergeou e nunca foi aplicada
 *     (FUNCAO_NAO_APLICADA: merge na main ≠ produção, docs/agent/database.md) — mas não bloqueia
 *     PR nenhum: roda on-demand, não no CI (o CI não tem psql-ro).
 *
 * Uso:   bun run authz:funcoes:prod ; echo $?   → 0 ok/pendente · 1 divergência · 2 erro de execução
 *
 * ⚠️ OVERLOADS colapsam na chave `schema.name`, que é a granularidade do contrato (a mesma do
 * AUTHZ_MANIFEST). A regra é fail-closed: se QUALQUER overload é alcançável por uma role proibida,
 * a função conta como aberta. Somar por assinatura deixaria um overload esquecido passar despercebido.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  compararExecuteProd,
  type MedicaoExecuteProd,
  type ExecuteMedido,
} from '../scripts/lib/authz-funcoes';
import { AUTHZ_FUNCOES_FECHADAS, type FuncaoFechada, type RoleVigiada } from '../scripts/authz-funcoes-fechadas';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** Erro de EXECUÇÃO (não de contrato): exit 2, distinto do exit 1 de divergência. Um audit que
 *  não conseguiu medir não pode sair 0 — ausência de dado não é aprovação. */
function erroFatal(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

/** Allowlist real, ou a de teste quando um harness injeta AUTHZ_FUNCOES_TEST_JSON. */
function carregarAllowlist(): Record<string, FuncaoFechada> {
  const raw = process.env.AUTHZ_FUNCOES_TEST_JSON;
  if (!raw) return AUTHZ_FUNCOES_FECHADAS;
  console.log('⚠️  allowlist de TESTE (AUTHZ_FUNCOES_TEST_JSON) — não é o contrato real do repo.');
  try {
    return JSON.parse(raw) as Record<string, FuncaoFechada>;
  } catch (e) {
    erroFatal(`AUTHZ_FUNCOES_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
}

/**
 * Uma query para toda a medição. Cada linha vem marcada com `ROW|` para sobreviver ao eco de `SET`
 * do psqlrc do psql-ro.
 *
 * O veredito sai como SIM/NAO de um CASE, e não como o boolean cru, pela MESMA razão do audit de
 * tabelas: `has_function_privilege(...)` imprime `true`/`false`, um parser que espere `t`/`f`
 * descarta 100% das linhas, e medição vazia vira "✅ prod bate com o contrato" — falso-verde. O
 * formato do dado é responsabilidade desta query, não do default de impressão do psql.
 *
 * `proacl IS NULL` viaja junto porque é um estado DISTINTO de "sem privilégio": significa EXECUTE
 * implícito a PUBLIC. Em `private` — que não tem default privilege de função (medido) — é assim
 * que uma função nasce, e `has_function_privilege` já devolve SIM; medir os dois separa "fechada"
 * de "ninguém nunca tocou no ACL", que exigem ações diferentes.
 */
function montarQuery(chaves: string[]): string {
  const lista = chaves.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
  return `SELECT 'ROW|'||n.nspname||'.'||p.proname
       ||'|'||(CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'SIM' ELSE 'NAO' END)
       ||'|'||(CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'SIM' ELSE 'NAO' END)
       ||'|'||(CASE WHEN p.proacl IS NULL THEN 'SIM' ELSE 'NAO' END)
       ||'|'||p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE (n.nspname||'.'||p.proname) = ANY(ARRAY[${lista}]::text[]);`;
}

function medir(al: Record<string, FuncaoFechada>): { med: MedicaoExecuteProd; linhas: number } {
  const chaves = Object.keys(al);
  if (chaves.length === 0) return { med: {}, linhas: 0 };
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(chaves)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }
  const med: MedicaoExecuteProd = {};
  let linhas = 0;
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith('ROW|')) continue; // descarta o eco de SET e linhas em branco
    const [, chave, anon, auth, aclNulo] = linha.split('|');
    if (!chave) continue;
    linhas++;
    const anterior: ExecuteMedido = med[chave] ?? { roles: [], aclNulo: false };
    const roles = new Set<RoleVigiada>(anterior.roles);
    if (anon === 'SIM') roles.add('anon');
    if (auth === 'SIM') roles.add('authenticated');
    // fail-closed entre overloads: basta UM alcançável para a função contar como aberta.
    med[chave] = { roles: [...roles], aclNulo: anterior.aclNulo || aclNulo === 'SIM' };
  }
  if (linhas === 0) erroFatal('nenhuma função lida do banco — psql-ro respondeu vazio (query ou permissão?).');
  return { med, linhas };
}

function main(): void {
  const al = carregarAllowlist();
  const { med, linhas } = medir(al);
  const findings = compararExecuteProd(med, al);
  const erros = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  console.log(
    `🔎 authz:funcoes:prod — ${linhas} definição(ões) lida(s) para ${Object.keys(al).length} chave(s) da allowlist.`,
  );
  for (const w of warns) console.log(`⚠️  ${w.funcao} — [${w.codigo}] ${w.msg}`);
  for (const e of erros) console.error(`❌ ${e.funcao} — [${e.codigo}] ${e.msg}`);

  if (erros.length > 0) {
    console.error(`\nauthz:funcoes:prod — ${erros.length} divergência(s) de EXECUTE. Ver scripts/authz-funcoes-fechadas.ts.`);
    process.exit(1);
  }
  // O verde declara o que o OUTRO lado não cobre: estas foram comparadas aqui (e passaram), mas o
  // fecho delas não está no repo, então o gate estático do CI não as vigia — este audit, que roda
  // on-demand, é a única guarda que têm. Dizer isso é o que impede o exit 0 de virar "coberto".
  const semRepo = warns.filter((w) => w.codigo === 'FUNCAO_FECHO_PENDENTE').map((w) => w.funcao);
  console.log(
    `✅ o EXECUTE de prod bate com o contrato nas ${Object.keys(al).length} função(ões) da allowlist.` +
      (semRepo.length
        ? ` ⚠️ ${semRepo.length} delas têm o fecho FORA do repo (fechadaPor=null) e portanto NÃO são vigiadas pelo CI: ${semRepo.join(', ')}.`
        : ''),
  );
}

if (import.meta.main) main();
