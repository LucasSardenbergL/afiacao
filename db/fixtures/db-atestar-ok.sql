-- fixture do db/test-db-atestar.sh: migration "colada no SQL Editor" (com envelope), toda provável
BEGIN;
CREATE TABLE IF NOT EXISTS public.atestar_t (id bigint PRIMARY KEY, valor numeric);
ALTER TABLE public.atestar_t ADD COLUMN IF NOT EXISTS obs text, ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS atestar_t_valor_idx ON public.atestar_t (valor);
CREATE OR REPLACE FUNCTION public.atestar_soma(p_a numeric, p_b numeric DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN p_a + p_b;  -- corpo que o md5 tem de achar
END
$fn$;
REVOKE ALL ON FUNCTION public.atestar_soma(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atestar_soma(numeric, numeric) TO service_role;
DROP POLICY IF EXISTS atestar_t_le ON public.atestar_t;
CREATE POLICY atestar_t_le ON public.atestar_t FOR SELECT TO authenticated USING (true);
CREATE OR REPLACE VIEW public.atestar_v WITH (security_invoker = on) AS SELECT id, valor FROM public.atestar_t;
CREATE OR REPLACE FUNCTION public.atestar_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
DROP TRIGGER IF EXISTS atestar_t_trg ON public.atestar_t;
CREATE TRIGGER atestar_t_trg BEFORE INSERT ON public.atestar_t FOR EACH ROW EXECUTE FUNCTION public.atestar_trg();
COMMENT ON TABLE public.atestar_t IS 'fixture; ; com ponto-e-vírgula no texto';
DO $post$
BEGIN
  IF to_regprocedure('public.atestar_soma(numeric, numeric)') IS NULL THEN
    RAISE EXCEPTION 'POS: atestar_soma ausente';
  END IF;
END
$post$;
NOTIFY pgrst, 'reload schema';
COMMIT;
