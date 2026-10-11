-- Tintométrico: staff deixa de ESCREVER direto (PostgREST) no catálogo de fórmulas [money-path]
--
-- Follow-up do challenge Codex (gpt-6-astra · max, 2026-10-11) RETROATIVO sobre o #2915
-- (20261010120000, tombstone da Fase 5 imutável). Veredito: o #2915 protege o tombstone contra DML
-- comum da API, mas NÃO cumpre o título "piso do gate não muda por PATCH de staff". Dois P1:
--
--  P1-a  o piso do tint_gate_revalida é LEAST(v_calc, COALESCE(v_piso, v_calc)). Staff baixa v_calc
--        reduzindo tint_formula_itens.qtd_ml, subindo tint_corantes.volume_total_ml ou remapeando o
--        corante — e o piso cai junto (calc 300→150 com tabela 200 ⇒ piso 200→150).
--  P1-b  numa chave SEM geração '1' (o NULL-preserving deixa o piso = v_calc), staff INSERE uma
--        linha ATIVA na subcoleção '1' com preço baixo: o WHEN do trigger do #2915 só olha o
--        carimbo, a linha entra no max() do preco_csv_legado e o piso cai do calculado para ela.
--        "Fabricar tabela onde não havia." Provado no db/test-tint-grants-escrita-staff.sh (K31:
--        manual 80 barrado com piso 102.5 → aceito depois do INSERT).
--
-- Fatos medidos via psql-ro (2026-10-11) que tornam o corte seguro:
--   * relacl de tint_formulas, tint_formula_itens, tint_subcolecoes, tint_corantes, tint_skus:
--     anon=arwdDxtm, authenticated=arwdDxtm (+ policy "Staff can manage <tabela>" FOR ALL).
--   * O APP NÃO ESCREVE em tint_formulas, tint_formula_itens nem tint_subcolecoes (grep em src/ e
--     supabase/functions: só SELECT/RPC). Os únicos writers são RPCs SECURITY DEFINER do postgres
--     (tint_promote_sync_run, tint_apply_keys_snapshot, tint_ensure_corante_stub) — rodam como dono
--     e não dependem do grant de authenticated.
--   * As escritas legítimas de staff pela API são: tint_skus (TintMapping: omie_product_id/ativo;
--     TintPricing: imposto_pct/margem_pct) e tint_corantes.omie_product_id (TintMapping:411). Ficam.
--   * Ninguém explorou: as linhas ativas da '1' seguem as MESMAS 12 desde a Fase 5 (0 criadas,
--     0 alteradas depois de 2026-07-22).
--
-- O que muda (o grant que sobra é exatamente o que o app usa):
--   tint_formulas, tint_formula_itens, tint_subcolecoes → authenticated só SELECT; anon nada (a RLS
--     segue decidindo QUEM lê). Fecha P1-b, o lado qtd_ml do P1-a, e o TRIGGER/TRUNCATE do achado 5.
--   tint_corantes → idem, mais UPDATE só na coluna omie_product_id (a que o TintMapping grava). Fecha
--     o lado volume do P1-a.
--   tint_skus → perde só TRUNCATE e TRIGGER (as escritas do app ficam).
--   Registradas em scripts/authz-tabelas-fechadas.ts (gate estático do CI + audit de prod): uma
--   migration futura que reabra o grant é barrada no PR.
--
-- O que NÃO fecha (residual registrado no PR — decisão de produto, não de grant):
--   * remapear o corante (tint_corantes.omie_product_id) ou a base (tint_skus.omie_product_id) para
--     um produto Omie mais barato ainda move v_calc — é a função legítima de admin do TintMapping;
--     o que cabe ali é trilha de auditoria, não revogação.
--   * o escape do #2915 por blacklist de session_user (achado H3) e a sonda +1 em preço NULL
--     (latente: 0 carimbadas com preço NULL) — fora desta migration.
--
-- Aplicar: bun run db:aplicar supabase/migrations/20261011120000_tint_grants_escrita_staff.sql
--   (o executor fornece a transação — por isso NÃO há BEGIN/COMMIT aqui). Idempotente: REVOKE/GRANT
--   repetidos são no-op. Reversão: GRANT ALL nas 4 tabelas a anon, authenticated (o estado
--   anterior era arwdDxtm) + GRANT TRUNCATE, TRIGGER em tint_skus — e tirar as entradas do registro.
-- Prova: db/test-tint-grants-escrita-staff.sh (PG17, snapshot + #2915 + esta migration, gate real).

-- Padrão canônico de fecho por privilégio do repo (o mesmo do product_costs, 20260725130000):
-- REVOKE ALL de PUBLIC/anon/authenticated + GRANT SELECT. Todas as policies destas 4 tabelas são
-- TO authenticated (psql-ro 2026-10-11), então anon já não lia nada por RLS — tirar o grant dele é
-- neutro em comportamento e fecha o TRUNCATE (que NÃO passa por RLS).
REVOKE ALL ON TABLE public.tint_formulas, public.tint_formula_itens,
                    public.tint_subcolecoes, public.tint_corantes
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tint_formulas, public.tint_formula_itens,
                      public.tint_subcolecoes, public.tint_corantes
  TO authenticated;
-- A ÚNICA escrita de staff nessas 4 pela API: o TintMapping remapeia o corante (TintMapping:411).
GRANT UPDATE (omie_product_id) ON public.tint_corantes TO authenticated;

-- tint_skus segue com as escritas do app (TintMapping/TintPricing); perde só o que nada usa e que
-- passa por fora da RLS (TRUNCATE) ou substitui guard (TRIGGER).
REVOKE TRUNCATE, TRIGGER ON public.tint_skus FROM anon, authenticated;

-- Pós-condição: o grant que sobra é exatamente o pretendido, nos DOIS sentidos — privilégio a mais
-- AUSENTE e escrita legítima do app PRESENTE (revogar de mais quebraria o TintMapping em silêncio).
DO $post$
DECLARE
  v_tab   text;
  v_role  text;
  v_priv  text;
  v_tabs  text[] := ARRAY['public.tint_formulas', 'public.tint_formula_itens',
                          'public.tint_subcolecoes', 'public.tint_corantes'];
  v_privs text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                          'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_ruim  text[] := '{}';
BEGIN
  FOREACH v_tab IN ARRAY v_tabs LOOP
    FOREACH v_priv IN ARRAY v_privs LOOP
      IF has_table_privilege('anon', v_tab, v_priv) THEN
        v_ruim := v_ruim || format('anon ainda tem %s em %s', v_priv, v_tab);
      END IF;
      IF v_priv <> 'SELECT' AND has_table_privilege('authenticated', v_tab, v_priv) THEN
        v_ruim := v_ruim || format('authenticated ainda tem %s em %s', v_priv, v_tab);
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', v_tab, 'SELECT') THEN
      v_ruim := v_ruim || format('authenticated PERDEU SELECT em %s', v_tab);
    END IF;
  END LOOP;

  -- a coluna do volume entra no custo do corante (v_calc): GRANT de coluna não pode tê-la
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_column_privilege(v_role, 'public.tint_corantes', 'volume_total_ml', 'UPDATE') THEN
      v_ruim := v_ruim || format('%s atualiza tint_corantes.volume_total_ml', v_role);
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['TRUNCATE', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.tint_skus', v_priv) THEN
        v_ruim := v_ruim || format('%s ainda tem %s em public.tint_skus', v_role, v_priv);
      END IF;
    END LOOP;
  END LOOP;
  IF has_column_privilege('anon', 'public.tint_corantes', 'omie_product_id', 'UPDATE') THEN
    v_ruim := v_ruim || 'anon atualiza tint_corantes.omie_product_id'::text;
  END IF;

  -- o que o app usa TEM de continuar (TintMapping/TintPricing)
  IF NOT has_column_privilege('authenticated', 'public.tint_corantes', 'omie_product_id', 'UPDATE') THEN
    v_ruim := v_ruim || 'authenticated PERDEU UPDATE de tint_corantes.omie_product_id (TintMapping)'::text;
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.tint_skus', v_priv) THEN
      v_ruim := v_ruim || format('authenticated PERDEU %s em public.tint_skus (TintMapping/TintPricing)', v_priv);
    END IF;
  END LOOP;

  IF cardinality(v_ruim) > 0 THEN
    RAISE EXCEPTION 'pós-condição tint_grants_escrita_staff: % problema(s): %',
                    cardinality(v_ruim), array_to_string(v_ruim, ' · ');
  END IF;
  RAISE NOTICE 'pós-condição tint_grants_escrita_staff: grants conferidos';
END
$post$;

SELECT 'TINT_GRANTS_ESCRITA_STAFF_OK' AS marcador;
