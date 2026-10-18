-- Carga das decisões da fase A do Raio-X (Oben). Corpo para o db:aplicar: sem begin/commit.
insert into raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em, origem, tirou_do_motor) values
  ('oben', 11978609194, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:55.770Z'::timestamptz, 14::numeric, 360.104875::numeric, 5041.46825::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 11993378727, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:33.587Z'::timestamptz, 21::numeric, 79.463042::numeric, 1668.723882::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 11993380584, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:27.704Z'::timestamptz, 22::numeric, 75.690127::numeric, 1665.182794::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12042877863, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:39.170Z'::timestamptz, 457::numeric, 8.3845::numeric, 3831.7164999999995::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12044994786, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:00.370Z'::timestamptz, 29::numeric, 71.750652::numeric, 2080.768908::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12074056920, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:59.554Z'::timestamptz, 15::numeric, 296.487999::numeric, 4447.319985::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12074056924, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:00.820Z'::timestamptz, 21::numeric, 279.515453::numeric, 5869.824513::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12114962018, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:31.120Z'::timestamptz, 20::numeric, 86.978::numeric, 1739.56::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689720593, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:31.170Z'::timestamptz, 863::numeric, 3.3235::numeric, 2868.1805::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689723220, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:47.587Z'::timestamptz, 14::numeric, 286.482876::numeric, 4010.7602639999996::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689723269, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:08.437Z'::timestamptz, 30::numeric, 230.750816::numeric, 6922.52448::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689734282, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:52.971Z'::timestamptz, 211::numeric, 22.65::numeric, 4779.15::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689738594, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:54.204Z'::timestamptz, 88::numeric, 25.360946::numeric, 2231.7632479999997::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689743946, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:05.906Z'::timestamptz, 58::numeric, 108.224378::numeric, 6277.013924::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689767723, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T21:39:11.050Z'::timestamptz, 15::numeric, 44.485::numeric, 667.275::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689780611, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T21:39:09.035Z'::timestamptz, 15::numeric, 44.71925::numeric, 670.78875::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8815859282, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:56.920Z'::timestamptz, 24::numeric, 87.649583::numeric, 2103.589992::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false)
on conflict do nothing;
do $$
declare v_exato bigint; v_total bigint;
begin
  with esperado (empresa, sku, destino, decidido_por, decidido_em, saldo, cmc, valor, categoria, foto_em, origem, tirou) as (values
  ('oben', 11978609194, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:55.770Z'::timestamptz, 14::numeric, 360.104875::numeric, 5041.46825::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 11993378727, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:33.587Z'::timestamptz, 21::numeric, 79.463042::numeric, 1668.723882::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 11993380584, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:27.704Z'::timestamptz, 22::numeric, 75.690127::numeric, 1665.182794::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12042877863, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:39.170Z'::timestamptz, 457::numeric, 8.3845::numeric, 3831.7164999999995::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12044994786, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:00.370Z'::timestamptz, 29::numeric, 71.750652::numeric, 2080.768908::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12074056920, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:59.554Z'::timestamptz, 15::numeric, 296.487999::numeric, 4447.319985::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12074056924, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:00.820Z'::timestamptz, 21::numeric, 279.515453::numeric, 5869.824513::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 12114962018, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:41:31.120Z'::timestamptz, 20::numeric, 86.978::numeric, 1739.56::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689720593, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:31.170Z'::timestamptz, 863::numeric, 3.3235::numeric, 2868.1805::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689723220, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:47.587Z'::timestamptz, 14::numeric, 286.482876::numeric, 4010.7602639999996::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689723269, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:08.437Z'::timestamptz, 30::numeric, 230.750816::numeric, 6922.52448::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689734282, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:39:52.971Z'::timestamptz, 211::numeric, 22.65::numeric, 4779.15::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689738594, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:54.204Z'::timestamptz, 88::numeric, 25.360946::numeric, 2231.7632479999997::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689743946, 'estrategico', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:05.906Z'::timestamptz, 58::numeric, 108.224378::numeric, 6277.013924::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689767723, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T21:39:11.050Z'::timestamptz, 15::numeric, 44.485::numeric, 667.275::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8689780611, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T21:39:09.035Z'::timestamptz, 15::numeric, 44.71925::numeric, 670.78875::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),
  ('oben', 8815859282, 'liquidar', '414a9727-ad1d-4998-914e-9c6ccf26cf50'::uuid, '2026-10-15T08:40:56.920Z'::timestamptz, 24::numeric, 87.649583::numeric, 2103.589992::numeric, 'mercadoria', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false)
  )
  select count(*) into v_exato
    from raio_x_decisao d join esperado e on d.empresa = e.empresa and d.sku_codigo_omie = e.sku
   where d.empresa = 'oben' and d.origem = 'artifact_fase_a'
     and d.destino is not distinct from e.destino
     and d.decidido_por is not distinct from e.decidido_por
     and d.decidido_em is not distinct from e.decidido_em
     and d.foto_saldo is not distinct from e.saldo
     and d.foto_cmc is not distinct from e.cmc
     and d.foto_valor is not distinct from e.valor
     and d.foto_categoria is not distinct from e.categoria
     and d.foto_em is not distinct from e.foto_em
     and d.tirou_do_motor is not distinct from e.tirou;
  if v_exato <> 17 then
    raise exception 'POSTCONDICAO_TUPLAS: esperado 17 linhas identicas as tuplas da carga, achei %', v_exato;
  end if;
  select count(*) into v_total from raio_x_decisao where origem = 'artifact_fase_a';
  if v_total <> 17 then
    raise exception 'POSTCONDICAO_ORIGEM: esperado 17 linhas com origem artifact_fase_a (todas as empresas), achei %', v_total;
  end if;
end $$;
-- CARGA-FASE-A-OK
