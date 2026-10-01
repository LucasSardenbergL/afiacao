-- db/fixtures/pre-trava-template.sql — a instância PROVADA do template "recriar objeto vivo"
-- (.claude/skills/lovable-db-operator/references/sql-house-style.md): TRAVA → PRE → CREATE → PÓS,
-- para uma função e uma view. Exercitada por db/test-pre-anti-deriva-concorrencia.sh em duas
-- sessões concorrentes, com e sem o bloco $trava$. Sem BEGIN/COMMIT: a prova (ou o executor) dá a
-- transação; no SQL Editor/MCP, o arquivo real leva `BEGIN;` no topo e `COMMIT;` no fim.

-- TRAVA, antes de ler: ALTER sem efeito em CADA objeto que a PRE guarda e que este arquivo recria.
-- Função: a volatilidade VIVA (pg_proc.provolatile) — atualiza a linha de pg_proc, e quem tentar
-- recriá-la espera esta transação e falha alto (XX000). View: o security_invoker VIVO — prende a
-- view em ACCESS EXCLUSIVE; quem tentar recriá-la espera (e, se não tiver PRE, aplica DEPOIS).
DO $trava$
BEGIN
  IF to_regprocedure('public.trava_alvo_f()') IS NOT NULL THEN
    ALTER FUNCTION public.trava_alvo_f() STABLE;
  END IF;
  IF to_regclass('public.trava_alvo_v') IS NOT NULL THEN
    ALTER VIEW public.trava_alvo_v SET (security_invoker = on);
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente aborta: sem objeto a trava
-- não prende nada, e um CREATE concorrente que commitasse antes do nosso seria apagado.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('trava_alvo_f()',
         (SELECT md5(p.prosrc)
            FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.trava_alvo_f()')),
         'f150aad8dd266247b8908d3114492975', '747315aee156042621a96709601ebc31'),
        ('trava_alvo_v',
         (SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true))
            FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.trava_alvo_v')),
         'a27346427e6398a8fc7f605f33cc34a6', 'ac35bdc22e565934a8d890d6e3fbbe3d')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.trava_alvo_f() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'este'$$;

CREATE OR REPLACE VIEW public.trava_alvo_v WITH (security_invoker = on) AS SELECT 'este'::text AS x;

-- PÓS: o corpo vivo é ESTE (a mesma régua da PRE).
DO $pos$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.trava_alvo_f()'))
       IS DISTINCT FROM '747315aee156042621a96709601ebc31' THEN
    RAISE EXCEPTION 'POS FALHOU: trava_alvo_f';
  END IF;
  IF (SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true)) FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.trava_alvo_v'))
       IS DISTINCT FROM 'ac35bdc22e565934a8d890d6e3fbbe3d' THEN
    RAISE EXCEPTION 'POS FALHOU: trava_alvo_v';
  END IF;
END
$pos$;
