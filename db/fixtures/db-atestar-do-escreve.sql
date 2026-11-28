-- fixture do db/test-db-atestar.sh: um bloco DO que ESCREVE quando o estado não é o esperado
CREATE TABLE IF NOT EXISTS public.atestar_cfg (k text PRIMARY KEY, v text);
DO $semeia$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.atestar_cfg WHERE k = 'modo') THEN
    INSERT INTO public.atestar_cfg (k, v) VALUES ('modo', 'novo');
  END IF;
END
$semeia$;
