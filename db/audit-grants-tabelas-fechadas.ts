#!/usr/bin/env bun
/**
 * audit-grants-tabelas-fechadas.ts — AUDITORIA de prod (READ-ONLY via psql-ro) das tabelas
 * fechadas por PRIVILÉGIO. Segunda camada da sentinela; a primeira é o gate estático
 * (scripts/lib/authz-grants.ts → Parte C do `authz:check`).
 *
 * Por que DUAS e nenhuma sozinha basta:
 *   · o gate estático lê o REPO — pega a migration que reabre dentro do PR, antes de virar
 *     produção, mas é CEGO a `GRANT` colado à mão no SQL Editor;
 *   · este audit lê o BANCO — vê a verdade, inclusive o drift manual e a migration que mergeou
 *     e nunca foi aplicada (NAO_APLICADA: merge na main ≠ produção, a armadilha-mãe do projeto,
 *     docs/agent/database.md §2) — mas não bloqueia PR nenhum: roda on-demand, não no CI
 *     (o CI não tem psql-ro).
 *
 * Uso:   bun run authz:grants:prod ; echo $?     → 0 ok/pendente · 1 divergência · 2 erro
 * Dente: db/test-audit-grants-tabelas-fechadas.sh (PG17 local; injeta PSQL_RO + allowlist de teste)
 *
 * Escrito em TypeScript e não em bash (como db/audit-anon-dml-bypass.sh) por um motivo só:
 * assim ele IMPORTA a mesma allowlist que o CI usa, em vez de duplicar a lista num .sql que
 * envelheceria em silêncio. Fonte de verdade única é o ponto inteiro da sentinela.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compararGrantsProd, type MedicaoProd } from '../scripts/lib/authz-grants';
import {
  AUTHZ_TABELAS_FECHADAS,
  type TabelaFechada,
  type Priv,
} from '../scripts/authz-tabelas-fechadas';

const ROLES = ['anon', 'authenticated'] as const;
const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** Erro de EXECUÇÃO (não de contrato): exit 2, distinto do exit 1 de divergência. Um audit que
 *  não conseguiu medir não pode sair 0 — ausência de dado não é aprovação. */
function erroFatal(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

/** Allowlist real, ou a de teste quando o harness PG17 injeta AUTHZ_GRANTS_TEST_JSON. */
function carregarAllowlist(): Record<string, TabelaFechada> {
  const raw = process.env.AUTHZ_GRANTS_TEST_JSON;
  if (!raw) return AUTHZ_TABELAS_FECHADAS;
  console.log('⚠️  allowlist de TESTE (AUTHZ_GRANTS_TEST_JSON) — não é o contrato real do repo.');
  try {
    return JSON.parse(raw) as Record<string, TabelaFechada>;
  } catch (e) {
    erroFatal(`AUTHZ_GRANTS_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
}

/**
 * Uma query para toda a medição: produto cartesiano tabela × role × privilégio, cada linha
 * marcada com o prefixo `ROW|` para sobreviver ao eco de `SET` do psqlrc do psql-ro.
 *
 * A tabela entra QUALIFICADA (`schema.name`, direto da chave da allowlist) — `has_table_privilege`
 * resolve o nome qualificado sozinho. Nada de assumir `public`: uma entrada futura em outro schema
 * mediria a tabela errada e o audit ficaria verde por comparar o objeto errado.
 *
 * MAINTAIN só existe no Postgres 17+; `has_table_privilege(...,'MAINTAIN')` ERRA em versão
 * anterior. Prod é 17.6 (medido 2026-08-13) e o `m` de `arwdDxtm` é justamente ele, então vale
 * medir — mas sob CASE de `server_version_num`, para o audit não quebrar se algum dia apontar
 * para um banco mais velho.
 *
 * O veredito sai como SIM/NAO de um CASE, não como o boolean cru: `'x'||has_table_privilege(...)`
 * imprime `true`/`false`, e um parser que espere `t`/`f` (o formato de COLUNA boolean) descarta
 * 100% das linhas — medição vazia, nenhuma divergência, "✅ prod bate com o contrato". Foi
 * exatamente esse falso-verde que o harness PG17 pegou. O formato do dado é responsabilidade
 * desta query, não do default de impressão do psql (que psqlrc/\pset podem mudar por baixo).
 */
function montarQuery(chaves: string[]): string {
  const lista = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
  const privBase = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
  return `SELECT 'ROW|'||t||'|'||r||'|'||p||'|'||(CASE WHEN has_table_privilege(r,t,p) THEN 'SIM' ELSE 'NAO' END)
          FROM unnest(ARRAY[${lista(chaves)}]::text[]) t,
               unnest(ARRAY[${lista(ROLES)}]::text[]) r,
               unnest((CASE WHEN current_setting('server_version_num')::int >= 170000
                            THEN ARRAY[${lista([...privBase, 'MAINTAIN'])}]
                            ELSE ARRAY[${lista(privBase)}] END)::text[]) p;`;
}

function medir(al: Record<string, TabelaFechada>): MedicaoProd {
  const chaves = Object.keys(al);
  if (chaves.length === 0) return {};
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(chaves)], { encoding: 'utf8' });
  } catch (e) {
    // Tabela inexistente, role inexistente, psql-ro ausente ou sem rede caem todos aqui.
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }
  const med: MedicaoProd = {};
  let lidas = 0;
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith('ROW|')) continue; // descarta o eco de SET e linhas em branco
    lidas++;
    const [, tabela, role, priv, tem] = linha.split('|');
    if (tem !== 'SIM') continue; // só o privilégio PRESENTE entra no mapa
    ((med[tabela] ??= {})[role as (typeof ROLES)[number]] ??= []).push(priv as Priv);
  }
  // A query devolve tabelas × roles × privilégios linhas SEMPRE — inclusive quando a resposta é
  // "não tem nenhum". Vir menos que o piso significa que a medição quebrou (parser, psqlrc,
  // saída truncada), e medição quebrada lida como "nada divergente" é o falso-verde perfeito:
  // um audit silencioso é indistinguível de um audit que aprovou. Ausência de dado sai 2.
  const piso = chaves.length * ROLES.length * 5;
  if (lidas < piso) {
    erroFatal(
      `medição inconsistente: ${lidas} linha(s) ROW| lidas, mínimo esperado ${piso} ` +
        `(${chaves.length} tabela(s) × ${ROLES.length} role(s) × 5 privilégios). ` +
        `A saída do psql mudou de forma — NÃO trate como "tudo fechado".`,
    );
  }
  return med;
}

function main(): void {
  const al = carregarAllowlist();
  const findings = compararGrantsProd(medir(al), al);
  const erros = findings.filter((f) => f.level === 'error');
  const avisos = findings.filter((f) => f.level === 'warn');

  for (const a of avisos) console.log(`⚠️  [${a.codigo}] ${a.msg}`);
  for (const e of erros) console.error(`❌ [${e.codigo}] ${e.msg}`);

  if (erros.length > 0) {
    console.error(
      `\naudit-grants — ${erros.length} divergencia(s) entre prod e o contrato (scripts/authz-tabelas-fechadas.ts).`,
    );
    process.exit(1);
  }
  const n = Object.keys(al).length;
  const pend = avisos.length ? ` (${avisos.length} com fecho pendente, NAO comparada(s))` : '';
  console.log(`✅ audit-grants — ${n} tabela(s) conferida(s); prod bate com o contrato${pend}.`);
}

main();
