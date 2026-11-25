CREATE FUNCTION pg_temp.ms(q text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz; h text;
BEGIN t0 := clock_timestamp(); EXECUTE 'SELECT md5(coalesce(string_agg(t::text, '''' ), '''')) FROM (' || q || ') t' INTO h;
RETURN round(extract(epoch FROM clock_timestamp() - t0) * 1000)::text || 'ms'; END $f$;

SELECT set_config('request.jwt.claims', '{"sub":"700657a1-d75d-4c72-99b1-0a0f2065fa29","role":"authenticated"}', true);
DO $m$
DECLARE r text := '';
BEGIN
  r := r || ' caca_cand_p1=' || pg_temp.ms('SELECT * FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo LIMIT 1000');
  r := r || ' caca_compr=' || pg_temp.ms('SELECT * FROM public.v_caca_compradores ORDER BY documento, empresa LIMIT 1000');
  r := r || ' grupo_com=' || pg_temp.ms('SELECT * FROM public.v_grupo_comercial');
  r := r || ' grupo_cont=' || pg_temp.ms('SELECT * FROM public.v_grupo_contatos WHERE grupo_id = ''33f59dc7-872e-45de-bc46-75117e47a3d9''');
  r := r || ' lista_prio=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(NULL, NULL, ''prioridade'', 100, 0)');
  r := r || ' lista_ult=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(NULL, NULL, ''nome'', 100, 16000)');
  r := r || ' lista_busca_vazia=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(''zzqx-inexistente'', NULL, ''nome'', 100, 0)');
  r := r || ' resolver=' || pg_temp.ms('SELECT * FROM public.resolver_cliente_por_telefone(''4733330003'')');
  RAISE NOTICE 'ENSAIO_OK antes:%', r;
END $m$;
