#!/usr/bin/env bun
/**
 * audit-claude-ro-hardening.ts — SENTINELA do endurecimento do papel de leitura `claude_ro`,
 * aplicado em 2026-08-25 (PRs #1991/#1995/#2008; narrativa em
 * `docs/historico/revoke-que-nao-revoga.md`, lição em `docs/agent/database.md` §1).
 *
 * O que ela existe para pegar: o endurecimento foi um bloco COLADO À MÃO no SQL Editor — não há
 * migration que o gerencie (e não pode haver: um `ALTER ROLE claude_ro` em `supabase/migrations/`
 * quebraria qualquer ambiente reconstruído do zero, onde o papel não existe). Estado que nenhum
 * artefato versionado defende regride em silêncio: outro bloco manual, um `GRANT` de rotina, um
 * upgrade de extensão feito pelo Supabase sem avisar. Esta sentinela é o único artefato que
 * afirma, com evidência, que o estado de 2026-08-25 ainda é o estado de hoje.
 *
 * Uso:   bun run authz:claude-ro:prod ; echo $?   → 0 bate · 1 divergência · 2 não consegui medir
 * Dente: db/test-audit-claude-ro-hardening.sh (PG17 descartável; injeta PSQL_RO + baseline de teste)
 *
 * ── Três decisões de projeto que o histórico obriga ────────────────────────────────────────────
 *
 * (1) O GUC vive em DUAS fontes e conferir uma só dá FALSO-VERMELHO. O bloco aplicado usou
 *     `ALTER ROLE … IN DATABASE postgres SET …`, então o valor foi para `pg_db_role_setting` e
 *     `pg_roles.rolconfig` continua NULL. Quem confere só `rolconfig` conclui "não aplicou" — foi
 *     um aviso do Codex que quase virou falso-vermelho na conferência original. Aqui a asserção é
 *     a UNIÃO das duas fontes, e o dente prova os dois caminhos.
 *
 * (2) A cobertura de `public` é "0 objetos SEM SELECT", nunca o número 413. O 413 do doc é
 *     332 tabelas + 79 views + 2 matviews, e o denominador CRESCE a cada migration. Congelar o
 *     total faria a sentinela ficar vermelha na próxima tabela criada — e sentinela que grita à
 *     toa é desligada. O 0 é invariante ao crescimento e ainda pega a regressão real: o
 *     `ALTER DEFAULT PRIVILEGES` só vale para o que o `postgres` cria, então tabela nascida de
 *     outro dono nasce INVISÍVEL ao diagnóstico.
 *
 * (3) Schema/tabela AUSENTE não é o mesmo que NEGADO. `has_schema_privilege` ERRA (3F000) quando
 *     o schema não existe, e um objeto que sumiu lido como "negado com sucesso" é o falso-verde
 *     perfeito: a sentinela comemoraria justamente por ter perdido o que vigiava. `to_regnamespace`
 *     /`to_regclass` separam os dois casos, e AUSENTE conta como divergência.
 *
 * ── E uma que o `net` obriga ───────────────────────────────────────────────────────────────────
 *
 * O ACL do schema `net` (pg_net 0.19.5) é vigiado por FINGERPRINT, não por asserção item-a-item:
 * o baseline é o conjunto inteiro (12 funções + 2 tabelas + 1 sequência + o nspacl), e qualquer
 * diferença acusa — FECHOU, ABRIU ou APARECEU objeto novo. É deliberado que um upgrade da
 * extensão apareça como divergência: aquele bloco de `REVOKE … FROM PUBLIC` do Supabase só roda
 * para `extversion IN ('0.2'…'0.11.0')`, a prod está em 0.19.5 e portanto o pula — o grant a
 * PUBLIC que se vê hoje é o default do próprio pg_net, e um bump pode mexer nele nos dois
 * sentidos. Por isso `extversion` também é asserção: quando o fingerprint divergir, a linha da
 * versão diz na hora se a causa foi um upgrade ou alguém colando SQL.
 *
 * ── Por que a sonda executiva existe, se já há `has_*_privilege` ───────────────────────────────
 *
 * Porque `has_table_privilege` NÃO conta o USAGE do schema — foi exatamente assim que o `GRANT`
 * de 7 colunas em `auth.refresh_tokens` pousou no catálogo e ficou INERTE. Privilégio de tabela
 * sem alcance de schema é gaveta trancada dentro de sala trancada: o catálogo registra e o acesso
 * não existe. A única prova de alcance real é RODAR a consulta, e a única marca estável do
 * resultado é a SQLSTATE `42501` — ASCII, invariante a locale. A mensagem em texto NÃO entra no
 * veredito: o servidor pode mudar `lc_messages` e "permission denied" viraria "permissão negada",
 * quebrando uma asserção que não tem nada a ver com privilégio (é a lição de locale do #1483).
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** O papel é sempre `claude_ro` — inclusive no PG17 do dente, que o cria com este nome. Nada de
 *  parametrizar: um audit que aceita apontar para outro papel pode passar verde medindo o errado. */
const PAPEL = 'claude_ro';

type Baseline = {
  /** Atributos do papel, em string única — qualquer mudança de um deles acusa. */
  rolattrs: string;
  /** Quantas roles o papel herda. 0 = o `REVOKE pg_read_all_data` de 2026-08-25 continua de pé. */
  memberships: number;
  /** Valor do GUC preso ao papel, procurado na UNIÃO de `rolconfig` + `pg_db_role_setting`. */
  guc: string;
  schemasComAlcance: string[];
  schemasSemAlcance: string[];
  tabelasLegiveis: string[];
  /** Fingerprint do schema `net`: linhas `F|assinatura|acl`, `R|nome|kind|acl`, `N|net|nspacl`. */
  netAcl: string[];
  pgNetVersion: string;
  /** Consultas que TÊM de falhar com 42501 — prova de alcance real, que o catálogo não dá. */
  sondasNegadas: { rotulo: string; sql: string }[];
};

/**
 * O estado medido em 2026-08-25, depois de o founder colar os blocos. Cada linha aqui é uma
 * afirmação verificada naquele dia, não uma intenção de projeto.
 */
const BASELINE_PROD: Baseline = {
  rolattrs: 'super=f bypassrls=t createrole=f createdb=f login=t',
  memberships: 0,
  guc: 'default_transaction_read_only=on',
  schemasComAlcance: ['public', 'cron', 'supabase_migrations', 'net'],
  // `net` fica FORA desta lista de propósito: o alcance dele vem de PUBLIC, não de grant nominal.
  schemasSemAlcance: ['auth', 'vault', 'storage', 'realtime', 'graphql_public', 'extensions'],
  tabelasLegiveis: [
    'cron.job',
    'cron.job_run_details',
    'net._http_response', // ritual da canária de deploy (docs/agent/deploy.md) depende desta
    'supabase_migrations.schema_migrations',
  ],
  netAcl: [
    'F|_await_response(request_id bigint)|DEFAULT',
    'F|_encode_url_with_params_array(url text, params_array text[])|DEFAULT',
    'F|_http_collect_response(request_id bigint, async boolean)|DEFAULT',
    'F|_urlencode_string(string character varying)|DEFAULT',
    'F|check_worker_is_up()|DEFAULT',
    'F|http_collect_response(request_id bigint, async boolean)|DEFAULT',
    'F|http_delete(url text, params jsonb, headers jsonb, timeout_milliseconds integer, body jsonb)|DEFAULT',
    'F|http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer)|DEFAULT',
    'F|http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)|DEFAULT',
    'F|wait_until_running()|DEFAULT',
    'F|wake()|DEFAULT',
    'F|worker_restart()|DEFAULT',
    'N|net|{supabase_admin=UC/supabase_admin,=U/supabase_admin,supabase_functions_admin=U/supabase_admin,postgres=U/supabase_admin,anon=U/supabase_admin,authenticated=U/supabase_admin,service_role=U/supabase_admin}',
    'R|_http_response|r|{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}',
    // A SEQUÊNCIA não é detalhe: em 0.19.5 `http_post` é SQL — insere na fila e chama `wake()`.
    // Com fila e sequência abertas a PUBLIC, quem quiser reproduz os dois passos na mão, e
    // revogar só o EXECUTE das `http_*` não fecharia nada.
    'R|http_request_queue_id_seq|S|{supabase_admin=rwU/supabase_admin,=rwU/supabase_admin}',
    'R|http_request_queue|r|{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}',
  ],
  pgNetVersion: '0.19.5',
  sondasNegadas: [
    // A joia da coroa do histórico: é `auth.refresh_tokens` que virava sessão de master.
    { rotulo: 'auth.refresh_tokens', sql: 'SELECT count(*) FROM auth.refresh_tokens' },
    { rotulo: 'vault.decrypted_secrets', sql: 'SELECT decrypted_secret FROM vault.decrypted_secrets LIMIT 1' },
  ],
};

/** Erro de EXECUÇÃO, não de contrato: exit 2. Um audit que não conseguiu medir não pode sair 0 —
 *  ausência de dado não é aprovação (docs/historico/evidencia-positiva-shell.md). */
function erroFatal(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

function carregarBaseline(): Baseline {
  const raw = process.env.CLAUDE_RO_BASELINE_TEST_JSON;
  if (!raw) return BASELINE_PROD;
  console.log('⚠️  baseline de TESTE (CLAUDE_RO_BASELINE_TEST_JSON) — não é o contrato real do repo.');
  try {
    return JSON.parse(raw) as Baseline;
  } catch (e) {
    erroFatal(`CLAUDE_RO_BASELINE_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const arr = (xs: readonly string[]) => `ARRAY[${xs.map(lit).join(',')}]::text[]`;

/**
 * Uma query para toda a medição de catálogo. Cada linha sai com o prefixo `ROW|` porque o psqlrc
 * do wrapper `psql-ro` ecoa dois `SET` antes de qualquer resultado — sem o prefixo, o parser
 * comeria o eco como se fosse dado.
 *
 * Os vereditos saem como SIM/NAO/AUSENTE de um CASE, jamais como boolean cru: `-tA` imprime
 * `t`/`f` mas uma concatenação imprime `true`/`false`, e um parser que espere o formato errado
 * descarta 100% das linhas — medição vazia, nenhuma divergência, "✅ tudo bate". O formato do
 * dado é responsabilidade desta query, não do default de impressão do psql (que psqlrc e `\pset`
 * podem mudar por baixo).
 */
function montarQuery(b: Baseline): string {
  return `
SELECT 'ROW|PAPEL|existe|'||(CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${lit(PAPEL)}) THEN 'SIM' ELSE 'NAO' END)
UNION ALL
SELECT 'ROW|PAPEL|rolattrs|'||coalesce((SELECT format('super=%s bypassrls=%s createrole=%s createdb=%s login=%s',
         rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin)
       FROM pg_roles WHERE rolname=${lit(PAPEL)}),'AUSENTE')
UNION ALL
SELECT 'ROW|PAPEL|memberships|'||(SELECT count(*)::text FROM pg_auth_members m
       JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=${lit(PAPEL)})
UNION ALL
-- UNIÃO das duas fontes do GUC. "ALTER ROLE … SET" grava em pg_roles.rolconfig; a MESMA ordem
-- com "IN DATABASE" grava em pg_db_role_setting e deixa rolconfig NULL. Ler uma só é falso-vermelho.
SELECT 'ROW|PAPEL|guc|'||coalesce((
         SELECT string_agg(DISTINCT cfg, ',' ORDER BY cfg) FROM (
           SELECT unnest(rolconfig) AS cfg FROM pg_roles WHERE rolname=${lit(PAPEL)}
           UNION ALL
           SELECT unnest(s.setconfig) FROM pg_db_role_setting s
             JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname=${lit(PAPEL)}
         ) u WHERE cfg LIKE 'default_transaction_read_only=%'
       ),'AUSENTE')
UNION ALL
SELECT 'ROW|PAPEL|guc_fonte|'||concat_ws('+',
         (SELECT 'rolconfig' FROM pg_roles WHERE rolname=${lit(PAPEL)}
            AND rolconfig::text[] && ARRAY['default_transaction_read_only=on']),
         (SELECT 'db_role_setting' FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole
            WHERE r.rolname=${lit(PAPEL)} AND s.setconfig && ARRAY['default_transaction_read_only=on'] LIMIT 1))
UNION ALL
SELECT 'ROW|SCHEMA|'||s||'|'||(CASE
         WHEN to_regnamespace(s) IS NULL THEN 'AUSENTE'
         WHEN has_schema_privilege(${lit(PAPEL)}, s, 'USAGE') THEN 'SIM' ELSE 'NAO' END)
  FROM unnest(${arr([...b.schemasComAlcance, ...b.schemasSemAlcance])}) s
UNION ALL
SELECT 'ROW|TABELA|'||t||'|'||(CASE
         WHEN to_regclass(t) IS NULL THEN 'AUSENTE'
         WHEN has_table_privilege(${lit(PAPEL)}, t, 'SELECT') THEN 'SIM' ELSE 'NAO' END)
  FROM unnest(${arr(b.tabelasLegiveis)}) t
UNION ALL
-- "0 sem SELECT", não "413": ver decisão (2) no cabeçalho. O total viaja junto só como contexto
-- para o humano — quem decide o veredito é o segundo número.
SELECT 'ROW|COBERTURA|public|'||count(*)::text||'|'||
       count(*) FILTER (WHERE NOT has_table_privilege(${lit(PAPEL)}, c.oid, 'SELECT'))::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
UNION ALL
SELECT 'ROW|NETACL|'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'
       ||coalesce(p.proacl::text,'DEFAULT')||'|F'
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='net'
UNION ALL
SELECT 'ROW|NETACL|'||c.relname||'|'||c.relkind::text||'|'||coalesce(c.relacl::text,'DEFAULT')||'|R'
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='net' AND c.relkind IN ('r','p','S','v','m')
UNION ALL
SELECT 'ROW|NETACL|net|'||coalesce((SELECT nspacl::text FROM pg_namespace WHERE nspname='net'),'DEFAULT')||'|N'
UNION ALL
-- Emite SEMPRE, mesmo sem a extensão: uma linha que some derruba o piso e vira exit 2, quando o
-- que se quer dizer é "a extensão sumiu" — que é divergência, não falha de medição.
SELECT 'ROW|PGNET|version|'||coalesce((SELECT extversion FROM pg_extension WHERE extname='pg_net'),'AUSENTE')
;`;
}

type Medicao = {
  papel: Record<string, string>;
  schemas: Record<string, string>;
  tabelas: Record<string, string>;
  cobertura: { total: number; semSelect: number } | null;
  netAcl: string[];
  pgNet: string | null;
};

function medir(b: Baseline): Medicao {
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(b)], { encoding: 'utf8' });
  } catch (e) {
    // psql-ro ausente, sem rede, credencial revogada e SQL inválido caem todos aqui.
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }
  const m: Medicao = { papel: {}, schemas: {}, tabelas: {}, cobertura: null, netAcl: [], pgNet: null };
  let lidas = 0;
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith('ROW|')) continue; // descarta o eco de SET do psqlrc e linhas em branco
    lidas++;
    const campos = linha.split('|');
    const grupo = campos[1];
    if (grupo === 'PAPEL') m.papel[campos[2]] = campos.slice(3).join('|');
    else if (grupo === 'SCHEMA') m.schemas[campos[2]] = campos[3];
    else if (grupo === 'TABELA') m.tabelas[campos[2]] = campos[3];
    else if (grupo === 'COBERTURA') m.cobertura = { total: Number(campos[3]), semSelect: Number(campos[4]) };
    else if (grupo === 'PGNET') m.pgNet = campos[3];
    else if (grupo === 'NETACL') {
      // O discriminador (F/R/N) vai no FIM, não no começo: as três formas têm número de campos
      // diferente (função = nome+acl, relação = nome+kind+acl, schema = nome+nspacl), e um
      // discriminador no fim deixa `slice(2,-1)` reconstruir o meio sem saber qual é qual.
      const tipo = campos[campos.length - 1];
      const meio = campos.slice(2, -1);
      m.netAcl.push(`${tipo}|${meio.join('|')}`);
    }
  }
  // A query devolve um número DETERMINÍSTICO de linhas — inclusive quando toda resposta é "não".
  // Vir menos que o piso significa medição quebrada (parser, psqlrc, saída truncada), e medição
  // quebrada lida como "nada divergente" é o falso-verde perfeito: um audit silencioso é
  // indistinguível de um audit que aprovou.
  const pisoFixo = 5 + b.schemasComAlcance.length + b.schemasSemAlcance.length + b.tabelasLegiveis.length + 1 + 1;
  const netLidas = m.netAcl.length;
  if (lidas < pisoFixo + 1 || netLidas < 1) {
    erroFatal(
      `medição inconsistente: ${lidas} linha(s) ROW| lidas (mínimo ${pisoFixo + 1}), ` +
        `${netLidas} do schema net (mínimo 1). Medição incompleta não é aprovação.`,
    );
  }
  return m;
}

/**
 * A sonda executiva: RODA a consulta e exige que ela falhe com 42501. Um psql por sonda, de
 * propósito — a asserção é sobre o statement chegar ao fim, e um `UNION ALL` com as outras
 * abortaria a query inteira no primeiro erro, levando junto a medição de catálogo.
 */
function sondar(sondas: Baseline['sondasNegadas']): { rotulo: string; ok: boolean; obs: string }[] {
  return sondas.map(({ rotulo, sql }) => {
    try {
      execFileSync(PSQL, ['-v', 'VERBOSITY=verbose', '-tA', '-c', sql], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // exit 0 = a consulta PASSOU. O alcance voltou.
      return { rotulo, ok: false, obs: 'consulta teve SUCESSO — o alcance foi restaurado' };
    } catch (e) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
      const texto = `${err.stderr ?? ''}${err.stdout ?? ''}`;
      // 42501 = insufficient_privilege. ASCII, invariante a locale: é o único pedaço da mensagem
      // que sobrevive a uma troca de `lc_messages` no servidor.
      const negado = texto.includes('42501');
      return {
        rotulo,
        ok: negado,
        obs: negado
          ? 'negado com 42501'
          : `falhou SEM 42501 (outro erro): ${texto.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
      };
    }
  });
}

// ── veredito ──────────────────────────────────────────────────────────────────────────────────

const b = carregarBaseline();
const m = medir(b);
const div: string[] = [];
const ok: string[] = [];

const cmp = (rotulo: string, esperado: string, medido: string) =>
  esperado === medido
    ? ok.push(`${rotulo}: ${medido}`)
    : div.push(`${rotulo}\n      esperado: ${esperado}\n      medido:   ${medido}`);

cmp('papel existe', 'SIM', m.papel.existe ?? '(sem linha)');
cmp('atributos do papel', b.rolattrs, m.papel.rolattrs ?? '(sem linha)');
cmp('memberships herdadas', String(b.memberships), m.papel.memberships ?? '(sem linha)');
cmp('GUC read-only preso ao papel', b.guc, m.papel.guc ?? '(sem linha)');
// Informativo, NÃO asserção: qual das duas fontes carrega o GUC pode mudar sem que a garantia
// mude. Congelar a fonte transformaria um re-apply legítimo em vermelho.
ok.push(`GUC vem de: ${m.papel.guc_fonte || '(nenhuma)'}`);

for (const s of b.schemasComAlcance) cmp(`schema ${s} alcançável`, 'SIM', m.schemas[s] ?? '(sem linha)');
for (const s of b.schemasSemAlcance) cmp(`schema ${s} FORA de alcance`, 'NAO', m.schemas[s] ?? '(sem linha)');
for (const t of b.tabelasLegiveis) cmp(`SELECT em ${t}`, 'SIM', m.tabelas[t] ?? '(sem linha)');

if (!m.cobertura) div.push('cobertura de public: linha ausente na medição');
else {
  cmp('objetos de public SEM SELECT', '0', String(m.cobertura.semSelect));
  ok.push(`cobertura de public: ${m.cobertura.total} objetos (r/p/v/m), todos com SELECT`);
}

cmp('versão do pg_net', b.pgNetVersion, m.pgNet ?? '(sem linha)');

// Fingerprint do net: conjunto contra conjunto, para acusar nos DOIS sentidos.
const esperados = new Set(b.netAcl);
const medidos = new Set(m.netAcl);
const sumiram = [...esperados].filter((x) => !medidos.has(x)).sort();
const surgiram = [...medidos].filter((x) => !esperados.has(x)).sort();
if (sumiram.length === 0 && surgiram.length === 0) {
  ok.push(`ACL do schema net: ${medidos.size} entradas, idênticas ao baseline`);
} else {
  div.push(
    `ACL do schema net mudou (${sumiram.length} sumiram, ${surgiram.length} surgiram)` +
      sumiram.map((x) => `\n      − ${x}`).join('') +
      surgiram.map((x) => `\n      + ${x}`).join(''),
  );
}

for (const s of sondar(b.sondasNegadas)) {
  if (s.ok) ok.push(`sonda ${s.rotulo}: ${s.obs}`);
  else div.push(`sonda ${s.rotulo}\n      ${s.obs}`);
}

console.log(`\n🔒 sentinela do endurecimento de \`${PAPEL}\` — baseline de 2026-08-25\n`);
for (const l of ok) console.log(`  ✅ ${l}`);
if (div.length === 0) {
  console.log(`\n✅ ${ok.length} asserções batem. O endurecimento continua de pé.\n`);
  process.exit(0);
}
console.log('');
for (const l of div) console.error(`  ❌ ${l}`);
console.error(
  `\n❌ ${div.length} divergência(s). O endurecimento de \`${PAPEL}\` REGREDIU ou drifou.\n` +
    `   Contexto: docs/historico/revoke-que-nao-revoga.md · docs/agent/database.md §1\n` +
    `   Se a divergência for só no ACL do net e a versão do pg_net mudou, a causa é um upgrade\n` +
    `   da extensão feito pelo Supabase — reavalie e atualize o baseline com o novo estado.\n`,
);
process.exit(1);
