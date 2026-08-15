import { describe, it, expect } from 'vitest';
import { detectarReescritaViva } from './authz-reescrita';

/**
 * As formas aqui NÃO são inventadas: cada uma foi copiada de uma migration real do repo
 * (medição de 2026-08-14 — 23 das 648 migrations usam o padrão). O arquivo de origem está
 * citado em cada teste, porque um detector calibrado só na forma canônica não vigia o
 * código que existe (lição §3 de docs/historico/sentinela-authz-controle-nao-mencao.md).
 */
describe('detectarReescritaViva — o padrão que a Parte A não enxerga', () => {
  it('detecta a forma com alvo LITERAL e resolve o alvo (20260814022626)', () => {
    const r = detectarReescritaViva(`
      DO $rpc$
      DECLARE
        v_def text := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
      BEGIN
        EXECUTE replace(v_def, 'a', 'b');
      END $rpc$;`);
    expect(r.detectada).toBe(true);
    expect(r.alvos).toEqual(['public.reposicao_pos_candidatos']);
    expect(r.indeterminado).toBe(false);
  });

  it('NÃO dispara quando pg_get_functiondef só é LIDO numa asserção (o caso das outras 59)', () => {
    // 82 migrations mencionam pg_get_functiondef; a esmagadora maioria só ASSERTA. Confundir
    // leitura com escrita transformaria o detector em ruído e ele seria desligado.
    const r = detectarReescritaViva(`
      DO $pos$ BEGIN
        IF pg_get_functiondef('public.f(text)'::regprocedure) !~ 'gate' THEN
          RAISE EXCEPTION 'regrediu';
        END IF;
      END $pos$;`);
    expect(r.detectada).toBe(false);
  });

  it('NÃO confunde o EXECUTE FUNCTION de CREATE TRIGGER com EXECUTE dinâmico (20260814022626)', () => {
    const r = detectarReescritaViva(`
      CREATE TRIGGER trg BEFORE INSERT ON public.t
        FOR EACH ROW EXECUTE FUNCTION public.guard();
      DO $pos$ BEGIN
        IF pg_get_functiondef('public.f(text)'::regprocedure) !~ 'gate' THEN RAISE EXCEPTION 'x'; END IF;
      END $pos$;`);
    expect(r.detectada).toBe(false);
  });

  it('alvo por VARIÁVEL é indeterminado, mas colhe os literais do arquivo (fail-closed, 20260720120000)', () => {
    const r = detectarReescritaViva(`
      DO $g$
      DECLARE
        v_alvo constant text := 'public.reposicao_pos_candidatos(text)';
        v_oid  regprocedure := to_regprocedure(v_alvo);
        v_def  text;
        v_novo text;
      BEGIN
        v_def  := pg_get_functiondef(v_oid);
        v_novo := regexp_replace(v_def, 'antigo\\(', 'private.cap_compras_ler((SELECT', 'g');
        EXECUTE v_novo;
      END $g$;`);
    expect(r.detectada).toBe(true);
    expect(r.indeterminado).toBe(true);
    expect(r.alvos).toContain('public.reposicao_pos_candidatos');
  });

  it('loop sobre pg_proc sem literal nenhum: detectada e indeterminada, sem alvo', () => {
    const r = detectarReescritaViva(`
      DO $x$ DECLARE r record; BEGIN
        FOR r IN SELECT p.oid FROM pg_proc p WHERE p.prosecdef LOOP
          EXECUTE regexp_replace(pg_get_functiondef(r.oid), 'a', 'b', 'g');
        END LOOP;
      END $x$;`);
    expect(r.detectada).toBe(true);
    expect(r.indeterminado).toBe(true);
    expect(r.alvos).toEqual([]);
  });

  it('o padrão COMENTADO não conta (mesma regra do parser de gate)', () => {
    const r = detectarReescritaViva(`
      -- EXECUTE replace(pg_get_functiondef('public.f(text)'::regprocedure), 'a', 'b');
      /* EXECUTE regexp_replace(pg_get_functiondef('public.g(text)'::regprocedure), 'a','b','g'); */
      SELECT 1;`);
    expect(r.detectada).toBe(false);
  });

  it('colhe também nome SEM assinatura, do `proname IN (…)` de um loop (20260723140000)', () => {
    // A FU4-F fase1 escolhe os alvos por `WHERE n.nspname='public' AND p.proname IN ('a','b')`.
    // Sem colher o literal simples, um alvo do manifest escolhido assim ficaria com alvos=[] e a
    // Parte D o trataria como opaco — falha ABERTA justamente na forma que o repo mais usa em lote.
    const r = detectarReescritaViva(`
      DO $x$ DECLARE v_p record; v_def text; BEGIN
        FOR v_p IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname IN ('get_tint_price','get_tint_prices') LOOP
          v_def := pg_get_functiondef(v_p.sig);
          EXECUTE regexp_replace(v_def, 'a', 'b', 'g');
        END LOOP;
      END $x$;`);
    expect(r.detectada).toBe(true);
    expect(r.indeterminado).toBe(true);
    expect(r.alvos).toContain('public.get_tint_price');
    expect(r.alvos).toContain('public.get_tint_prices');
  });

  it('`DECLARE v_def text :=` na MESMA linha não escapa (era falha ABERTA)', () => {
    // O `DECLARE` colado na variável fazia o detector registrar "declare" como nome da variável,
    // perder o rastro da definição viva e devolver detectada=false — a migration inteira passava.
    const r = detectarReescritaViva(`DO $r$
DECLARE v_def text := pg_get_functiondef('public.fin_estimar_estoque_omie(text)'::regprocedure);
BEGIN
  EXECUTE replace(v_def, 'antigo', 'novo');
END $r$;`);
    expect(r.detectada).toBe(true);
    expect(r.alvos).toEqual(['public.fin_estimar_estoque_omie']);
  });

  it('EXECUTE sem transformação nenhuma da definição viva não é reescrita cirúrgica', () => {
    // `EXECUTE format('GRANT ...')` ao lado de uma leitura de pg_get_functiondef não recria nada.
    const r = detectarReescritaViva(`
      DO $x$ BEGIN
        IF pg_get_functiondef('public.f(text)'::regprocedure) !~ 'gate' THEN RAISE EXCEPTION 'x'; END IF;
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', 'public.f(text)');
      END $x$;`);
    expect(r.detectada).toBe(false);
  });
});
