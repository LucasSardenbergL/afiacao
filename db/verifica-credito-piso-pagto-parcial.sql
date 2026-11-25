-- Verificação COMPORTAMENTAL em prod da migration 20261121200000 (piso vê PAGTO PARCIAL).
-- Rodar SÓ em ensaio (faz ROLLBACK; não grava nada): bun run db:aplicar db/verifica-credito-piso-pagto-parcial.sql --ensaio
-- O claude_ro (psql-ro) não executa o gate (ACL fechada por desenho) — por isso o ensaio do envelope.
-- Aborta se algum par com PAGTO PARCIAL vencido > 60 d NÃO for bloqueado, ou se o gate reportar o valor cheio.
DO $verifica$
DECLARE
  v_corte date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);
  r record;
  g jsonb;
  v_pares integer := 0;
  v_bloq integer := 0;
  v_null integer := 0;
BEGIN
  FOR r IN SELECT DISTINCT f.company, f.omie_codigo_cliente
             FROM public.fin_contas_receber f
            WHERE f.status_titulo = 'PAGTO PARCIAL' AND f.data_vencimento <= v_corte LOOP  -- qualquer saldo
    g := public.venda_gate_credito_grupo(gen_random_uuid(), r.company, r.omie_codigo_cliente);
    v_pares := v_pares + 1;
    -- IS DISTINCT FROM: resposta sem a chave ({}) dá NULL e NÃO pode passar (Codex diff P2-3)
    IF (g -> 'bloqueado') IS DISTINCT FROM 'true'::jsonb
       OR (g -> 'motivo') IS DISTINCT FROM '"vencido_60d_sem_excecao"'::jsonb THEN
      RAISE EXCEPTION 'VERIFICA FALHOU: %/% não bloqueou (%)', r.company, r.omie_codigo_cliente, g ->> 'motivo';
    END IF;
    v_bloq := v_bloq + 1;
    IF NOT (g ? 'vencido') OR (g -> 'vencido') IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'VERIFICA FALHOU: %/% reportou vencido % (esperado null: valor indeterminado)',
        r.company, r.omie_codigo_cliente, COALESCE(g ->> 'vencido', '<ausente>');
    END IF;
    v_null := v_null + 1;
  END LOOP;
  IF v_pares = 0 THEN
    RAISE EXCEPTION 'VERIFICA FALHOU: 0 pares com PAGTO PARCIAL vencido > 60 d — nada provado (ausente ≠ ok)';
  END IF;
  RAISE NOTICE 'VERIFICA OK: % pares PAGTO PARCIAL vencido > 60 d · % bloqueados · % com vencido null', v_pares, v_bloq, v_null;
END
$verifica$;
