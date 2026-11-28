-- prova read-only da db-atestar-dml.sql (o --pos): imprime POSCONDICAO_OK só com o efeito no banco
SELECT CASE WHEN EXISTS (SELECT 1 FROM public.atestar_cfg WHERE k = 'modo' AND v = 'novo') THEN 'POSCONDICAO_OK' ELSE 'POSCONDICAO_NAO' END;
