import { describe, expect, it } from 'vitest';

import { classificar, normSig, planejar, separarComandos, sigCanon } from './db-atestar-poscondicao';

describe('separarComandos — comentário, string e dollar-quote não partem comando', () => {
  it('ponto-e-vírgula dentro de string, de $tag$ e de comentário não separa', () => {
    const c = separarComandos(`-- a; b
SELECT 'x; y'; CREATE FUNCTION f() RETURNS int AS $f$ BEGIN RETURN 1; END $f$ LANGUAGE plpgsql; /* z; */ SELECT 2`);
    expect(c).toEqual(["SELECT 'x; y'", 'CREATE FUNCTION f() RETURNS int AS $f$ BEGIN RETURN 1; END $f$ LANGUAGE plpgsql', 'SELECT 2']);
  });
  it('dollar-quote sem fechamento é MECÂNICA (lança), nunca um comando truncado', () => {
    expect(() => separarComandos('DO $x$ BEGIN')).toThrow(/dollar-quote \$x\$ sem fechamento/);
  });
});

describe('classificar — fail-closed: o que não casa padrão conhecido é NAO_PROVAVEL', () => {
  it.each(['UPDATE t SET a = 1', "SELECT cron.schedule('x', '* * * * *', 'select 1')", 'GRANT USAGE ON SCHEMA s TO anon', 'ALTER TABLE t DROP COLUMN a', 'INSERT INTO t VALUES (1)'])(
    '%s → nao_provavel',
    (cmd) => expect(classificar(cmd).tipo).toBe('nao_provavel'),
  );
  it('envelope, COMMENT, NOTIFY pgrst são ignorados (sem estado a provar)', () => {
    for (const c of ['BEGIN', 'COMMIT', "COMMENT ON TABLE t IS 'x'", "NOTIFY pgrst, 'reload schema'"]) expect(classificar(c).tipo).toBe('ignorado');
  });
  it('função: a checagem é pelo md5 do CORPO, não pela existência', () => {
    const c = classificar('CREATE OR REPLACE FUNCTION public.f(a int) RETURNS int LANGUAGE sql AS $q$ SELECT 1 $q$');
    expect(c.tipo).toBe('checagens');
    if (c.tipo === 'checagens') expect(c.checagens[0].sql).toMatch(/md5\(p\.prosrc\) = '[0-9a-f]{32}'/);
  });
  it('função com corpo em string simples (sem dollar-quote) → nao_provavel', () => {
    expect(classificar("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'").tipo).toBe('nao_provavel');
  });
  it('view que declara security_invoker gera a checagem da opção', () => {
    const c = classificar('CREATE OR REPLACE VIEW v WITH (security_invoker = on) AS SELECT 1');
    expect(c.tipo === 'checagens' && c.checagens.map((x) => x.objeto)).toEqual(['view public.v', 'view public.v security_invoker=true']);
  });
  it('identificador sem aspas vai a minúsculo; com aspas preserva', () => {
    const c = classificar('CREATE TABLE "Esq".Tab (id int)');
    expect(c.tipo === 'checagens' && c.checagens[0].objeto).toBe('tabela Esq.tab');
  });
});

describe('assinaturas — o texto que o to_regprocedure entende', () => {
  it('tira nome de parâmetro, modo e DEFAULT', () => {
    expect(normSig('p_a numeric, OUT p_b text, p_c timestamptz DEFAULT now()')).toBe('numeric, text, timestamptz');
    expect(normSig('double precision, character varying')).toBe('double precision, character varying');
    expect(sigCanon('Public.F(a uuid, b jsonb)')).toBe('public.f(uuid, jsonb)');
  });
});

describe('planejar — DROP recriado e ACL no estado FINAL', () => {
  it('DROP TRIGGER seguido do CREATE do mesmo trigger não vira checagem de ausência', () => {
    const p = planejar('DROP TRIGGER IF EXISTS g ON t; CREATE TRIGGER g BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();');
    expect(p.sql).not.toMatch(/ausente/);
    expect(p.sql).toMatch(/trigger g em public\.t/);
  });
  it('DROP sem recriação vira checagem de AUSÊNCIA', () => {
    expect(planejar('DROP VIEW IF EXISTS public.velha;').sql).toMatch(/view public\.velha ausente/);
  });
  it('REVOKE ALL FROM PUBLIC e depois GRANT ao service_role: PUBLIC=nao, service_role=sim', () => {
    const p = planejar('REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.f(uuid) TO service_role;');
    expect(p.sql).toMatch(/PUBLIC EXECUTE=nao/);
    expect(p.sql).toMatch(/anon EXECUTE=nao/);
    expect(p.sql).toMatch(/service_role EXECUTE=sim/);
  });
  it('GRANT depois REVOKE do mesmo papel: vale o ÚLTIMO', () => {
    const p = planejar('GRANT SELECT ON TABLE t TO anon; REVOKE SELECT ON TABLE t FROM anon;');
    expect(p.sql).toMatch(/anon SELECT=nao/);
    expect(p.sql).not.toMatch(/anon SELECT=sim/);
  });
  it('bloco DO sai separado (vai rodar na sessão READ ONLY)', () => {
    const p = planejar('DO $d$ BEGIN PERFORM 1; END $d$;');
    expect(p.dos).toHaveLength(1);
    expect(p.nChecagens).toBe(0);
  });
});
