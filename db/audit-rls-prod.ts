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
 *
 * O 4º eixo (2026-08-28) é o NEGATIVO dos outros três: mede se a declaração de lacuna em BLOCO
 * (`LACUNAS_POR_GRUPO`) ainda descreve prod. Os eixos 1-3 reconciliam o contrato contra o banco;
 * ninguém reconciliava a DECLARAÇÃO contra o banco, e uma migration que gateasse mais uma tabela
 * por `cap_carteira_ler` deixava a contagem declarada falsa sem nada ficar vermelho (§7.2).
 * Dente: db/test-audit-rls-prod.sh (PG17 descartável — sabota cada regra, exige vermelho, exige o
 *        verde de volta, e prova o EFEITO da RLS sob SET ROLE authenticated + GUC do JWT)
 *
 * Em TypeScript e não em bash pelo mesmo motivo do audit de grants: assim ele IMPORTA o contrato
 * que o CI já tipa, em vez de duplicar a lista num `.sql` que envelheceria em silêncio.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compararRlsProd, rotuloGrupo, type MedicaoRls, type MedPolicy } from '../scripts/lib/authz-rls';
import {
  AUTHZ_RLS_ESPERADO,
  AUTHZ_RLS_PREDICADOS,
  LACUNAS_POR_GRUPO,
  PREDICADOS_PLATAFORMA,
  type TabelaRls,
  type PredicadoEsperado,
  type LacunaGrupo,
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
  grupos: LacunaGrupo[];
  /** `true` quando o contrato veio de `AUTHZ_RLS_TEST_JSON`. Existe para que o piso de vacuidade
   *  do eixo 4 valha só para o contrato REAL: o harness monta recortes deliberadamente pequenos. */
  sintetico: boolean;
}

/** Contrato real, ou o sintético quando o harness PG17 injeta AUTHZ_RLS_TEST_JSON. */
function carregarContrato(): Contrato {
  const raw = process.env.AUTHZ_RLS_TEST_JSON;
  if (!raw) {
    return {
      contrato: AUTHZ_RLS_ESPERADO,
      predicados: AUTHZ_RLS_PREDICADOS,
      plataforma: PREDICADOS_PLATAFORMA,
      grupos: LACUNAS_POR_GRUPO,
      sintetico: false,
    };
  }
  console.log('⚠️  contrato de TESTE (AUTHZ_RLS_TEST_JSON) — não é o contrato real do repo.');
  try {
    const p = JSON.parse(raw) as {
      contrato: Record<string, TabelaRls>;
      predicados?: Record<string, PredicadoEsperado>;
      plataforma?: string[];
      grupos?: LacunaGrupo[];
    };
    return {
      contrato: p.contrato,
      predicados: p.predicados ?? {},
      plataforma: new Set(p.plataforma ?? []),
      grupos: p.grupos ?? [],
      sintetico: true,
    };
  } catch (e) {
    erroFatal(`AUTHZ_RLS_TEST_JSON não é JSON válido: ${(e as Error).message}`);
  }
}

/**
 * Uma invocação do psql para as cinco medições. Cada uma sai em UMA linha, prefixada por
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
 *
 * ═══ A 4ª medição é um FECHO TRANSITIVO, e a escolha da fonte foi MEDIDA ═══
 *
 * `pg_depend` registra policy→função e NÃO registra função→função (o catálogo só rastreia o
 * corpo de uma função SQL quando ela é criada com o corpo-padrão `BEGIN ATOMIC`; corpo CITADO
 * — `AS $$ … $$`, que é como toda migration deste banco escreve — é string opaca para ele). A
 * descoberta do 2º nível em diante precisa de outra fonte, e as três candidatas foram medidas
 * em prod (2026-08-28, via psql-ro) antes de escolher:
 *
 *   · **`pg_proc.prosqlbody`** (árvore de parse, PG14+) — seria a fonte honesta, e está VAZIA
 *     neste banco: **1 função em 577** nos schemas nossos (`public`/`private`/`auth`/
 *     `extensions`) tem `prosqlbody` não-nulo, e nenhuma das 10 funções-predicado tem. É
 *     consequência do corpo citado acima, mais o fato de `public.fin_user_can_access` ser
 *     plpgsql, a que `prosqlbody` nunca se aplica. Opção descartada por MEDIÇÃO, não por gosto.
 *   · **`prosrc` + token NU** (qualquer identificador que case um `proname`) — recall máximo e
 *     **4 falso-positivos em 15 arestas**, todos da armadilha do database.md §4: `auth.jwt` sai
 *     da STRING `'request.jwt.claim.sub'` e `auth.role` sai da COLUNA `role` de
 *     `WHERE … AND role = _role`. Ruído de 27% numa allowlist fail-closed é ruído que treina a
 *     ignorar a allowlist.
 *   · **`prosrc` + token `nome(` resolvido pelo CATÁLOGO** ← escolhida. **11 arestas, 0
 *     falso-positivo** medido. O ponto que a separa de "regex sobre corpo de função", que é a
 *     armadilha conhecida daqui: a regex **não decide nada** — ela só PROPÕE candidatos, e quem
 *     resolve é `pg_proc`. E o casamento é por `proname` NU, sem schema: pega a chamada
 *     qualificada e a não-qualificada, todas as sobrecargas, e a função que SOMBREIA uma
 *     builtin (`public.now()`) — over-inclusivo por construção, que é a direção certa quando
 *     falso-negativo é o modo de falha caro e falso-positivo custa uma mensagem de erro.
 *
 * Os buracos de recall que sobram, medidos e não deduzidos: SQL dinâmico (`EXECUTE`) em
 * plpgsql, que nenhum método estático alcança — **0 funções** que gateiam policy o usam; a
 * sintaxe de seleção de campo (`SELECT t.f FROM t`, equivalente a `f(t)`), que não aparece em
 * corpo nenhum daqui; e nome de função fora de `[A-Za-z_][A-Za-z0-9_]*` — **0 em 635**. Os
 * schemas de sistema ficam fora de `alvo` porque não são graváveis no Supabase (as duas únicas
 * builtins alcançadas hoje, `current_setting` e `now`, são `lang=internal`: não têm corpo SQL
 * que alguém possa reescrever no SQL Editor) — e o sombreamento delas, que É gravável, entra
 * pelo casamento por nome nu.
 */
function sqlLit(x: string): string {
  return `'${x.replace(/'/g, "''")}'`;
}

/** O `VALUES` do eixo 4, ou a lista vazia. Fail-closed na FORMA: um `tipo` que este montador não
 *  conhece vira exceção, nunca um `CASE` que cai no `ELSE` e mede zero tabelas — medir zero se
 *  apresentaria como "o grupo encolheu para 0", um diagnóstico plausível e errado. */
function sqlGrupos(grupos: readonly LacunaGrupo[]): string {
  if (grupos.length === 0) return `SELECT 'JSON:grupos|[]';`;
  const linhas = grupos.map((g) => {
    const rot = sqlLit(rotuloGrupo(g.def));
    if (g.def.tipo === 'predicado') return `(${rot},'predicado',${sqlLit(g.def.predicado)})`;
    if (g.def.tipo === 'prefixo') return `(${rot},'prefixo',${sqlLit(g.def.prefixo)})`;
    throw new Error(`montarQuery: grupo com tipo desconhecido — ${JSON.stringify(g.def)}`);
  });
  // `starts_with` e NÃO `LIKE prefixo||'%'`: em LIKE o `_` é CORINGA de um caractere, então
  // `fin_%` casaria `financeiro_x` e o grupo mediria a mais em silêncio. Medido: os dois devolvem
  // 41 hoje por acaso (não há tabela `finX*`), o que é exatamente como esse bug sobreviveria.
  return `
SELECT 'JSON:grupos|'||coalesce(jsonb_agg(x ORDER BY x.grupo)::text,'[]') FROM (
  SELECT g.rot AS grupo, coalesce(m.tabelas,'[]'::jsonb) AS tabelas
    FROM (VALUES ${linhas.join(',')}) AS g(rot,tipo,arg)
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(c.relname) AS tabelas
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'
         AND CASE WHEN g.tipo='prefixo' THEN starts_with(c.relname, g.arg)
                  ELSE EXISTS (SELECT 1 FROM pg_policy pol
                                 JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=pol.oid
                                                 AND d.refclassid='pg_proc'::regclass
                                 JOIN pg_proc p ON p.oid=d.refobjid
                                 JOIN pg_namespace pn ON pn.oid=p.pronamespace
                                WHERE pol.polrelid=c.oid AND pn.nspname||'.'||p.proname = g.arg)
             END) m ON true) x;
`;
}

/** Teto de profundidade da recursão. Não é performance: é a garantia de terminação num grafo com
 *  ciclo (`a` chama `b` chama `a`). Saturar o teto é medição possivelmente TRUNCADA — e truncar
 *  em silêncio é exatamente o falso-negativo que este eixo existe para fechar —, então `medir()`
 *  transforma saturação em exit 2. Medido em prod: o grafo real tem profundidade 2. */
const TETO_NIVEL = 8;

function montarQuery(chaves: string[], grupos: readonly LacunaGrupo[]): string {
  const lista = chaves.map(sqlLit).join(',');
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

WITH RECURSIVE alvo AS (
  SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     AND p.proname ~ '^[A-Za-z_][A-Za-z0-9_]*$'
), fecho AS (
  SELECT f.oid, 1 AS nivel
    FROM unnest(${tabs}) t
    JOIN pg_policy p ON p.polrelid = to_regclass(t)
    JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=p.oid
                    AND d.refclassid='pg_proc'::regclass
    JOIN pg_proc f ON f.oid = d.refobjid
  UNION
  SELECT a.oid, fc.nivel + 1
    FROM fecho fc
    JOIN pg_proc src ON src.oid = fc.oid
    JOIN alvo a ON a.oid <> src.oid
               AND src.prosrc ~ ('\\m'||a.proname||'\\M[[:space:]]*\\(')
   WHERE fc.nivel < ${TETO_NIVEL}
), nos AS (SELECT oid, min(nivel) AS nivel FROM fecho GROUP BY oid)
SELECT 'JSON:predicados|'||coalesce(jsonb_agg(x)::text,'[]') FROM (
  SELECT n.nspname||'.'||f.proname AS funcao, f.prosecdef AS secdef,
         coalesce(array_to_string(f.proconfig,','),'') AS cfg,
         md5(regexp_replace(btrim(f.prosrc), '\\s+', ' ', 'g')) AS "srcMd5",
         nos.nivel AS nivel,
         coalesce((SELECT string_agg(nc.nspname||'.'||c.proname, ', '
                                     ORDER BY nc.nspname||'.'||c.proname)
                     FROM nos n2 JOIN pg_proc c ON c.oid = n2.oid
                     JOIN pg_namespace nc ON nc.oid = c.pronamespace
                    WHERE c.oid <> f.oid
                      AND f.proname ~ '^[A-Za-z_][A-Za-z0-9_]*$'
                      AND c.prosrc ~ ('\\m'||f.proname||'\\M[[:space:]]*\\(')), '') AS via
    FROM nos JOIN pg_proc f ON f.oid = nos.oid
    JOIN pg_namespace n ON n.oid = f.pronamespace
   ORDER BY 1) x;
${sqlGrupos(grupos)}`;
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

function medir(chaves: string[], grupos: readonly LacunaGrupo[]): MedicaoRls {
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(chaves, grupos)], { encoding: 'utf8' });
  } catch (e) {
    // psql-ro ausente, sem rede, sintaxe rejeitada ou timeout caem todos aqui.
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }

  const universal = extrair(saida, 'universal') as MedicaoRls['universal'];
  const tabelas = extrair(saida, 'tabelas') as MedicaoRls['tabelas'];
  const policies = extrair(saida, 'policies') as MedPolicy[];
  const predicados = extrair(saida, 'predicados') as MedicaoRls['predicados'];
  const gruposMed = extrair(saida, 'grupos') as MedicaoRls['grupos'];

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
  if (gruposMed.length !== grupos.length) {
    erroFatal(
      `medição inconsistente: ${gruposMed.length} linha(s) de grupo para ${grupos.length} ` +
        `declarado(s). O VALUES devolve uma linha por grupo DECLARADO sempre, inclusive para o ` +
        `que não casa tabela nenhuma — vir menos significa que a query ou o parser quebrou.`,
    );
  }
  // Saturação do teto = fecho possivelmente INCOMPLETO. Uma função não descoberta não é
  // congelada, e não-congelada é o buraco silencioso que este eixo fecha — então truncar tem de
  // gritar, nunca sair 0 com uma lista curta. Aumentar `TETO_NIVEL` é a correção; o grafo medido
  // em prod tem profundidade 2, então saturar 8 é sinal de ciclo ou de grafo que mudou de porte.
  const saturados = predicados.filter((f) => f.nivel >= TETO_NIVEL).map((f) => f.funcao);
  if (saturados.length > 0) {
    erroFatal(
      `fecho de predicados SATUROU o teto de ${TETO_NIVEL} níveis em ${saturados.length} ` +
        `função(ões) (${saturados.join(', ')}). A lista pode estar TRUNCADA — função não ` +
        `descoberta é função não congelada. Suba TETO_NIVEL e re-meça; se o teto sobe sem ` +
        `estabilizar, o grafo tem ciclo e ele é o achado.`,
    );
  }
  return { universal, tabelas, policies, predicados, grupos: gruposMed };
}

function main(): void {
  const { contrato, predicados, plataforma, grupos, sintetico } = carregarContrato();
  const chaves = Object.keys(contrato);
  if (chaves.length === 0) erroFatal('contrato de RLS vazio — não há o que reconciliar.');
  // Piso de vacuidade do eixo 4, no contrato REAL: `for` sobre lista vazia não itera, então
  // esvaziar `LACUNAS_POR_GRUPO` desligaria o eixo inteiro com ✅. (O gate estático de
  // `scripts/authz-rls.test.ts` guarda o mesmo piso no CI, onde não há psql-ro; este aqui é o que
  // vale na execução contra prod, que é onde o operador lê o verde.)
  if (!sintetico && grupos.length === 0) {
    erroFatal(
      'LACUNAS_POR_GRUPO vazio — o eixo 4 não teria o que conferir e o ✅ afirmaria uma ' +
        'declaração que não existe. Lista de grupos vazia é contrato quebrado, não "sem lacunas".',
    );
  }

  const med = medir(chaves, grupos);
  const findings = compararRlsProd(med, contrato, predicados, plataforma, grupos);
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
  // A profundidade entra no veredito porque ela é o que separa "conferi o 1º nível" de "conferi
  // o FECHO": um dia em que a medição voltasse rasa (profundidade 1 num grafo que tem 2) sairia
  // verde e diria menos do que hoje — e o operador precisa ver isso na linha, não no código.
  const prof = med.predicados.reduce((mx, f) => Math.max(mx, f.nivel), 0);
  const n2 = med.predicados.filter((f) => f.nivel > 1).length;
  // O eixo 4 entra no denominador com a UNIÃO distinta (os grupos se sobrepõem — `cap_carteira_ler`
  // e `carteira_visivel_para` compartilham tabelas medidas), e com a subtração à vista: sem o
  // "N curada(s)" o leitor não distingue "78 tabelas fora do contrato" de "78 conferidas e
  // cobertas", que são afirmações opostas.
  const uniao = new Set(med.grupos.flatMap((g) => g.tabelas));
  const curadasNaUniao = [...uniao].filter((t) => `public.${t}` in contrato).length;
  console.log(
    `✅ audit-rls — ${med.universal.totalTabelas} tabela(s) em public com RLS ligada (0 desligada); ` +
      `${chaves.length} tabela(s) curada(s), ${med.policies.length} policy(ies) e ` +
      `${med.predicados.length} funcao(oes)-predicado batem com o contrato ` +
      `(fecho transitivo, profundidade ${prof}; ${n2} alcancada(s) so por outra funcao); ` +
      `${grupos.length} grupo(s) de lacuna conferido(s) — ${uniao.size} tabela(s) distinta(s) no ` +
      `grafo, ${curadasNaUniao} curada(s), ${uniao.size - curadasNaUniao} lacuna(s).`,
  );
}

main();
