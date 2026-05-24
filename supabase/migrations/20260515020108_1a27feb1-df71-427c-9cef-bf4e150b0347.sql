DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM calcular_gatilhos_reposicao('OBEN');
  RAISE NOTICE 'Resultado: %', r;
END $$;