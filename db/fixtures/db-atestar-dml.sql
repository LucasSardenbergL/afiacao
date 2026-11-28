-- fixture do db/test-db-atestar.sh: DML sem prova automática (exige --pos)
CREATE TABLE IF NOT EXISTS public.atestar_cfg (k text PRIMARY KEY, v text);
UPDATE public.atestar_cfg SET v = 'novo' WHERE k = 'modo';
