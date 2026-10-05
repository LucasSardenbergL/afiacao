/**
 * deriva-corpo.test.ts — a lógica pura do sensor `deriva:corpo:prod`.
 *
 * Motivação (medida em 2026-09-26, `docs/historico/deriva-corpo-sem-sensor.md`): das 83 funções que
 * o eixo de corpo do gate do pacote chamava de DERIVA, 77 eram o MESMO código com outro espaço e
 * sem comentário. Um sensor que alarmasse nelas seria desligado na primeira semana; um que as
 * ignorasse por "whitespace" iguala `'a  b'` e `'a b'`. O critério é a sequência de TOKENS: espaço
 * e comentário fora, conteúdo de literal DENTRO.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { idFinding } from './authz-carimbo';
import { md5Exato } from './migration-objects';
import { AMOSTRA_CORPO_JS, FORMATO_SONDA, TOKEN_SIM, type VereditoPrecondicao } from './precondicao-banco';

import {
  alvosDePatch,
  identidadeDosArgumentos,
  julgarDeriva,
  lerBaseline,
  md5DeTokens,
  mesmosTokens,
  modelarRepo,
  montarSondaDeriva,
  parsearSondaDeriva,
  relatarDeriva,
  remocoesDe,
  saidaDerivaComoPsql,
  textosDaLeitura,
  tokensSql,
  vigenciaPorNome,
} from './deriva-corpo';
import { mesmosTokensNoModo } from './tokens-sql';

describe('tokensSql — "cosmético" é mesma sequência de tokens, nunca "mesmo texto sem espaço"', () => {
  it('espaço, quebra de linha e comentário não contam', () => {
    expect(mesmosTokens('SELECT  1 -- nota\n FROM t;', 'select 1 from t;')).toBe(true);
    expect(mesmosTokens('SELECT /* bloco */ 1;', 'SELECT 1;')).toBe(true);
  });

  it('o conteúdo de literal CONTA — o colapso de whitespace do audit igualava estes dois', () => {
    expect(mesmosTokens("SELECT 'a  b';", "SELECT 'a b';")).toBe(false);
  });

  it('`--` dentro de literal é texto, não comentário', () => {
    expect(mesmosTokens("SELECT '--x';", "SELECT '';")).toBe(false);
    expect(tokensSql("SELECT '--x';")).toContain("'--x'");
  });

  it("E-string com aspa escapada é UM literal, e o `E` faz parte dele (E'\\n' ≠ '\\n')", () => {
    expect(tokensSql("SELECT E'a\\'b', 1;")).toEqual(['select', "E'a\\'b'", ',', '1', ';']);
    expect(mesmosTokens("SELECT E'\\n';", "SELECT '\\n';")).toBe(false);
  });

  it('dollar-quote aninhado é literal: o SQL dinâmico dentro dele é comparado como TEXTO', () => {
    expect(mesmosTokens('EXECUTE $q$ SELECT 1 $q$;', 'EXECUTE $q$ SELECT  1 $q$;')).toBe(false);
    expect(tokensSql('EXECUTE $q$ SELECT 1 $q$;')).toEqual(['execute', '$q$ SELECT 1 $q$', ';']);
  });

  it('parâmetro posicional `$1` é UM token (PARAM do scan.l) e não abre dollar-quote', () => {
    expect(tokensSql('SELECT $1, $2;')).toEqual(['select', '$1', ',', '$2', ';']);
  });

  it('palavra sem aspas é caixa-insensível; identificador CITADO não', () => {
    expect(mesmosTokens('SELECT Foo FROM T;', 'select foo from t;')).toBe(true);
    expect(mesmosTokens('SELECT "Foo";', 'SELECT "foo";')).toBe(false);
  });

  it('número conta dígito a dígito (1.0 ≠ 1.00: escala de numeric)', () => {
    expect(mesmosTokens('SELECT 1.0;', 'SELECT 1.00;')).toBe(false);
  });

  it('operador de vários caracteres é UM token, com ou sem espaço em volta', () => {
    expect(mesmosTokens('a<>b AND x::int', 'a <> b AND x :: int')).toBe(true);
    expect(tokensSql('x := y->>z')).toEqual(['x', ':=', 'y', '->>', 'z']);
  });

  it('o corpo compactado que prod tinha em 2026-09-26 bate com o do repo (caso real, detectar_skus_sem_grupo reduzido)', () => {
    const repo = `
  UPDATE eventos_outlier eo
  SET status = 'excluido',
      decidido_em = now()
  WHERE eo.tipo = 'sku_sem_grupo'
    AND eo.status = 'pendente'; -- auto-resolve`;
    const prod = `UPDATE eventos_outlier eo SET status='excluido', decidido_em=now()
  WHERE eo.tipo='sku_sem_grupo' AND eo.status='pendente';`;
    expect(mesmosTokens(repo, prod)).toBe(true);
  });
});

describe('tokensSql — o contrato léxico do PG17 (os casos do parecer Codex de 2026-09-26)', () => {
  it("mesmosTokensNoModo: N'…' com scs=off processa barra (o literal comum); com scs=on, não", () => {
    const a = "SELECT N'a\\'--desconto=10\n';";
    const b = "SELECT N'a\\'--desconto=90\n';";
    expect(mesmosTokensNoModo(a, b, false)).toBe(true);
    expect(mesmosTokensNoModo(a, b, true)).toBe(false);
  });

  it('número segue o scan.l do PG17 (medido em prod, 2026-10-05): `_` no expoente é dígito; número colado em identificador é UM token', () => {
    // SELECT 1e1_0 → 10000000000 · SELECT 1e1 _0 → 10 (alias _0) · SELECT 1abc / 1_ / 0x1Fg / 1e → trailing junk.
    expect(tokensSql('SELECT 1e1_0;')).toEqual(['select', '1e1_0', ';']);
    expect(mesmosTokens('SELECT 1e1_0;', 'SELECT 1e1 _0;')).toBe(false);
    expect(mesmosTokens('SELECT 1abc;', 'SELECT 1 abc;')).toBe(false);
    expect(mesmosTokens('SELECT 0x1Fg;', 'SELECT 0x1F g;')).toBe(false);
    expect(mesmosTokens('SELECT 1_;', 'SELECT 1 _;')).toBe(false);
    expect(mesmosTokens('SELECT 1e;', 'SELECT 1 e;')).toBe(false);
    expect(tokensSql('SELECT 1.5e-1_0, 0X1F, 1_000, 2..3;')).toEqual(['select', '1.5e-1_0', ',', '0x1f', ',', '1_000', ',', '2', '..', '3', ';']);
  });

  it('comentário de BLOCO entre literais quebra a continuação (medido em prod: syntax error); o de LINHA não', () => {
    expect(mesmosTokens("SELECT 'a'/*\n*/'b';", "SELECT 'a'\n'b';")).toBe(false);
    expect(mesmosTokens("SELECT 'a' /* c */\n'b';", "SELECT 'a'\n'b';")).toBe(false);
    expect(mesmosTokens("SELECT 'a' -- c\n'b';", "SELECT 'a'\n'b';")).toBe(true);
  });

  it('literal simples com barra depende de standard_conforming_strings — "mesmos tokens" vale nos DOIS modos', () => {
    // Medido em prod: com `SET standard_conforming_strings = off`, 'a\'--desconto=10⏎' é UM literal
    // (valor a'--desconto=10⏎); com `on` (o padrão de prod), é 'a\' + comentário.
    expect(mesmosTokens("SELECT 'a\\'--desconto=10\n';", "SELECT 'a\\'--desconto=90\n';")).toBe(false);
    // Sem barra que mude a FRONTEIRA do literal, os dois modos coincidem e os tokens não mudam:
    expect(tokensSql("SELECT 'a\\nb';")).toEqual(['select', "'a\\nb'", ';']);
  });

  it('espaço é o `space` do scan.l — [ \\t\\n\\r\\f\\v] —, não o `\\s` do JS (medido em prod, 2026-10-02)', () => {
    // `SELECT <NBSP>x FROM (SELECT 1 AS x) s` → ERROR: column " x" does not exist: o NBSP abre um
    // IDENTIFICADOR. Idem BOM e U+2028. Já `SELECT\f1` e `SELECT\v1` devolvem 1.
    expect(tokensSql('SELECT \u00a0x')).toEqual(['select', '\u00a0x']);
    expect(mesmosTokens('SELECT \u00a0x FROM t;', 'SELECT x FROM t;')).toBe(false);
    expect(mesmosTokens('SELECT 1 +\ufeff2;', 'SELECT 1 + 2;')).toBe(false);
    expect(mesmosTokens('SELECT 1 +\u20282;', 'SELECT 1 + 2;')).toBe(false);
    expect(mesmosTokens('SELECT\f1\v;', 'SELECT 1;')).toBe(true);
  });

  it('dollar-quote é OPACO: `--` dentro dele é conteúdo (o stripper compartilhado mascara os dois iguais)', () => {
    expect(mesmosTokens('BEGIN RETURN $q$a--x$q$; END;', 'BEGIN RETURN $q$a--y$q$; END;')).toBe(false);
  });

  it('tag de OUTRO nome dentro de dollar-quote é conteúdo; o literal fecha na MESMA tag', () => {
    expect(tokensSql('SELECT $a$ x $b$ y $b$ z $a$;')).toEqual(['select', '$a$ x $b$ y $b$ z $a$', ';']);
  });

  it('identificador citado com `""` escapado é UM token', () => {
    expect(tokensSql('SELECT "a""b" FROM t;')).toEqual(['select', '"a""b"', 'from', 't', ';']);
  });

  it('comentário de bloco ANINHADO conta profundidade', () => {
    expect(mesmosTokens('/* externo /* interno */ ainda comentário */ SELECT 1;', 'SELECT 1;')).toBe(true);
  });

  it("literais adjacentes: `'a'` + quebra + `'b'` (concatenação) ≠ `'a' 'b'` na mesma linha (erro de sintaxe)", () => {
    expect(mesmosTokens("SELECT 'a'\n'b';", "SELECT 'a' 'b';")).toBe(false);
  });

  it('fronteira de operador segue o scanner do PG: `x*@y` (um operador `*@`) ≠ `x* @y`', () => {
    expect(mesmosTokens('SELECT x*@y;', 'SELECT x* @y;')).toBe(false);
  });

  it('`+`/`-` no fim de operador composto sem caractere especial se separa: `a+-b` = `a + - b`', () => {
    expect(mesmosTokens('SELECT a+-b;', 'SELECT a + - b;')).toBe(true);
  });

  it('prefixo de E-string é caixa-insensível (e\'x\' = E\'x\')', () => {
    expect(mesmosTokens("SELECT e'x';", "SELECT E'x';")).toBe(true);
  });

  it('só a caixa ASCII dobra (o PG em UTF8 não dobra letra acentuada)', () => {
    expect(mesmosTokens('SELECT Ação;', 'SELECT ação;')).toBe(true);
    expect(mesmosTokens('SELECT AÇÃO;', 'SELECT ação;')).toBe(false);
  });

  it('`FOR i IN 1..10` do PL/pgSQL: `..` é um token e não come o número', () => {
    expect(tokensSql('FOR i IN 1..10 LOOP')).toEqual(['for', 'i', 'in', '1', '..', '10', 'loop']);
  });
});

describe('identidadeDosArgumentos — a identidade do PG é nome + tipos de ENTRADA (achado do Codex)', () => {
  // O casamento por corpo não estabelece identidade: com `f(int)`→A e `f(text)`→B no repo, prod com
  // os corpos TROCADOS casaria as duas declarações. A comparação tem de ser por assinatura, e a
  // assinatura tem de sair no MESMO formato que `format_type` devolve em prod.
  it('tira nome de parâmetro, DEFAULT e typmod; mantém a ordem', () => {
    expect(identidadeDosArgumentos('p_id bigint, p_usuario text')).toBe('bigint,text');
    expect(identidadeDosArgumentos("p_x int DEFAULT 0, p_y varchar(10) = 'a'")).toBe('integer,character varying');
    expect(identidadeDosArgumentos('INOUT x numeric(10, 2)')).toBe('numeric');
  });

  it('OUT não entra na identidade; VARIADIC e INOUT entram', () => {
    expect(identidadeDosArgumentos('OUT total integer, p_empresa text')).toBe('text');
    expect(identidadeDosArgumentos('VARIADIC p_ids uuid[]')).toBe('uuid[]');
  });

  it('canoniza os apelidos para o nome que format_type devolve', () => {
    expect(identidadeDosArgumentos('a int4, b int8, c int2, d bool, e float8, f float4, g decimal')).toBe(
      'integer,bigint,smallint,boolean,double precision,real,numeric',
    );
    expect(identidadeDosArgumentos('timestamptz, timestamp, timetz, time, char(3), bpchar')).toBe(
      'timestamp with time zone,timestamp without time zone,time with time zone,time without time zone,character,character',
    );
  });

  it('tipo de várias palavras, com e sem nome de parâmetro', () => {
    expect(identidadeDosArgumentos('double precision, p_q timestamp with time zone')).toBe(
      'double precision,timestamp with time zone',
    );
    expect(identidadeDosArgumentos('p character varying')).toBe('character varying');
  });

  it('array e schema public/pg_catalog (qualificação que format_type não imprime)', () => {
    expect(identidadeDosArgumentos('p_x int4[], p_r public.app_role')).toBe('integer[],app_role');
  });

  it('vírgula DENTRO de default com colchete e aspa não quebra o argumento', () => {
    expect(identidadeDosArgumentos("p_date date, p_accounts text[] DEFAULT ARRAY['sayerlack','colacor']")).toBe('date,text[]');
  });

  it('lista vazia é identidade vazia; %TYPE não é resolvível estaticamente (null, nunca palpite)', () => {
    expect(identidadeDosArgumentos('   ')).toBe('');
    expect(identidadeDosArgumentos('p_x sku_parametros.id%TYPE')).toBeNull();
  });
});

describe('remocoesDe — o que tira uma identidade de `public` (DROP / SET SCHEMA / RENAME)', () => {
  // Medido em 2026-09-26: as 7 funções que o repo define e prod não tem são 5 `DROP FUNCTION` e 2
  // `ALTER FUNCTION … SET SCHEMA private` POSTERIORES. O estado terminal é por IDENTIDADE (nome +
  // tipos de entrada, achado do Codex): `DROP FUNCTION f(int)` não aposenta `f(text)`.
  const ids = (sql: string) => remocoesDe(sql).map((r) => `${r.nome}(${r.identidade ?? '*'})`).sort();

  it('DROP FUNCTION com e sem IF EXISTS, com e sem schema, e em LISTA — cada item com a sua identidade', () => {
    const sql = 'DROP FUNCTION IF EXISTS public.a(int);\nDROP FUNCTION b();\nDROP FUNCTION IF EXISTS public.c(p text), d(uuid) CASCADE;';
    expect(ids(sql)).toEqual(['a(integer)', 'b()', 'c(text)', 'd(uuid)']);
  });

  it('DROP sem lista de argumentos aposenta TODAS as identidades do nome', () => {
    expect(ids('DROP FUNCTION IF EXISTS public.e;')).toEqual(['e(*)']);
  });

  it('ALTER FUNCTION … SET SCHEMA e … RENAME TO tiram a identidade de `public`', () => {
    const sql = 'ALTER FUNCTION public.f(uuid, uuid) SET SCHEMA private;\nALTER FUNCTION g() RENAME TO g2;';
    expect(ids(sql)).toEqual(['f(uuid,uuid)', 'g()']);
  });

  it('ALTER FUNCTION que só muda atributo NÃO remove', () => {
    expect(remocoesDe('ALTER FUNCTION public.h() SET search_path = public;')).toEqual([]);
    expect(remocoesDe('ALTER FUNCTION public.i() OWNER TO postgres;')).toEqual([]);
  });

  it('DROP de OUTRO schema não remove de public, e DROP comentado não conta', () => {
    expect(remocoesDe('DROP FUNCTION private.x();\n-- DROP FUNCTION public.y();')).toEqual([]);
  });
});

describe('alvosDePatch — a migration que reescreve a função VIVA (pg_get_functiondef + EXECUTE)', () => {
  // Medido em 2026-09-26: 5 funções estavam "em deriva" só porque a última mudança delas veio por
  // patch — `20260924120000` lê `pg_get_functiondef`, troca âncoras por `replace` e re-EXECUTA.
  // O extrator não vê isso como versão nova; o sensor precisa saber que o corpo esperado não é
  // derivável do repo.
  const PATCH = `DO $mig$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.tint_promote(uuid)'::regprocedure);
  EXECUTE replace(v_def, 'a', 'b');
END $mig$;`;

  it('lê o alvo de um patch por âncora', () => {
    expect(alvosDePatch(PATCH)).toEqual(['tint_promote']);
  });

  it('também com regexp_replace e alvos num ARRAY de regprocedure (a troca de gate FU4-E)', () => {
    const sql = `DO $$ DECLARE v_alvos text[] := ARRAY['public.despinar(text,text)', 'public.reverter(uuid)'];
BEGIN EXECUTE regexp_replace(pg_get_functiondef(to_regprocedure(v_alvos[1])), 'x', 'y'); END $$;`;
    expect(alvosDePatch(sql).sort()).toEqual(['despinar', 'reverter']);
  });

  it('pg_get_functiondef só na POSTCONDIÇÃO (sem EXECUTE do texto trocado) não é patch', () => {
    const sql = `DO $post$ BEGIN
  IF position('x' in pg_get_functiondef('public.f()'::regprocedure)) = 0 THEN RAISE EXCEPTION 'f'; END IF;
END $post$;`;
    expect(alvosDePatch(sql)).toEqual([]);
  });
});

/** Uma migration de teste: nome ordenável + SQL. */
const mig = (nome: string, sql: string) => ({ nome, sql });
const fn = (nome: string, args: string, corpo: string) =>
  `CREATE OR REPLACE FUNCTION public.${nome}(${args}) RETURNS int LANGUAGE sql AS $$${corpo}$$;\n`;

describe('modelarRepo — o estado TERMINAL de cada identidade, na ordem de apply', () => {
  it('a última versão de uma identidade é a do último CREATE; as anteriores ficam no histórico', () => {
    const m = modelarRepo([mig('20260101_a.sql', fn('f', 'p int', ' SELECT 1 ')), mig('20260102_b.sql', fn('f', 'p integer', ' SELECT 2 '))]);
    const e = m.identidades.get('f(integer)');
    expect(e?.versoes.map((v) => [v.migration, v.corpo])).toEqual([['20260101_a.sql', ' SELECT 1 '], ['20260102_b.sql', ' SELECT 2 ']]);
    expect(e?.aposentadaPor).toBeUndefined();
  });

  it('DROP + CREATE da mesma identidade no MESMO arquivo termina VIVA (a posição ordena)', () => {
    const m = modelarRepo([mig('20260101_a.sql', 'DROP FUNCTION IF EXISTS public.f(int);\n' + fn('f', 'p int', ' SELECT 1 '))]);
    expect(m.identidades.get('f(integer)')?.aposentadaPor).toBeUndefined();
  });

  it('DROP posterior aposenta; CREATE depois do DROP ressuscita pelo repo', () => {
    const tres = [mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')), mig('20260102_b.sql', 'DROP FUNCTION public.f();')];
    expect(modelarRepo(tres).identidades.get('f()')?.aposentadaPor).toBe('20260102_b.sql');
    const quatro = [...tres, mig('20260103_c.sql', fn('f', '', ' SELECT 3 '))];
    expect(modelarRepo(quatro).identidades.get('f()')?.aposentadaPor).toBeUndefined();
  });

  it('overload redefinido SÓ numa assinatura: a outra continua viva com o corpo antigo (cenário do Codex)', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', fn('f', 'p int', ' SELECT 1 ') + fn('f', 'p text', ' SELECT 2 ')),
      mig('20260102_b.sql', fn('f', 'p int', ' SELECT 3 ')),
    ]);
    expect(m.identidades.get('f(text)')?.versoes.map((v) => v.corpo)).toEqual([' SELECT 2 ']);
    expect(m.identidades.get('f(integer)')?.versoes.at(-1)?.corpo).toBe(' SELECT 3 ');
  });

  it('DROP sem lista aposenta TODAS as identidades vivas do nome', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', fn('f', 'p int', ' SELECT 1 ') + fn('f', 'p text', ' SELECT 2 ')),
      mig('20260102_b.sql', 'DROP FUNCTION IF EXISTS public.f;'),
    ]);
    expect([...m.identidades.values()].map((e) => e.aposentadaPor)).toEqual(['20260102_b.sql', '20260102_b.sql']);
  });

  it('patch candidato POSTERIOR ao último CREATE fica pendurado na identidade; um CREATE depois o zera', () => {
    const patch = `DO $m$ BEGIN EXECUTE replace(pg_get_functiondef('public.f()'::regprocedure), 'a', 'b'); END $m$;`;
    const dois = [mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')), mig('20260102_p.sql', patch)];
    expect(modelarRepo(dois).identidades.get('f()')?.patchesDepois).toEqual(['20260102_p.sql']);
    const tres = [...dois, mig('20260103_c.sql', fn('f', '', ' SELECT 2 '))];
    expect(modelarRepo(tres).identidades.get('f()')?.patchesDepois).toEqual([]);
  });

  it('no MESMO arquivo, a posição decide: menção ANTES do CREATE não pendura; DEPOIS pendura (Codex, código P1-3)', () => {
    // Cria-e-depois-patcheia no mesmo arquivo existe; se prod voltar ao corpo do CREATE, só a
    // conciliação exigida aqui impede o EM_DIA. A menção que vem ANTES do CREATE não o alcança.
    const patch = (alvo: string) => `DO $m$ BEGIN EXECUTE replace(pg_get_functiondef('public.${alvo}()'::regprocedure), 'x', 'y'); END $m$;\n`;
    const depois = modelarRepo([mig('20260101_a.sql', fn('f', '', ' SELECT 1 ') + patch('f'))]);
    expect(depois.identidades.get('f()')?.patchesDepois).toEqual(['20260101_a.sql']);
    const antes = modelarRepo([mig('20260101_a.sql', patch('f') + fn('f', '', ' SELECT 1 '))]);
    expect(antes.identidades.get('f()')?.patchesDepois).toEqual([]);
  });

  it('DROP e patch escritos DENTRO do corpo de uma função não rodam no apply — não aposentam nem penduram', () => {
    // O corpo só executa quando alguém CHAMA a função; o DO executa no apply e continua valendo.
    const manut = `CREATE OR REPLACE FUNCTION public.manut() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE 'DROP FUNCTION IF EXISTS public.f()';
  EXECUTE replace(pg_get_functiondef('public.f()'::regprocedure), 'a', 'b');
END $$;`;
    const m = modelarRepo([mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')), mig('20260102_b.sql', manut)]);
    expect(m.identidades.get('f()')?.aposentadaPor).toBeUndefined();
    expect(m.identidades.get('f()')?.patchesDepois).toEqual([]);
    // DROP ESTÁTICO dentro de DO roda no apply e aposenta; `EXECUTE 'DROP …'` é DDL dinâmica (Codex, P1-4).
    const doBloco = mig('20260103_c.sql', 'DO $d$ BEGIN DROP FUNCTION IF EXISTS public.f(); END $d$;');
    expect(modelarRepo([mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')), doBloco]).identidades.get('f()')?.aposentadaPor).toBe('20260103_c.sql');
  });

  it('versão posterior SEM corpo dollar-quoted fica sem corpo — a anterior NÃO assume o posto (Codex)', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql RETURN 2;'),
    ]);
    expect(m.identidades.get('f()')?.versoes.at(-1)?.corpo).toBeUndefined();
  });

  it('só `public` entra; e o controle de PERDA acusa CREATE que o extrator não reconheceu (identificador citado)', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', 'CREATE FUNCTION private.x() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'),
      mig('20260102_b.sql', 'CREATE OR REPLACE FUNCTION "public"."citada"() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;'),
    ]);
    expect([...m.nomes]).toEqual([]);
    expect(m.perdidas).toEqual(['citada@20260102_b.sql']);
  });

  it('conta migrations e declarações — os controles positivos de que o repo foi lido', () => {
    const m = modelarRepo([mig('20260101_a.sql', fn('f', '', ' SELECT 1 ') + fn('g', '', ' SELECT 2 ')), mig('20260102_b.sql', 'SELECT 1;')]);
    expect([m.migrations, m.declaracoes]).toEqual([2, 2]);
  });
});

// O gate do pacote mede a irmã da migration pelo NOME (`pg_proc.proname`) e não pode importar este
// arquivo (ciclo): a vigência chega a ele reduzida ao nome, pelo `CorposEsperados` (Codex, rodada 3 do #2757).
describe('vigenciaPorNome — o modelo do repo reduzido ao NOME que a sonda do gate mede', () => {
  const vig = (...migs: { nome: string; sql: string }[]) => vigenciaPorNome(modelarRepo(migs));

  it('criada e nunca removida ⇒ VIGENTE, com o ÚLTIMO CREATE', () => {
    const v = vig(mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')), mig('20260102_b.sql', fn('g', '', ' SELECT 2 ')));
    expect(v.get('g')).toEqual({ estado: 'VIGENTE', ultimosCreates: ['20260102_b.sql'] });
  });

  it('DROP posterior ⇒ APOSENTADA, com quem a removeu; CREATE depois do DROP ⇒ VIGENTE de novo', () => {
    const dois = [mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')), mig('20260102_b.sql', 'DROP FUNCTION IF EXISTS public.g();')];
    expect(vig(...dois).get('g')).toEqual({ estado: 'APOSENTADA', por: ['20260102_b.sql'] });
    const tres = [...dois, mig('20260103_c.sql', fn('g', '', ' SELECT 3 '))];
    expect(vig(...tres).get('g')).toEqual({ estado: 'VIGENTE', ultimosCreates: ['20260103_c.sql'] });
  });

  it('SET SCHEMA e RENAME TO também tiram de `public` ⇒ APOSENTADA', () => {
    const cria = mig('20260101_a.sql', fn('g', '', ' SELECT 1 '));
    expect(vig(cria, mig('20260102_b.sql', 'ALTER FUNCTION public.g() SET SCHEMA private;')).get('g')?.estado).toBe('APOSENTADA');
    expect(vig(cria, mig('20260102_b.sql', 'ALTER FUNCTION public.g() RENAME TO h;')).get('g')?.estado).toBe('APOSENTADA');
  });

  it('overload: basta UMA identidade viva para o NOME estar VIGENTE — a sonda mede o nome', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', 'p int', ' SELECT 1 ') + fn('g', 'p text', ' SELECT 2 ')),
      mig('20260102_b.sql', 'DROP FUNCTION public.g(int);'),
    );
    expect(v.get('g')).toEqual({ estado: 'VIGENTE', ultimosCreates: ['20260101_a.sql'] });
  });

  it('todas as identidades aposentadas, por migrations diferentes ⇒ APOSENTADA com as duas', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', 'p int', ' SELECT 1 ') + fn('g', 'p text', ' SELECT 2 ')),
      mig('20260102_b.sql', 'DROP FUNCTION public.g(int);'),
      mig('20260103_c.sql', 'DROP FUNCTION public.g(text);'),
    );
    expect(v.get('g')).toEqual({ estado: 'APOSENTADA', por: ['20260102_b.sql', '20260103_c.sql'] });
  });

  it('assinatura que não se resolve, no DROP ou no CREATE ⇒ INDETERMINADA — a lista ilegível pode ter aposentado OU poupado', () => {
    const cria = mig('20260101_a.sql', fn('g', '', ' SELECT 1 '));
    expect(vig(cria, mig('20260102_b.sql', 'DROP FUNCTION public.g(t.c%TYPE);')).get('g')?.estado).toBe('INDETERMINADA');
    expect(vig(mig('20260101_a.sql', fn('g', 'p t.c%TYPE', ' SELECT 1 '))).get('g')?.estado).toBe('INDETERMINADA');
  });

  it('CREATE que o extrator PERDEU depois da aposentadoria ⇒ INDETERMINADA — a aposentada pode ter voltado', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'DROP FUNCTION public.g();'),
      mig('20260103_c.sql', 'CREATE OR REPLACE FUNCTION "public"."g"() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;'),
    );
    expect(v.get('g')?.estado).toBe('INDETERMINADA');
  });

  it('nome que só o controle SOLTO viu (o extrator estrito nunca) ⇒ INDETERMINADA, não ausente do mapa', () => {
    const v = vig(mig('20260101_a.sql', 'CREATE OR REPLACE FUNCTION "public"."citada"() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;'));
    expect(v.get('citada')?.estado).toBe('INDETERMINADA');
  });

  it('fora de `public` não entra — a sonda do gate só mede `public`', () => {
    const v = vig(mig('20260101_a.sql', 'CREATE FUNCTION private.x() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'));
    expect(v.has('x')).toBe(false);
  });

  // Adversarial do Codex sobre o fix (2026-10-05): o modelo aposentava por TEXTO. Só é remoção o que EXECUTA no
  // apply — DDL de topo, ou comando estático direto no corpo de um DO —, nunca o texto de outro dollar-quote.
  describe('a aposentadoria só conta o que EXECUTA no apply', () => {
    const cria = mig('20260101_a.sql', fn('g', '', ' SELECT 1 '));

    it('Codex P1: DROP escrito como TEXTO num literal dollar-quoted não aposenta (`SELECT $nota$DROP …$nota$`)', () => {
      expect(vig(cria, mig('20260102_b.sql', 'SELECT $nota$DROP FUNCTION public.g();$nota$;')).get('g')?.estado).toBe('VIGENTE');
    });

    it('Codex P1: DROP no corpo de uma função que o extrator PERDEU não aposenta — o corpo só roda quando alguém a chama', () => {
      const limpar = 'CREATE FUNCTION "public"."limpar"()\nRETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  DROP FUNCTION public.g();\nEND $$;';
      expect(vig(cria, mig('20260102_b.sql', limpar)).get('g')?.estado).toBe('VIGENTE');
    });

    it('Codex (e): DROP num dollar-quote ANINHADO no DO (o texto de um EXECUTE format) não aposenta — e aqui ainda sob IF FALSE', () => {
      const doBloco = 'DO $$ BEGIN IF FALSE THEN EXECUTE format($sql$DROP FUNCTION public.g()$sql$); END IF; END $$;';
      expect(vig(cria, mig('20260102_b.sql', doBloco)).get('g')?.estado).toBe('VIGENTE');
    });

    it('controle: DROP estático direto no corpo do DO aposenta (roda no apply)', () => {
      expect(vig(cria, mig('20260102_b.sql', 'DO $d$ BEGIN DROP FUNCTION IF EXISTS public.g(); END $d$;')).get('g')?.estado).toBe('APOSENTADA');
    });

    it('controle com a forma REAL do repo (fu7): SET SCHEMA guardado por to_regprocedure dentro do DO aposenta', () => {
      const fu7 = "DO $$\nBEGIN\n  IF to_regprocedure('public.g()') IS NOT NULL THEN\n    ALTER FUNCTION public.g() SET SCHEMA private;\n  END IF;\nEND $$;";
      expect(vig(cria, mig('20260102_b.sql', fu7)).get('g')).toEqual({ estado: 'APOSENTADA', por: ['20260102_b.sql'] });
    });
  });

  it('Codex P1: ida e volta por RENAME ⇒ INDETERMINADA — o modelo vê a saída e não reconstrói a volta', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'ALTER FUNCTION public.g() RENAME TO h;\nALTER FUNCTION public.h() RENAME TO g;'),
    );
    expect(v.get('g')?.estado).toBe('INDETERMINADA');
  });

  it('Codex P1: ida e volta por SET SCHEMA ⇒ INDETERMINADA', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'ALTER FUNCTION public.g() SET SCHEMA private;'),
      mig('20260103_c.sql', 'ALTER FUNCTION private.g() SET SCHEMA public;'),
    );
    expect(v.get('g')?.estado).toBe('INDETERMINADA');
  });

  it('a volta seguida de um DROP de verdade ⇒ APOSENTADA de novo — o "pode ter voltado" não fica para sempre', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'ALTER FUNCTION public.g() RENAME TO h;\nALTER FUNCTION public.h() RENAME TO g;'),
      mig('20260103_c.sql', 'DROP FUNCTION public.g();'),
    );
    expect(v.get('g')).toEqual({ estado: 'APOSENTADA', por: ['20260103_c.sql'] });
  });

  it('`RENAME TO "G"` (citado, com maiúscula) cria OUTRO nome — não é a volta de `g` (auto-desafio do fix)', () => {
    const v = vig(
      mig('20260101_a.sql', fn('g', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'DROP FUNCTION public.g();\nALTER FUNCTION public.h() RENAME TO "G";'),
    );
    expect(v.get('g')).toEqual({ estado: 'APOSENTADA', por: ['20260102_b.sql'] });
  });

  it('Codex P2: `DROP … g("int4")` aposenta `g(p integer)` — tipo citado em minúsculas é o mesmo tipo; `"char"` NÃO é `char`', () => {
    const v = vig(mig('20260101_a.sql', fn('g', 'p integer', ' SELECT 1 ')), mig('20260102_b.sql', 'DROP FUNCTION public.g("int4");'));
    expect(v.get('g')?.estado).toBe('APOSENTADA');
    expect(identidadeDosArgumentos('a "int4", b "varchar"[], c "char", d "Int4"')).toBe('integer,character varying[],"char","Int4"');
  });

  it('nome no universo SEM identidade modelada ⇒ INDETERMINADA, nunca APOSENTADA (o fail-closed não depende do modelarRepo de hoje)', () => {
    // O `modelarRepo` atual não produz isso; o contrato de `vigenciaPorNome` vale para qualquer modelo.
    const modelo = { identidades: new Map(), nomes: new Set(['g']), migrations: 1, declaracoes: 1, perdidas: [], ilegiveis: [] };
    expect(vigenciaPorNome(modelo).get('g')?.estado).toBe('INDETERMINADA');
  });
});

/** A amostra do autoteste de hex, escrita à mão (não gerada do JS — senão o teste valida a si mesmo). */
const HEX_AMOSTRA = '0a20c3a1202062 20'.replace(/ /g, '');
const hex = (t: string) => Buffer.from(t, 'utf8').toString('hex');
/** Uma saída de prod mínima e VÁLIDA: as linhas da sonda reaproveitada + as do detalhe. */
const saidaValida = (extra: string[] = [], corpo = ' SELECT 1 ') =>
  [
    `rpc|f|${TOKEN_SIM}|1`,
    'controle|funcoes_public|489|',
    `autoteste|presente|${TOKEN_SIM}|`,
    'autoteste|ausente|NAO|',
    `autoteste|md5corpo|${md5Exato(AMOSTRA_CORPO_JS)}|`,
    `corpo|f|${md5Exato(corpo)}|1`,
    `fim|${FORMATO_SONDA}||`,
    'n|f|1|||',
    `fn|f||9106714|${md5Exato(corpo)}|${hex(corpo)}`,
    `autoteste-hex|${HEX_AMOSTRA}||||`,
    'autoteste-id|integer,text,timestamp with time zone,character varying||||',
    'agora|2026-09-26 01:46:08||||',
    ...extra,
    'fim-deriva|deriva-corpo/1||||',
  ].join('\n');

describe('montarSondaDeriva — UMA transação, UM retrato (achado P2 do Codex)', () => {
  const sql = montarSondaDeriva(['f', '_g']);

  it('as duas leituras na MESMA transação REPEATABLE READ READ ONLY', () => {
    expect(sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('reaproveita a sonda do gate do pacote (controles + autotestes + marcador)', () => {
    expect(sql).toContain('funcoes_public');
    expect(sql).toContain(FORMATO_SONDA);
  });

  it('a identidade sai de proargtypes por format_type — o formato que identidadeDosArgumentos reproduz', () => {
    expect(sql).toContain('format_type');
    expect(sql).toContain('proargtypes');
  });

  it('lê catálogo e nunca invoca a função', () => {
    expect(sql).not.toMatch(/SELECT\s+public\.f\s*\(/i);
  });
});

describe('parsearSondaDeriva — o detalhe por overload, fail-closed', () => {
  it('lê overload, identidade, xmin, md5 e o texto decodificado', () => {
    const l = parsearSondaDeriva(saidaValida());
    expect(l.overloads).toEqual([{ nome: 'f', identidade: '', xmin: 9106714, md5: md5Exato(' SELECT 1 '), texto: ' SELECT 1 ' }]);
    expect([l.fim, l.autotesteHex, l.autotesteIdentidade, l.sonda.fim, l.sonda.dialetoOk]).toEqual([true, true, true, true, true]);
    expect(l.incoerencias).toEqual([]);
  });

  it('texto hex cujo md5 não bate com o do BANCO é corrompido — nunca comparado', () => {
    const l = parsearSondaDeriva(saidaValida().replace(hex(' SELECT 1 '), hex(' SELECT 2 ')));
    expect(l.incoerencias.join()).toMatch(/f\(\): o texto recebido não reproduz o md5 do banco/);
  });

  it('sem o marcador de fim do detalhe, `fim` é falso (saída truncada)', () => {
    expect(parsearSondaDeriva(saidaValida().replace(/\nfim-deriva.*$/, '')).fim).toBe(false);
  });

  it('SEM-CORPO vira md5 ausente, nunca md5 de string vazia', () => {
    const l = parsearSondaDeriva(saidaValida().replace(/fn\|f\|\|9106714\|[0-9a-f]{32}\|[0-9a-f]*/, 'fn|f||9106714|SEM-CORPO|'));
    expect(l.overloads[0].md5).toBeUndefined();
  });

  it('o detalhe mede um nome e a sonda não trouxe NEM a linha `rpc`: incoerência (Codex, confirmação P1)', () => {
    // A irmã da migration some inteira da sonda (rpc + corpo) e o detalhe ainda a conta: o universo é o
    // das linhas `n`, não o das medições recebidas.
    const comIrma = saidaValida(['n|g|1|||', `fn|g||9106714|${md5Exato(' SELECT 7 ')}|${hex(' SELECT 7 ')}`]);
    expect(parsearSondaDeriva(comIrma).incoerencias.join()).toMatch(/g: o detalhe o mede e a sonda não trouxe a linha `rpc`/);
  });

  it('o banco conta overload e a sonda não trouxe a linha `corpo`: incoerência — linha perdida não vira "sem corpo" (Codex P1)', () => {
    const semCorpo = saidaValida().replace(/\ncorpo\|f\|[^\n]*/, '');
    expect(semCorpo).not.toContain('corpo|f|');
    expect(parsearSondaDeriva(semCorpo).incoerencias.join()).toMatch(/f: o banco conta 1 overload\(s\) e a sonda não trouxe a linha `corpo`/);
    // Controle: a saída íntegra não acusa nada.
    expect(parsearSondaDeriva(saidaValida()).incoerencias).toEqual([]);
  });

  it('o detalhe e a sonda reaproveitada têm de CONTAR os mesmos overloads por nome', () => {
    const l = parsearSondaDeriva(saidaValida([`fn|f|text|9106715|${md5Exato(' SELECT 9 ')}|${hex(' SELECT 9 ')}`]));
    expect(l.incoerencias.join()).toMatch(/f: a sonda contou 1 overload\(s\) e o detalhe trouxe 2/);
  });
});

describe('textosDaLeitura — o canal de TEXTO que o eixo 5 do gate do pacote re-testa por tokens', () => {
  it('traz, por nome, o prosrc que reproduziu o md5 do banco — canal íntegro, nenhuma falha', () => {
    const t = textosDaLeitura(parsearSondaDeriva(saidaValida()));
    expect(t.porNome.get('f')).toEqual([' SELECT 1 ']);
    expect(t.falhas).toEqual([]);
  });

  it('texto que NÃO reproduz o md5 não entra — e a incoerência vira falha DITA do canal', () => {
    const t = textosDaLeitura(parsearSondaDeriva(saidaValida().replace(hex(' SELECT 1 '), hex(' SELECT 2 '))));
    expect(t.porNome.get('f') ?? []).toEqual([]);
    expect(t.falhas.join()).toMatch(/não reproduz o md5/);
  });

  it('detalhe truncado (sem `fim-deriva`) e autoteste hex quebrado são falhas DITAS, não silêncio', () => {
    const truncado = textosDaLeitura(parsearSondaDeriva(saidaValida().replace(/\nfim-deriva.*$/, '')));
    expect(truncado.falhas.join()).toMatch(/marcador `deriva-corpo\/1`/);
    const semHex = textosDaLeitura(parsearSondaDeriva(saidaValida().replace(`autoteste-hex|${HEX_AMOSTRA}`, 'autoteste-hex|00')));
    expect(semHex.falhas.join()).toMatch(/autoteste do canal hex/);
  });
});

describe('saidaDerivaComoPsql — a resposta da nuvem na forma do psql, UMA receita para o audit e o pacote', () => {
  it('as duas consultas em sequência, cada linha com `\\n`, e nada para consulta vazia', () => {
    const linhas = new Map([['sonda', ['a|1', 'b|2']], ['detalhe', []]]);
    expect(saidaDerivaComoPsql(linhas)).toBe('a|1\nb|2\n');
    expect(saidaDerivaComoPsql(new Map([['sonda', ['a']], ['detalhe', ['d']]]))).toBe('a\nd\n');
  });

  it('consulta AUSENTE na resposta LANÇA — não medi, nunca saída vazia', () => {
    expect(() => saidaDerivaComoPsql(new Map([['sonda', ['a']]]))).toThrow(/não trouxe a consulta 'detalhe'/);
  });
});

// ── julgamento ────────────────────────────────────────────────────────────────────────────────
const LIBERADA: VereditoPrecondicao = { estado: 'LIBERADA', ausentes: [], naoMedidos: [], motivos: [], desatualizadas: [], cosmeticas: [], naoConferidas: [] };
/** Uma leitura de prod íntegra com os overloads dados (texto sempre coerente com o md5). */
const leituraCom = (vivos: { nome: string; identidade: string; corpo?: string; xmin?: number }[]) => ({
  sonda: { medicoes: [], corpos: new Map(), funcoesPublic: 489, fim: true, dialetoOk: true },
  overloads: vivos.map((v) => ({
    nome: v.nome,
    identidade: v.identidade,
    xmin: v.xmin ?? 1,
    ...(v.corpo === undefined ? {} : { md5: md5Exato(v.corpo), texto: v.corpo }),
  })),
  fim: true,
  autotesteHex: true,
  autotesteIdentidade: true,
  incoerencias: [] as string[],
});
const V1 = ' SELECT 1 ';
const V2 = ' SELECT 2 ';
const DOIS = [mig('20260101_a.sql', fn('f', '', V1)), mig('20260102_b.sql', fn('f', '', V2))];
const julga = (migs: { nome: string; sql: string }[], vivos: Parameters<typeof leituraCom>[0], baseline: unknown[] = []) =>
  julgarDeriva({ modelo: modelarRepo(migs), leitura: leituraCom(vivos), baseline: baseline as never, controles: LIBERADA });
const codigos = (r: ReturnType<typeof julgarDeriva>) => r.achados.map((a) => a.codigo);

describe('julgarDeriva — o veredito por identidade', () => {
  it('EM_DIA: prod é byte a byte a última versão ⇒ exit 0', () => {
    const r = julga(DOIS, [{ nome: 'f', identidade: '', corpo: V2 }]);
    expect([r.exit, codigos(r)]).toEqual([0, ['EM_DIA']]);
  });

  it('COSMETICO: mesmos tokens da última (comentário/espaço) ⇒ exit 0', () => {
    expect(julga(DOIS, [{ nome: 'f', identidade: '', corpo: ' select 2 -- nota ' }]).exit).toBe(0);
  });

  it('CORPO_ANTERIOR: prod roda uma versão commitada ANTES da última ⇒ exit 1, nomeando as duas', () => {
    const r = julga(DOIS, [{ nome: 'f', identidade: '', corpo: V1 }]);
    expect([r.exit, codigos(r)]).toEqual([1, ['CORPO_ANTERIOR']]);
    expect(r.achados[0].detalhe).toMatch(/20260101_a\.sql.*20260102_b\.sql/);
  });

  it('versão anterior com os MESMOS tokens da última não é revert — é cosmético (kb_documents_set_updated_at)', () => {
    const migs = [mig('20260101_a.sql', fn('f', '', ' BEGIN RETURN 1; END; ')), mig('20260102_b.sql', fn('f', '', '\nBEGIN\n  RETURN 1;\nEND;\n'))];
    expect(codigos(julga(migs, [{ nome: 'f', identidade: '', corpo: ' BEGIN RETURN 1; END; ' }]))).toEqual(['COSMETICO']);
  });

  it('SEM_PAR: corpo que nenhuma versão commitou ⇒ exit 1', () => {
    expect(codigos(julga(DOIS, [{ nome: 'f', identidade: '', corpo: ' SELECT 9 ' }]))).toEqual(['SEM_PAR']);
  });

  it('troca de corpos entre overloads (Codex P1-2) ⇒ as DUAS acusam', () => {
    const migs = [mig('20260101_a.sql', fn('f', 'p int', ' SELECT 1 ') + fn('f', 'p text', ' SELECT 2 '))];
    const r = julga(migs, [{ nome: 'f', identidade: 'integer', corpo: ' SELECT 2 ' }, { nome: 'f', identidade: 'text', corpo: ' SELECT 1 ' }]);
    expect([r.exit, codigos(r)]).toEqual([1, ['SEM_PAR', 'SEM_PAR']]);
  });

  it('AUSENTE (viva no repo, some em prod) ⇒ 1; aposentada e ausente ⇒ 0; aposentada e PRESENTE ⇒ RESSUSCITADA', () => {
    expect(codigos(julga(DOIS, []))).toEqual(['AUSENTE']);
    const drop = [...DOIS, mig('20260103_c.sql', 'DROP FUNCTION public.f();')];
    expect(julga(drop, []).exit).toBe(0);
    const r = julga(drop, [{ nome: 'f', identidade: '', corpo: V2 }]);
    expect([r.exit, codigos(r)]).toEqual([1, ['RESSUSCITADA']]);
  });

  it('SEM_CORPO_TEXTUAL: prod sem prosrc comparável e repo com corpo ⇒ 1', () => {
    expect(codigos(julga(DOIS, [{ nome: 'f', identidade: '' }]))).toEqual(['SEM_CORPO_TEXTUAL']);
  });

  it('overload que o repo não conhece ⇒ OVERLOAD_FORA_DO_REPO (1)', () => {
    const r = julga(DOIS, [{ nome: 'f', identidade: '', corpo: V2 }, { nome: 'f', identidade: 'text', corpo: V1 }]);
    expect([r.exit, codigos(r)]).toEqual([1, ['EM_DIA', 'OVERLOAD_FORA_DO_REPO']]);
  });
});

describe('julgarDeriva — a baseline de deriva ACEITA', () => {
  const manual = (esperada: string, corpo: string) => ({
    funcao: 'f', identidade: '', classe: 'EDICAO_MANUAL', esperadaNoAceite: esperada,
    md5: md5Exato(corpo), md5Tokens: md5DeTokens(corpo), motivo: 'teste', desde: '2026-09-26',
  });

  it('edição manual aceita (enquanto a última declaração for a do aceite) ⇒ 0', () => {
    const r = julga(DOIS, [{ nome: 'f', identidade: '', corpo: ' SELECT 7 ' }], [manual('20260102_b.sql', ' SELECT 7 ')]);
    expect([r.exit, codigos(r)]).toEqual([0, ['ACEITA']]);
  });

  it('aceite tolera mudança só COSMÉTICA do corpo aceito (achado P2 do Codex)', () => {
    expect(julga(DOIS, [{ nome: 'f', identidade: '', corpo: ' select 7 -- x' }], [manual('20260102_b.sql', ' SELECT 7 ')]).exit).toBe(0);
  });

  it('entrada VENCE quando o repo redefine a função: deixa de valer (e avisa)', () => {
    const r = julga(DOIS, [{ nome: 'f', identidade: '', corpo: ' SELECT 7 ' }], [manual('20260101_a.sql', ' SELECT 7 ')]);
    expect([r.exit, codigos(r)]).toEqual([1, ['SEM_PAR', 'BASELINE_OBSOLETA']]);
  });

  const PATCH = `DO $m$ BEGIN EXECUTE replace(pg_get_functiondef('public.f()'::regprocedure), '2', '3'); END $m$;`;
  const COM_PATCH = [...DOIS, mig('20260103_p.sql', PATCH)];
  const altera = (patch: string, corpo?: string) => ({
    funcao: 'f', identidade: '', classe: 'PATCH', patch, efeito: 'ALTERA', motivo: 'teste', desde: '2026-09-26',
    ...(corpo === undefined ? {} : { md5: md5Exato(corpo), md5Tokens: md5DeTokens(corpo) }),
  });

  it('patch posterior sem conciliação ⇒ PATCH_NAO_CONCILIADO (1), mesmo com prod igual ao último CREATE (Codex P1-1)', () => {
    const r = julga(COM_PATCH, [{ nome: 'f', identidade: '', corpo: V2 }]);
    expect([r.exit, codigos(r)]).toEqual([1, ['PATCH_NAO_CONCILIADO']]);
  });

  it('patch conciliado como ALTERA com o corpo aceito ⇒ ACEITA (0)', () => {
    expect(codigos(julga(COM_PATCH, [{ nome: 'f', identidade: '', corpo: ' SELECT 3 ' }], [altera('20260103_p.sql', ' SELECT 3 ')]))).toEqual(['ACEITA']);
  });

  it('patch ALTERA conciliado e prod no último CREATE ⇒ PATCH_AUSENTE (o patch nunca pegou ou foi revertido)', () => {
    const r = julga(COM_PATCH, [{ nome: 'f', identidade: '', corpo: V2 }], [altera('20260103_p.sql', ' SELECT 3 ')]);
    expect([r.exit, codigos(r)]).toEqual([1, ['PATCH_AUSENTE']]);
  });

  it('um 2º patch chega: o 1º aceito não o absolve (Codex P1-1, cenário M2)', () => {
    const tres = [...COM_PATCH, mig('20260104_q.sql', PATCH.replace("'2', '3'", "'3', '4'"))];
    const r = julga(tres, [{ nome: 'f', identidade: '', corpo: ' SELECT 3 ' }], [altera('20260103_p.sql', ' SELECT 3 ')]);
    expect([r.exit, codigos(r)]).toEqual([1, ['PATCH_NAO_CONCILIADO']]);
  });

  it('patch que só CITA a função devolve o julgamento ao último CREATE', () => {
    const cita = { funcao: 'f', identidade: '', classe: 'PATCH', patch: '20260103_p.sql', efeito: 'SO_CITA', motivo: 'guard', desde: '2026-09-26' };
    expect(codigos(julga(COM_PATCH, [{ nome: 'f', identidade: '', corpo: V2 }], [cita]))).toEqual(['EM_DIA']);
  });

  it('última versão sem corpo comparável: não declarada ⇒ exit 2; declarada NAO_MENSURAVEL ⇒ 0', () => {
    const migs = [mig('20260101_a.sql', 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql RETURN 1;')];
    expect(julga(migs, [{ nome: 'f', identidade: '' }]).exit).toBe(2);
    const decl = { funcao: 'f', identidade: '', classe: 'NAO_MENSURAVEL', motivo: 'prosqlbody', desde: '2026-09-26' };
    expect(julga(migs, [{ nome: 'f', identidade: '' }], [decl]).exit).toBe(0);
  });
});

describe('julgarDeriva — medição incompleta NUNCA sai 0 (e 2 prevalece sobre 1)', () => {
  const base = { modelo: modelarRepo(DOIS), leitura: leituraCom([{ nome: 'f', identidade: '', corpo: V1 }]), baseline: [], controles: LIBERADA };

  it.each([
    ['controles da sonda INCERTA', { controles: { ...LIBERADA, estado: 'INCERTA' as const, motivos: ['sem marcador'] } }],
    ['detalhe sem marcador de fim', { leitura: { ...base.leitura, fim: false } }],
    ['autoteste de hex falhou', { leitura: { ...base.leitura, autotesteHex: false } }],
    ['autoteste de identidade falhou', { leitura: { ...base.leitura, autotesteIdentidade: false } }],
    ['incoerência interna da resposta', { leitura: { ...base.leitura, incoerencias: ['f: md5 divergem'] } }],
    ['extração perdeu um CREATE', { modelo: { ...base.modelo, perdidas: ['citada'] } }],
    ['nenhuma migration lida', { modelo: { ...base.modelo, migrations: 0 } }],
  ])('%s ⇒ exit 2, mesmo com CORPO_ANTERIOR presente', (_rotulo, troca) => {
    const r = julgarDeriva({ ...base, ...troca } as never);
    expect(r.exit).toBe(2);
    expect(r.incertezas.length).toBeGreaterThan(0);
  });
});

describe('lerBaseline — contrato versionado, fail-closed', () => {
  const ok = { formato: 'deriva-corpo-baseline/1', entradas: [{ funcao: 'f', identidade: '', classe: 'NAO_MENSURAVEL', motivo: 'x', desde: '2026-09-26' }] };
  it('aceita o formato certo', () => {
    expect(lerBaseline(JSON.stringify(ok))).toHaveLength(1);
  });
  it.each([
    ['formato errado', { ...ok, formato: 'outro/1' }],
    ['classe desconhecida', { ...ok, entradas: [{ ...ok.entradas[0], classe: 'QUALQUER' }] }],
    ['EDICAO_MANUAL sem md5', { ...ok, entradas: [{ ...ok.entradas[0], classe: 'EDICAO_MANUAL', esperadaNoAceite: 'a.sql' }] }],
    ['entrada duplicada', { ...ok, entradas: [ok.entradas[0], ok.entradas[0]] }],
    ['sem motivo', { ...ok, entradas: [{ ...ok.entradas[0], motivo: '' }] }],
  ])('recusa %s', (_r, obj) => {
    expect(() => lerBaseline(JSON.stringify(obj))).toThrow(/baseline/);
  });
});

describe('relatarDeriva — o texto que o carimbo lê (🔎 denominador · ❌ achado · ✅ resumo)', () => {
  const ctx = { sha: 'e9dbcf383f37fd92c390553c2e98b9d43770f650', fetch: true, agora: '2026-09-26 01:46:08' };

  it('exit 0: 🔎 primeiro, ✅ por último, nenhum ❌', () => {
    const { saida, erro } = relatarDeriva(julga(DOIS, [{ nome: 'f', identidade: '', corpo: V2 }]), ctx);
    const todas = [...saida, ...erro];
    expect(todas[0]).toMatch(/^🔎 deriva-corpo — .*origin\/main@e9dbcf383/);
    expect(todas[todas.length - 1]).toMatch(/^✅ deriva-corpo/);
    expect(todas.some((l) => l.startsWith('❌'))).toBe(false);
  });

  it('exit 1: um `❌ [COD] alvo:` por achado, no stderr, com o xmin DEPOIS dos dois-pontos (id estável)', () => {
    const { saida, erro } = relatarDeriva(julga(DOIS, [{ nome: 'f', identidade: '', corpo: V1, xmin: 9924256 }]), ctx);
    const falhas = erro.filter((l) => l.startsWith('❌'));
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toMatch(/^❌ \[CORPO_ANTERIOR\] f\(\): .*xmin 9924256/);
    const outroXmin = falhas[0].replace('9924256', '10000000');
    expect(idFinding('funcoes', outroXmin)).toBe(idFinding('funcoes', falhas[0]));
    expect([...saida, ...erro].some((l) => l.startsWith('✅'))).toBe(false);
  });

  it('exit 2: ⛔ por incerteza, e NENHUM ✅ (o carimbo não pode ler resumo verde)', () => {
    const r = julgarDeriva({ modelo: { ...modelarRepo(DOIS), migrations: 0 }, leitura: leituraCom([]), baseline: [], controles: LIBERADA });
    const { saida, erro } = relatarDeriva(r, ctx);
    expect(erro.some((l) => l.startsWith('⛔'))).toBe(true);
    expect([...saida, ...erro].some((l) => l.startsWith('✅'))).toBe(false);
  });

  it('sem fetch, o 🔎 DIZ que a ref pode estar velha (achado P1 do Codex)', () => {
    const { saida } = relatarDeriva(julga(DOIS, [{ nome: 'f', identidade: '', corpo: V2 }]), { ...ctx, fetch: false });
    expect(saida[0]).toMatch(/SEM fetch/);
  });
});

describe('o incidente que criou o sensor (2026-09-07) — com as migrations REAIS do repo', () => {
  // A 20260906170000 foi colada DEPOIS da 20260907095841 e `cancelar_pedido_sugerido` rodou 18 dias
  // sem a recusa de `disparado_simulado`. Se o sensor não disser CORPO_ANTERIOR aqui, ele não serve.
  const DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
  const ler = (nome: string) => ({ nome, sql: readFileSync(join(DIR, nome), 'utf8') });
  const migs = [ler('20260906170000_reposicao_selo_aprovacao_m1_expandir.sql'), ler('20260907095841_disparado_simulado_e_estado_pos_disparo.sql')];
  const modelo = modelarRepo(migs);
  const e = modelo.identidades.get('cancelar_pedido_sugerido(bigint,text,text)');
  const corpoDe = (migration: string) => e?.versoes.find((v) => v.migration === migration)?.corpo ?? '';

  it('o modelo conhece as duas versões, na ordem de apply', () => {
    expect(e?.versoes.map((v) => v.migration)).toEqual(migs.map((m) => m.nome));
  });

  it('prod no corpo da 06/09 ⇒ CORPO_ANTERIOR nomeando a que venceu e a que deveria', () => {
    const vivo = [{ nome: 'cancelar_pedido_sugerido', identidade: 'bigint,text,text', corpo: corpoDe(migs[0].nome) }];
    const r = julgarDeriva({ modelo, leitura: leituraCom(vivo), baseline: [], controles: LIBERADA });
    const alvo = r.achados.find((a) => a.alvo === 'cancelar_pedido_sugerido(bigint,text,text)');
    expect(alvo?.codigo).toBe('CORPO_ANTERIOR');
    expect(alvo?.detalhe).toMatch(/20260906170000.*20260907095841/);
  });

  it('prod no corpo da 07/09 (o conserto de 2026-09-26) ⇒ EM_DIA', () => {
    const vivo = [{ nome: 'cancelar_pedido_sugerido', identidade: 'bigint,text,text', corpo: corpoDe(migs[1].nome) }];
    const r = julgarDeriva({ modelo, leitura: leituraCom(vivo), baseline: [], controles: LIBERADA });
    expect(r.achados.find((a) => a.alvo === 'cancelar_pedido_sugerido(bigint,text,text)')?.codigo).toBe('EM_DIA');
  });
});

describe('parecer de CÓDIGO do Codex (2026-09-26) — os falsos-verdes, um a um', () => {
  it('P1-1: NAO_MENSURAVEL declarada NÃO dispensa existência — sumiu de prod ⇒ AUSENTE', () => {
    const migs = [mig('20260101_a.sql', 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql RETURN 1;')];
    const decl = { funcao: 'f', identidade: '', classe: 'NAO_MENSURAVEL', motivo: 'prosqlbody', desde: '2026-09-26' };
    const r = julga(migs, [], [decl]);
    expect([r.exit, codigos(r)]).toEqual([1, ['AUSENTE']]);
  });

  it('P1-2: redefinição com identificador CITADO não se esconde atrás do nome antigo', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', fn('f', '', ' SELECT 1 ')),
      mig('20260102_b.sql', 'CREATE OR REPLACE FUNCTION public."f"() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;'),
    ]);
    expect(m.perdidas).toEqual(['f@20260102_b.sql']);
  });

  it('P1-4: DROP dentro de LITERAL de string não aposenta; DROP estático dentro de DO aposenta', () => {
    expect(remocoesDe("SELECT 'DROP FUNCTION public.f()';")).toEqual([]);
    expect(remocoesDe('DO $$ BEGIN DROP FUNCTION IF EXISTS public.f(); END $$;').map((r) => r.nome)).toEqual(['f']);
  });

  it('P1-5: DROP com assinatura ILEGÍVEL não aposenta ninguém — o nome vira ilegível (exit 2)', () => {
    const m = modelarRepo([
      mig('20260101_a.sql', fn('f', 'p int', ' SELECT 1 ') + fn('f', 'p text', ' SELECT 2 ')),
      mig('20260102_b.sql', 'DROP FUNCTION public.f(x sku.id%TYPE);'),
    ]);
    expect([...m.identidades.values()].map((e) => e.aposentadaPor)).toEqual([undefined, undefined]);
    expect(m.ilegiveis).toEqual(['f']);
  });

  it('P1-6: `)` dentro de DEFAULT literal não encurta a assinatura', () => {
    const m = modelarRepo([mig('20260101_a.sql', "CREATE FUNCTION public.f(p text DEFAULT ')', q integer DEFAULT 0) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;")]);
    expect([...m.identidades.keys()]).toEqual(['f(text,integer)']);
  });

  it('P1-7: perder as linhas de corpo de um nome é incoerência, mesmo com o `rpc|…|SIM` de pé', () => {
    const sem = saidaValida().split('\n').filter((l) => !l.startsWith('corpo|f|') && !l.startsWith('fn|f|')).join('\n');
    expect(parsearSondaDeriva(sem).incoerencias.join()).toMatch(/f: a contagem do banco diz 1 overload\(s\) e o detalhe trouxe 0/);
    const semContagem = saidaValida().split('\n').filter((l) => !l.startsWith('n|f|')).join('\n');
    expect(parsearSondaDeriva(semContagem).incoerencias.join()).toMatch(/f: sem linha de contagem/);
  });

  it("P1-8: a continuação de uma E-string herda o modo de escape (`E'a'` + quebra + `'b\\'--x…'`)", () => {
    const x = "SELECT E'a'\n'b\\'--x\nc';";
    expect(mesmosTokens(x, x.replace('--x', '--y'))).toBe(false);
  });

  it('P1-9: CR termina comentário de linha — o código depois dele conta', () => {
    expect(mesmosTokens('BEGIN RETURN 1 --nota\r + 1; END;', 'BEGIN RETURN 1 --nota\r + 2; END;')).toBe(false);
  });

  it('P1-10: alvo de patch sem schema e por regproc cru', () => {
    expect(alvosDePatch("DO $$ BEGIN EXECUTE replace(pg_get_functiondef('f'::regproc), 'SELECT 1', 'SELECT 2'); END $$;")).toEqual(['f']);
  });

  it('P2-11: tag de dollar-quote longa (>128) segue opaca — o conteúdo não dobra caixa', () => {
    const tag = `$${'t'.repeat(130)}$`;
    expect(mesmosTokens(`SELECT ${tag}A${tag};`, `SELECT ${tag}a${tag};`)).toBe(false);
  });

  it('P2-12: `int[][]` é `integer[]` no catálogo; `float(p)` segue a precisão', () => {
    expect(identidadeDosArgumentos('a int[][], b float(24), c float(25), d float')).toBe('integer[],real,double precision,double precision');
  });
});
