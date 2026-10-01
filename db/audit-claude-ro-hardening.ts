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
 *     separa os dois casos no eixo de SCHEMA; no de RELAÇÃO, quem separa é um LEFT JOIN em
 *     `pg_class` — e NÃO `to_regclass`, que precisa de USAGE no schema para resolver o nome e
 *     ERRA (em vez de devolver NULL) justamente no cenário que se quer acusar. Nos dois eixos,
 *     AUSENTE conta como divergência.
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
 * ── E os dois eixos que a reconciliação de 2026-09-06 obriga (PR #2275) ────────────────────────
 *
 * O fecho de `pg_read_all_data` levou junto o schema `private` (3 MVs de diagnóstico) e a
 * telemetria de login — e NINGUÉM notou por 13 dias, porque não havia asserção sobre eles. A
 * reconciliação devolveu os dois: `GRANT USAGE ON SCHEMA private` e uma PONTE de view
 * (`private.auth_refresh_tokens_diag`) que projeta 7 colunas de `auth.refresh_tokens` sem reabrir
 * o schema `auth`. Os dois foram colados à mão, como todo o resto — logo, sem asserção aqui,
 * regridem no mesmo silêncio. Três regressões distintas, cada uma com sua asserção:
 *
 *   (a) revogar o USAGE em `private` → o diagnóstico de MV morre. Cobertura por "0 objetos SEM
 *       SELECT", igual a `public`, MAIS as 3 MVs nomeadas em `tabelasLegiveis`: sem os nomes, um
 *       `DROP` das três deixaria o schema vazio e "0 sem SELECT" ficaria VERDE por vacuidade.
 *
 *   (b) recriar a ponte SEM `security_invoker=on` → ela passa a ler como o OWNER e o ACL por
 *       coluna deixa de ser barreira (§4: `CREATE OR REPLACE VIEW` sem o `WITH` RESETA a opção).
 *       ⚠️ `reloptions` guarda o LITERAL do `WITH`: `= on` grava `on`, `= true` grava `true`.
 *       Casar um literal só é o falso-negativo documentado no §4 — por isso os DOIS são aceitos.
 *       E `SEM_RELOPTIONS` (view viva, opção resetada) tem mensagem própria, separada de
 *       `AUSENTE` (view sumiu): são causas diferentes e o conserto é diferente.
 *
 *   (c) acrescentar `token`/`parent` à projeção → reabre a escalada inteira (refresh token vivo
 *       troca-se por JWT de master com a anon key, que é pública). Duas asserções independentes:
 *       a projeção da ponte (`pg_attribute` da view) e o ACL por COLUNA da tabela de origem.
 *
 * ⚠️ O ACL de coluna é lido de `pg_attribute.attacl`, NUNCA de `has_column_privilege`. Medido nesta
 * prod: como `claude_ro` não tem USAGE em `auth`, `has_column_privilege('claude_ro',
 * 'auth.refresh_tokens','token','SELECT')` ERRA com `permission denied for schema auth` em vez de
 * devolver `f` — e o erro derrubaria a query inteira, virando exit 2 (medição impossível) onde se
 * queria uma asserção. `to_regclass('auth.refresh_tokens')` erra do mesmo jeito, e pela mesma
 * razão. O catálogo (`pg_class`/`pg_namespace`/`pg_attribute`) é legível a qualquer papel: o
 * caminho que funciona é o JOIN por NOME. A ponte inverte a lição do §1 ("catálogo não prova
 * alcance") sem revogá-la — por isso ela também tem sonda executiva, dos DOIS lados: a leitura
 * das 7 colunas tem de SUCEDER (o `GRANT` de 25/08 já ficou inerte uma vez) e `token` tem de
 * falhar. Ali a SQLSTATE esperada é `42703` (coluna inexistente), não `42501`: a ponte não
 * esconde a coluna por privilégio, ela simplesmente não a projeta.
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
 *
 * ── Quem pode VIRAR o papel (2026-10-01) ──────────────────────────────────────────────────────
 *
 * `memberships` é o que o `claude_ro` HERDA. O sentido contrário não tinha asserção: os MEMBROS
 * dele — quem pode `SET ROLE claude_ro`. Um `GRANT claude_ro TO authenticated` daria a qualquer
 * usuário logado a leitura do papel, com BYPASSRLS, e todas as outras asserções sairiam verdes.
 * `membros` é o conjunto EXATO das arestas (membro, opções, quem concedeu). Nasceu junto com a
 * aresta que a nuvem precisa: o `postgres` (o papel do conector Lovable) com SET e sem INHERIT,
 * para rodar as sondas executivas como o `claude_ro` — e sem herdar nada dele.
 *
 * ── Pela NUVEM (2026-10-01): `--sql-nuvem` / `--dados-nuvem=<arquivo>` ─────────────────────────
 *
 * A sessão da nuvem não tem `psql-ro` (a credencial não sai do Mac — `docs/agent/database.md` §1).
 * A MESMA medição vai pelo transporte de `scripts/lib/transporte-nuvem.ts`, em UMA rodada: o
 * catálogo é uma consulta do pacote (papel-parametrizada: `has_*_privilege('claude_ro', …)` e o
 * catálogo cru dão a mesma resposta lidos pelo `postgres`), e as 4 sondas executivas viajam no
 * PREÂMBULO do transporte, que roda cada uma COMO o `claude_ro` (`SET LOCAL ROLE`) e devolve só a
 * SQLSTATE — a da vault, se um dia voltar a ler, devolve `RODOU`, nunca o segredo. Sem SET do
 * `postgres` em `claude_ro`, as sondas NÃO viram resultado: o transporte recusa
 * (`TRANSPORTE_SONDA_PAPEL`) e a sentinela sai 2 — o SET ROLE negado sai com a MESMA 42501 da
 * negação esperada, e lê-lo como "negado" seria o falso verde perfeito.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type Consultas,
  type DadosNuvem,
  gerarSqlNuvem,
  lerArquivoDadosNuvem,
  lerDadosNuvem,
  type ResultadoSonda,
  separarFlagsNuvem,
  type SondaExecutiva,
  type SondasExecutivas,
} from '../scripts/lib/transporte-nuvem';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** O papel é sempre `claude_ro` — inclusive no PG17 do dente, que o cria com este nome. Nada de
 *  parametrizar: um audit que aceita apontar para outro papel pode passar verde medindo o errado. */
const PAPEL = 'claude_ro';

/** Quem consome a resposta da nuvem: a gerada para outro CLI é recusada como "arquivo de outra leitura". */
export const CONSUMIDOR_NUVEM = 'claude-ro-hardening';

const USO = 'Uso: bun run authz:claude-ro:prod [--sql-nuvem | --dados-nuvem=<arquivo>]';

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
  /** Consultas que TÊM de falhar — prova de alcance real, que o catálogo não dá. `sqlstate`
   *  default `42501`; a ponte usa `42703`, que é coluna-não-existe e não privilégio. */
  sondasNegadas: { rotulo: string; sql: string; sqlstate?: string }[];
  /** Consultas que TÊM de SUCEDER. Um GRANT que o catálogo registra e o executor não honra já
   *  aconteceu aqui (o de 25/08 em `auth.refresh_tokens`): alcance só se prova RODANDO. */
  sondasPermitidas: { rotulo: string; sql: string }[];
  /** Schemas cuja cobertura é medida por "0 objetos SEM SELECT" — nunca pelo total (decisão 2). */
  schemasCobertura: string[];
  /** A ponte de view que devolve a telemetria de login sem reabrir o schema `auth`. */
  ponte: {
    schema: string;
    relacao: string;
    /** `reloptions` preserva o literal do `WITH` — `=on` e `=true` são o MESMO desenho (§4). */
    invokerAceitos: string[];
    /** Projeção EXATA. Coluna que SAI também é divergência: a telemetria morreria pela metade. */
    colunas: string[];
    /** As que reabrem a escalada. Presença aqui é P0, não drift. */
    colunasProibidas: string[];
  };
  /** ACL por COLUNA da tabela-fonte, como fingerprint `coluna|attacl`. Acusa nos dois sentidos:
   *  `token`/`parent` GANHANDO ACL e qualquer uma das 7 de telemetria PERDENDO o dela. */
  authColAcl: { schema: string; tabela: string; entradas: string[] };
  /** Os MEMBROS do papel — quem pode virar o `claude_ro` — como `membro|admin=…,inherit=…,set=…|grantor`. */
  membros: string[];
};

/**
 * O estado medido em 2026-08-25, depois de o founder colar os blocos. Cada linha aqui é uma
 * afirmação verificada naquele dia, não uma intenção de projeto.
 */
export const BASELINE_PROD: Baseline = {
  rolattrs: 'super=f bypassrls=t createrole=f createdb=f login=t',
  memberships: 0,
  guc: 'default_transaction_read_only=on',
  // `private` entrou em 2026-09-06 (#2275): é o schema das 3 MVs de diagnóstico, e caiu no fecho
  // de 25/08 sem ninguém notar por 13 dias — exatamente o que uma sentinela existe para impedir.
  schemasComAlcance: ['public', 'private', 'cron', 'supabase_migrations', 'net'],
  // `net` fica FORA desta lista de propósito: o alcance dele vem de PUBLIC, não de grant nominal.
  schemasSemAlcance: ['auth', 'vault', 'storage', 'realtime', 'graphql_public', 'extensions'],
  tabelasLegiveis: [
    // As 3 MVs de `private` vão NOMEADAS de propósito: a cobertura "0 sem SELECT" é vacuamente
    // verde num schema vazio, então sem os nomes um DROP das três passaria batido.
    'private.mv_oportunidade_badge',
    'private.customer_metrics_mv',
    'private.mv_sku_ranking_negociacao_paralela',
    'private.auth_refresh_tokens_diag', // a ponte: SELECT é o que a telemetria de login consome
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
    // 42703, não 42501: a ponte não NEGA a coluna, ela não a projeta. Se um dia alguém a
    // acrescentar, esta sonda vira 42501 (o ACL de coluna barra) ou SUCESSO (se o ACL cair
    // junto) — e as duas leituras são vermelho aqui, porque nenhuma é `42703`.
    { rotulo: 'token na ponte', sqlstate: '42703',
      sql: 'SELECT token FROM private.auth_refresh_tokens_diag LIMIT 1' },
  ],
  sondasPermitidas: [
    { rotulo: 'ponte de telemetria', sql: 'SELECT count(*) FROM private.auth_refresh_tokens_diag' },
  ],
  schemasCobertura: ['public', 'private'],
  ponte: {
    schema: 'private',
    relacao: 'auth_refresh_tokens_diag',
    invokerAceitos: ['security_invoker=on', 'security_invoker=true'],
    colunas: ['created_at', 'id', 'instance_id', 'revoked', 'session_id', 'updated_at', 'user_id'],
    colunasProibidas: ['token', 'parent'],
  },
  authColAcl: {
    schema: 'auth',
    tabela: 'refresh_tokens',
    // As 7 de telemetria carregam o GRANT de 25/08; `token`/`parent` NÃO têm ACL próprio, e é
    // essa ausência que mantém a 2ª barreira de pé sob `security_invoker=on`.
    entradas: [
      'created_at|{claude_ro=r/postgres}',
      'id|{claude_ro=r/postgres}',
      'instance_id|{claude_ro=r/postgres}',
      'parent|SEM_ACL',
      'revoked|{claude_ro=r/postgres}',
      'session_id|{claude_ro=r/postgres}',
      'token|SEM_ACL',
      'updated_at|{claude_ro=r/postgres}',
      'user_id|{claude_ro=r/postgres}',
    ],
  },
  membros: [
    // A aresta original: o `postgres` criou o papel e ficou com ADMIN (sem herdar, sem virar).
    'postgres|admin=sim,inherit=nao,set=nao|supabase_admin',
    // A da NUVEM (2026-10-01): o conector entra como `postgres`, e as sondas executivas rodam
    // como o `claude_ro` por `SET LOCAL ROLE`. SET sim, INHERIT não: virar, nunca herdar.
    'postgres|admin=nao,inherit=nao,set=sim|postgres',
  ],
};

/** "Não consegui medir" (exit 2), de qualquer ponto — convertido UMA vez, em `executar`. Um audit
 *  que não conseguiu medir não pode sair 0: ausência de dado não é aprovação
 *  (docs/historico/evidencia-positiva-shell.md). */
class MedicaoIncompleta extends Error {}

function erroFatal(msg: string): never {
  throw new MedicaoIncompleta(msg);
}

function carregarBaseline(raw: string | undefined, aviso: (linha: string) => void): Baseline {
  if (!raw) return BASELINE_PROD;
  aviso('⚠️  baseline de TESTE (CLAUDE_RO_BASELINE_TEST_JSON) — não é o contrato real do repo.');
  let b: Baseline;
  try {
    b = JSON.parse(raw) as Baseline;
  } catch (e) {
    erroFatal(`CLAUDE_RO_BASELINE_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
  // Campo que o baseline de teste não traz é contrato incompleto, não "nada a conferir".
  if (!Array.isArray(b.membros)) erroFatal("CLAUDE_RO_BASELINE_TEST_JSON sem o campo 'membros' (lista)");
  return b;
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
 *
 * Ela também é a consulta `catalogo` do transporte da nuvem: por isso nenhum `;` no meio, nem em
 * comentário (o transporte embute cada consulta num statement só e recusa o texto que o tenha).
 */
export function montarQuery(b: Baseline): string {
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
-- UNIÃO das duas fontes do GUC. "ALTER ROLE … SET" grava em pg_roles.rolconfig, e a MESMA ordem
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
-- ⚠️ NADA de 'to_regclass(t)' aqui, e a razão é o 'private': resolver um NOME de relação exige
-- USAGE no schema, então no dia em que o USAGE for revogado o 'to_regclass' ERRA (não devolve
-- NULL) e derruba a query INTEIRA — a regressão sairia como exit 2 ("não consegui medir") em vez
-- de exit 1 ("regrediu"), com a mensagem errada. O LEFT JOIN pelo catálogo é indiferente ao
-- USAGE, e 'has_table_privilege' por OID não faz resolução de nome (é o mesmo motivo pelo qual
-- ele não enxerga o USAGE — §1). Assim 'AUSENTE' continua sendo AUSENTE de verdade.
SELECT 'ROW|TABELA|'||t||'|'||(CASE
         WHEN r.oid IS NULL THEN 'AUSENTE'
         WHEN has_table_privilege(${lit(PAPEL)}, r.oid, 'SELECT') THEN 'SIM' ELSE 'NAO' END)
  FROM unnest(${arr(b.tabelasLegiveis)}) t
  LEFT JOIN LATERAL (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=split_part(t,'.',1) AND c.relname=split_part(t,'.',2) LIMIT 1
  ) r ON true
UNION ALL
-- "0 sem SELECT", não "413": ver decisão (2) no cabeçalho. O total viaja junto só como contexto
-- para o humano — quem decide o veredito é o segundo número. O LATERAL com agregado devolve
-- SEMPRE 1 linha por schema (inclusive 0 objetos), então o piso de linhas segue determinístico,
-- e schema AUSENTE sai rotulado, porque "0 objetos, 0 sem SELECT" num schema que sumiu é o
-- falso-verde da decisão (3) na sua forma mais discreta.
SELECT 'ROW|COBERTURA|'||s||'|'||(CASE
         WHEN to_regnamespace(s) IS NULL THEN 'AUSENTE|AUSENTE'
         ELSE x.total::text||'|'||x.sem::text END)
  FROM unnest(${arr(b.schemasCobertura)}) s
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE NOT has_table_privilege(${lit(PAPEL)}, c.oid, 'SELECT')) AS sem
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=s AND c.relkind IN ('r','p','v','m')
  ) x
UNION ALL
-- A PONTE (#2275). Emite SEMPRE, como o PGNET abaixo: se a view sumir, uma linha a menos
-- derrubaria o piso e o veredito viraria exit 2 ("não consegui medir") onde o certo é exit 1
-- ("regrediu"). 'SEM_RELOPTIONS' ≠ 'AUSENTE': a primeira é a view viva com o invoker RESETADO
-- por um 'CREATE OR REPLACE' sem o 'WITH' (§4), a segunda é a view apagada.
SELECT 'ROW|PONTE|reloptions|'||coalesce((
         SELECT coalesce(array_to_string(c.reloptions,','),'SEM_RELOPTIONS')
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=${lit(b.ponte.schema)} AND c.relname=${lit(b.ponte.relacao)}
            AND c.relkind='v'),'AUSENTE')
UNION ALL
-- Projeção da ponte, uma linha por coluna (conjunto, não contagem). Zero linhas é divergência
-- legítima e o grupo acima diz a causa — por isso este NÃO entra no piso.
SELECT 'ROW|PONTECOL|'||a.attname
  FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=${lit(b.ponte.schema)} AND c.relname=${lit(b.ponte.relacao)}
   AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
-- ACL por COLUNA da tabela-fonte. JOIN por NOME de propósito: 'to_regclass('auth.refresh_tokens')'
-- e 'has_column_privilege(...)' ERRAM com 'permission denied for schema auth' quando quem mede é o
-- 'claude_ro' (medido nesta prod), e um ERROR aqui abortaria a query INTEIRA — a asserção viraria
-- falha de medição. O catálogo, por outro lado, é legível a qualquer papel.
SELECT 'ROW|AUTHCOL|'||a.attname||'|'||coalesce(a.attacl::text,'SEM_ACL')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=${lit(b.authColAcl.schema)} AND c.relname=${lit(b.authColAcl.tabela)}
   AND a.attnum>0 AND NOT a.attisdropped
UNION ALL
-- QUEM PODE VIRAR o papel: os MEMBROS dele, o sentido contrário das 'memberships' acima. Um
-- 'GRANT claude_ro TO authenticated' daria a qualquer usuário logado a leitura do papel, com
-- BYPASSRLS. Zero linhas é divergência legítima (a aresta da nuvem sumiu), por isso fora do piso.
SELECT 'ROW|MEMBRO|'||u.rolname||'|admin='||(CASE WHEN m.admin_option THEN 'sim' ELSE 'nao' END)
       ||',inherit='||(CASE WHEN m.inherit_option THEN 'sim' ELSE 'nao' END)
       ||',set='||(CASE WHEN m.set_option THEN 'sim' ELSE 'nao' END)||'|'||g.rolname
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid=m.roleid
  JOIN pg_roles u ON u.oid=m.member
  JOIN pg_roles g ON g.oid=m.grantor
 WHERE r.rolname=${lit(PAPEL)}
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

/** As leituras de catálogo, como consultas do transporte: a mesma query, numa consulta só. */
export function consultasNuvem(b: Baseline): Consultas {
  return { catalogo: montarQuery(b) };
}

/**
 * As sondas executivas no formato do transporte — rodam COMO o `claude_ro` no preâmbulo. Só a
 * permitida devolve o valor (uma contagem, o que o caminho local imprime em `alcançável (N)`); as
 * negadas devolvem só o desfecho, então a da vault nunca traz o segredo, nem se um dia ler.
 */
export function sondasNuvem(b: Baseline): SondasExecutivas {
  const sondas: Record<string, SondaExecutiva> = {};
  b.sondasNegadas.forEach((s, i) => {
    sondas[`negada_${i + 1}`] = { sql: s.sql };
  });
  b.sondasPermitidas.forEach((s, i) => {
    sondas[`permitida_${i + 1}`] = { sql: s.sql, devolverValor: true };
  });
  return { papel: PAPEL, sondas };
}

type Medicao = {
  papel: Record<string, string>;
  schemas: Record<string, string>;
  tabelas: Record<string, string>;
  cobertura: Record<string, { total: string; semSelect: string }>;
  netAcl: string[];
  pgNet: string | null;
  ponteReloptions: string | null;
  ponteColunas: string[];
  authColAcl: string[];
  membros: string[];
};

/** Lê a saída do catálogo — a do `psql -tA` ou as linhas da nuvem, que são as mesmas. */
function lerMedicao(saida: string, b: Baseline): Medicao {
  const m: Medicao = {
    papel: {}, schemas: {}, tabelas: {}, cobertura: {}, netAcl: [], pgNet: null,
    ponteReloptions: null, ponteColunas: [], authColAcl: [], membros: [],
  };
  let lidas = 0;
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith('ROW|')) continue; // descarta o eco de SET do psqlrc e linhas em branco
    lidas++;
    const campos = linha.split('|');
    const grupo = campos[1];
    if (grupo === 'PAPEL') m.papel[campos[2]] = campos.slice(3).join('|');
    else if (grupo === 'SCHEMA') m.schemas[campos[2]] = campos[3];
    else if (grupo === 'TABELA') m.tabelas[campos[2]] = campos[3];
    else if (grupo === 'COBERTURA') m.cobertura[campos[2]] = { total: campos[3], semSelect: campos[4] };
    else if (grupo === 'PGNET') m.pgNet = campos[3];
    else if (grupo === 'PONTE') m.ponteReloptions = campos[3];
    else if (grupo === 'PONTECOL') m.ponteColunas.push(campos[2]);
    else if (grupo === 'AUTHCOL') m.authColAcl.push(`${campos[2]}|${campos.slice(3).join('|')}`);
    else if (grupo === 'MEMBRO') m.membros.push(campos.slice(2).join('|'));
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
  // PONTECOL, AUTHCOL e MEMBRO ficam FORA do piso: zero linha ali é regressão de verdade (view
  // apagada, tabela-fonte sumida, aresta removida) e o comparador de conjunto a reporta como exit 1.
  // Entrassem no piso, a mesma regressão sairia como exit 2 — severidade errada e mensagem enganosa.
  const pisoFixo =
    5 + b.schemasComAlcance.length + b.schemasSemAlcance.length + b.tabelasLegiveis.length +
    b.schemasCobertura.length + 1 /* PGNET */ + 1 /* PONTE|reloptions */;
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
 * O erro que o `psql -v VERBOSITY=verbose` imprime (`ERROR:  42501: permission denied…`, ou
 * `ERRO:` num servidor em pt_BR): a SQLSTATE e a mensagem. A severidade varia com o locale; a
 * SQLSTATE não. Sem SQLSTATE (o cliente falando — conexão caída), fica o texto cru e SQLSTATE vazia.
 */
export function erroDoPsql(texto: string): { sqlstate: string; mensagem: string } {
  const m = /(?:^|\s)[A-Z]+:\s+([0-9A-Z]{5}):\s+(.*)$/m.exec(texto);
  if (m) return { sqlstate: m[1], mensagem: m[2].trim() };
  return { sqlstate: '', mensagem: texto.replace(/\s+/g, ' ').trim() };
}

/** O erro de uma sonda como sai no relatório — a MESMA forma pelo psql e pela nuvem. */
function detalheDoErro(r: { sqlstate: string; mensagem: string }): string {
  return `${r.sqlstate === '' ? '' : `${r.sqlstate}: `}${r.mensagem}`.replace(/\s+/g, ' ').trim().slice(0, 160);
}

type VereditoSonda = { rotulo: string; ok: boolean; obs: string };

/**
 * A sonda executiva negada: a consulta, RODADA como o papel, tem de falhar com a SQLSTATE dela.
 * A SQLSTATE é ASCII e invariante a locale: é o único pedaço do erro que sobrevive a uma troca de
 * `lc_messages` no servidor (medido: esta prod fala pt_BR — "LINHA"/"DICA").
 */
function julgarNegada(s: Baseline['sondasNegadas'][number], r: ResultadoSonda): VereditoSonda {
  const esperada = s.sqlstate ?? '42501';
  // A consulta PASSOU. O alcance voltou.
  if (r.tipo === 'rodou') return { rotulo: s.rotulo, ok: false, obs: 'consulta teve SUCESSO — o alcance foi restaurado' };
  const negado = r.sqlstate === esperada;
  return {
    rotulo: s.rotulo,
    ok: negado,
    obs: negado ? `negado com ${esperada}` : `falhou SEM ${esperada} (outro erro): ${detalheDoErro(r)}`,
  };
}

/**
 * O espelho da sonda negativa: a consulta tem de SUCEDER. Existe porque o `GRANT SELECT` de 7
 * colunas de 25/08 ficou INERTE no catálogo por falta de USAGE de schema — "concedido" e
 * "alcançável" são estados diferentes, e só o executor sabe qual é qual. Se a ponte cair, esta
 * sonda é a que percebe; nenhuma asserção de catálogo perceberia.
 */
function julgarPermitida(s: Baseline['sondasPermitidas'][number], r: ResultadoSonda): VereditoSonda {
  if (r.tipo === 'rodou') return { rotulo: s.rotulo, ok: true, obs: `alcançável (${r.valor})` };
  return { rotulo: s.rotulo, ok: false, obs: `consulta FALHOU — o alcance caiu: ${detalheDoErro(r)}` };
}

/** O que o mundo dá à sentinela — injetado para o teste medir os dois caminhos com a MESMA prod. */
export interface Dependencias {
  /** O `CLAUDE_RO_BASELINE_TEST_JSON` (só o harness o define). */
  baselineDeTeste: string | undefined;
  /** O catálogo pelo `psql-ro` (`-tA -c`): SQL → stdout. Falha LANÇA. */
  psql: (sql: string) => string;
  /** UMA sonda executiva pelo `psql-ro`, que conecta COMO o `claude_ro`. */
  sonda: (sql: string) => ResultadoSonda;
  /** O conteúdo do arquivo do `--dados-nuvem`. */
  lerArquivo: (caminho: string) => string;
  agora: () => Date;
}

export interface Execucao {
  exit: 0 | 1 | 2;
  saida: string[];
  erro: string[];
}

/** O desfecho de cada sonda, na ordem do baseline, pela nuvem — sonda sem desfecho é "não medi". */
function desfechosDaNuvem(dados: DadosNuvem, prefixo: string, n: number): ResultadoSonda[] {
  return Array.from({ length: n }, (_, i) => {
    const r = dados.sondas.get(`${prefixo}_${i + 1}`);
    if (r === undefined) erroFatal(`transporte da nuvem: a sonda '${prefixo}_${i + 1}' voltou sem desfecho`);
    return r;
  });
}

function medirEJulgar(argv: readonly string[], deps: Dependencias, saida: string[], erro: string[]): 0 | 1 {
  let nuvem: ReturnType<typeof separarFlagsNuvem>;
  try {
    nuvem = separarFlagsNuvem(argv);
  } catch (e) {
    erroFatal(`${(e as Error).message}. ${USO}`);
  }
  if (nuvem.resto.length > 0) erroFatal(`argumento desconhecido: ${nuvem.resto.join(' ')}. ${USO}`);

  // Na 1ª rodada da nuvem o stdout É o SQL que o modelo copia verbatim: aviso nenhum pode cair nele.
  const b = carregarBaseline(deps.baselineDeTeste, nuvem.sqlNuvem ? (l) => erro.push(l) : (l) => saida.push(l));

  // A 1ª metade do transporte: só o texto — quem o executa é o modelo, pelo `query_database`.
  if (nuvem.sqlNuvem) {
    saida.push(gerarSqlNuvem(consultasNuvem(b), CONSUMIDOR_NUVEM, sondasNuvem(b)));
    return 0;
  }

  // A leitura de prod: o `psql-ro` no Mac, ou a resposta da nuvem já validada. O catálogo vem
  // ANTES das sondas nos dois caminhos — medição de catálogo quebrada é exit 2 sem sonda nenhuma.
  let m: Medicao;
  let negadas: ResultadoSonda[];
  let permitidas: ResultadoSonda[];
  if (nuvem.dadosNuvem === null) {
    let catalogo: string;
    try {
      catalogo = deps.psql(montarQuery(b));
    } catch (e) {
      // psql-ro ausente, sem rede, credencial revogada e SQL inválido caem todos aqui.
      erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
    }
    m = lerMedicao(catalogo, b);
    // Um psql por sonda, de propósito — a asserção é sobre o statement chegar ao fim, e um
    // `UNION ALL` com as outras abortaria a query inteira no primeiro erro.
    negadas = b.sondasNegadas.map((s) => deps.sonda(s.sql));
    permitidas = b.sondasPermitidas.map((s) => deps.sonda(s.sql));
  } else {
    let dados: DadosNuvem;
    try {
      dados = lerDadosNuvem(
        deps.lerArquivo(nuvem.dadosNuvem),
        { consultas: consultasNuvem(b), consumidor: CONSUMIDOR_NUVEM, sondas: sondasNuvem(b) },
        deps.agora(),
      );
    } catch (e) {
      const msg = (e as Error).message;
      erroFatal(
        `transporte da nuvem: ${msg}` +
          (msg.includes('TRANSPORTE_SONDA_PAPEL')
            ? `\n   → o conector entra como postgres: no SQL Editor, GRANT ${PAPEL} TO postgres WITH INHERIT FALSE, SET TRUE;` +
              ' (docs/agent/database.md §1)'
            : ''),
      );
    }
    m = lerMedicao(dados.saidas.get('catalogo') ?? '', b);
    negadas = desfechosDaNuvem(dados, 'negada', b.sondasNegadas.length);
    permitidas = desfechosDaNuvem(dados, 'permitida', b.sondasPermitidas.length);
  }

  // ── veredito ────────────────────────────────────────────────────────────────────────────────
  // Daqui para baixo o juízo não sabe de onde veio a linha — é o ponto: o transporte não pode
  // virar outro juiz.
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

  for (const s of b.schemasCobertura) {
    const c = m.cobertura[s];
    if (!c) div.push(`cobertura de ${s}: linha ausente na medição`);
    else {
      cmp(`objetos de ${s} SEM SELECT`, '0', c.semSelect);
      if (c.semSelect === '0') ok.push(`cobertura de ${s}: ${c.total} objetos (r/p/v/m), todos com SELECT`);
    }
  }

  cmp('versão do pg_net', b.pgNetVersion, m.pgNet ?? '(sem linha)');

  /** Conjunto contra conjunto, para acusar nos DOIS sentidos — fechou, abriu e apareceu novo. */
  const cmpConjunto = (
    rotulo: string,
    esperadosArr: readonly string[],
    medidosArr: readonly string[],
    okFmt: (n: number) => string,
  ) => {
    const esperados = new Set(esperadosArr);
    const medidos = new Set(medidosArr);
    const sumiram = [...esperados].filter((x) => !medidos.has(x)).sort();
    const surgiram = [...medidos].filter((x) => !esperados.has(x)).sort();
    if (sumiram.length === 0 && surgiram.length === 0) {
      ok.push(okFmt(medidos.size));
      return;
    }
    div.push(
      `${rotulo} mudou (${sumiram.length} sumiram, ${surgiram.length} surgiram)` +
        sumiram.map((x) => `\n      − ${x}`).join('') +
        surgiram.map((x) => `\n      + ${x}`).join(''),
    );
  };

  cmpConjunto(
    'ACL do schema net',
    b.netAcl,
    m.netAcl,
    (n) => `ACL do schema net: ${n} entradas, idênticas ao baseline`,
  );

  // Quem pode VIRAR o papel. Um membro novo (`authenticated`, um papel de app) é leitura com
  // BYPASSRLS para quem o tiver; a aresta da nuvem sumindo deixa as sondas sem papel na nuvem.
  cmpConjunto(
    `membros de ${PAPEL} (quem pode virar o papel)`,
    b.membros,
    m.membros,
    (n) => `membros de ${PAPEL}: ${n} aresta(s), idênticas ao baseline (quem pode virar o papel)`,
  );

  // ── a ponte de view (#2275) ──────────────────────────────────────────────────────────────────
  // O invoker vem PRIMEIRO: com ele resetado, o ACL por coluna deixa de ser barreira e as duas
  // asserções seguintes passariam a medir um mundo onde `token` já é legível pelo OWNER.
  const ponteNome = `${b.ponte.schema}.${b.ponte.relacao}`;
  const reloptions = m.ponteReloptions ?? '(sem linha)';
  if (reloptions === 'AUSENTE') {
    div.push(
      `ponte ${ponteNome} NÃO EXISTE — a telemetria de login morreu\n` +
        `      recrie com o bloco de db/reconciliacao-claude-ro-private-auth.sql`,
    );
  } else if (reloptions === 'SEM_RELOPTIONS') {
    div.push(
      `ponte ${ponteNome} perdeu o security_invoker\n` +
        `      um CREATE OR REPLACE VIEW sem o WITH RESETA a opção (database.md §4): a view voltou\n` +
        `      a ler como o OWNER e o ACL por coluna DEIXOU de ser barreira`,
    );
  } else if (b.ponte.invokerAceitos.some((v) => reloptions.split(',').includes(v))) {
    ok.push(`ponte ${ponteNome}: ${reloptions} (lê como o CALLER — o ACL por coluna segue barreira)`);
  } else {
    div.push(
      `ponte ${ponteNome} com reloptions inesperado\n` +
        `      esperado: um de ${b.ponte.invokerAceitos.join(' | ')}\n` +
        `      medido:   ${reloptions}`,
    );
  }

  // A asserção de SEGURANÇA, separada do drift: presença de `token`/`parent` na projeção é P0.
  const proibidasNaPonte = b.ponte.colunasProibidas.filter((c) => m.ponteColunas.includes(c));
  if (proibidasNaPonte.length > 0) {
    div.push(
      `🚨 ponte ${ponteNome} projeta ${proibidasNaPonte.join('/')}\n` +
        `      isto REABRE a escalada: refresh token vivo troca-se por JWT de master em\n` +
        `      POST /auth/v1/token?grant_type=refresh_token, que só pede a anon key (pública)`,
    );
  } else if (m.ponteColunas.length > 0) {
    ok.push(`ponte ${ponteNome} não projeta ${b.ponte.colunasProibidas.join('/')}`);
  }

  // E o drift da projeção, nas duas direções: coluna que SAI mata metade da telemetria em silêncio.
  cmpConjunto(
    `projeção da ponte ${ponteNome}`,
    b.ponte.colunas,
    m.ponteColunas,
    (n) => `projeção da ponte ${ponteNome}: ${n} colunas, idênticas ao baseline`,
  );

  // ── ACL por COLUNA da tabela-fonte (a 2ª barreira, lida de pg_attribute.attacl) ─────────────
  const fonteNome = `${b.authColAcl.schema}.${b.authColAcl.tabela}`;
  cmpConjunto(
    `ACL por coluna de ${fonteNome}`,
    b.authColAcl.entradas,
    m.authColAcl,
    (n) =>
      `ACL por coluna de ${fonteNome}: ${n} colunas, idênticas ao baseline ` +
      `(${b.ponte.colunasProibidas.join('/')} SEM ACL próprio)`,
  );

  for (const s of b.sondasNegadas.map((sonda, i) => julgarNegada(sonda, negadas[i]))) {
    if (s.ok) ok.push(`sonda ${s.rotulo}: ${s.obs}`);
    else div.push(`sonda ${s.rotulo}\n      ${s.obs}`);
  }
  for (const s of b.sondasPermitidas.map((sonda, i) => julgarPermitida(sonda, permitidas[i]))) {
    if (s.ok) ok.push(`sonda + ${s.rotulo}: ${s.obs}`);
    else div.push(`sonda + ${s.rotulo}\n      ${s.obs}`);
  }

  saida.push(`\n🔒 sentinela do endurecimento de \`${PAPEL}\` — baseline de 2026-08-25\n`);
  for (const l of ok) saida.push(`  ✅ ${l}`);
  if (div.length === 0) {
    saida.push(`\n✅ ${ok.length} asserções batem. O endurecimento continua de pé.\n`);
    return 0;
  }
  saida.push('');
  for (const l of div) erro.push(`  ❌ ${l}`);
  erro.push(
    `\n❌ ${div.length} divergência(s). O endurecimento de \`${PAPEL}\` REGREDIU ou drifou.\n` +
      `   Contexto: docs/historico/revoke-que-nao-revoga.md · docs/agent/database.md §1\n` +
      `   Se a divergência for só no ACL do net e a versão do pg_net mudou, a causa é um upgrade\n` +
      `   da extensão feito pelo Supabase — reavalie e atualize o baseline com o novo estado.\n`,
  );
  return 1;
}

/** A execução inteira, com o mundo injetado. Nunca lança: falha de medição vira exit 2 com o motivo. */
export function executar(argv: readonly string[], deps: Dependencias): Execucao {
  const saida: string[] = [];
  const erro: string[] = [];
  let exit: 0 | 1 | 2;
  try {
    exit = medirEJulgar(argv, deps, saida, erro);
  } catch (e) {
    // Exceção INESPERADA também é "não medi" (2): o exit 1 cru do bun seria lido como divergência.
    erro.push(`❌ ${e instanceof MedicaoIncompleta ? e.message : `exceção inesperada: ${(e as Error).message}`}`);
    exit = 2;
  }
  return { exit, saida, erro };
}

function sondaReal(sql: string): ResultadoSonda {
  try {
    const saida = execFileSync(PSQL, ['-v', 'VERBOSITY=verbose', '-tA', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // exit 0 = a consulta PASSOU; o valor é a última linha (o psqlrc ecoa dois `SET` antes).
    return { tipo: 'rodou', valor: saida.trim().split('\n').pop() ?? '' };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
    return { tipo: 'erro', ...erroDoPsql(`${err.stderr ?? ''}${err.stdout ?? ''}`) };
  }
}

if (import.meta.main) {
  const r = executar(process.argv.slice(2), {
    baselineDeTeste: process.env.CLAUDE_RO_BASELINE_TEST_JSON,
    psql: (sql) => execFileSync(PSQL, ['-tA', '-c', sql], { encoding: 'utf8' }),
    sonda: sondaReal,
    lerArquivo: lerArquivoDadosNuvem,
    agora: () => new Date(),
  });
  for (const l of r.saida) console.log(l);
  for (const l of r.erro) console.error(l);
  process.exit(r.exit);
}
