-- 20260722110000_drop_omie_clientes_espelho.sql
-- P0-B-bis Fatia 5B (FINAL) — DROP do espelho legado `omie_clientes`.
--
-- Encerra o épico que passou 5 fatias tirando dependências desta tabela. Ela era o mapa
-- `user_id -> omie_codigo_cliente` de conta ÚNICA (`unique_user_omie UNIQUE(user_id)`), com o
-- rótulo `empresa_omie` comprovadamente falso: 6909/6909 linhas 'colacor' porque a coluna e
-- `DEFAULT 'colacor' NOT NULL` e NENHUM writer jamais a setou. Um mapa de identidade de cliente
-- que nao sabe de que CONTA e o codigo — foi a raiz de PV barrado (P0-A) e de vendedor cruzado.
--
-- ============================================================================
-- EVIDENCIA que autoriza o DROP (toda medida por psql-ro em PROD, 2026-07-18/19)
-- ============================================================================
-- 1. PREFLIGHT `db/preflight-dependencia-tabela.sql`: ZERO linhas acionaveis. A classe `rotina`,
--    que listava `_data_health_compute` e `seed_targets_faltantes`, SUMIU depois da Fatia 5A.
--    Sobram so objetos DA PROPRIA tabela (2 indices, 3 constraints, 2 policies, 2 triggers) —
--    caem junto, e o `pg_depend` confirma zero dependente externo.
-- 2. ZERO leitores vivos no codigo: `from('omie_clientes')` nao existe em `src/` nem em
--    `supabase/functions/`. As ocorrencias restantes da string sao comentarios/tombstones + 2
--    textos de UI que EXIBEM o nome da tabela na tela (AdminAnalyticsSync, TechnicalDocs).
-- 3. PROVA DE COMPORTAMENTO em producao, discriminante (nao prova por ausencia):
--      • espelho `max(updated_at)` = 2026-07-18 05:02:40, INALTERADO depois do cron
--        `sync-customers-vendas-daily` de 19/07 05:00 => o writer esta morto;
--      • `omie_customer_account_map(oben)` avancou para 2026-07-19 05:02:41 no MESMO run
--        => a edge nova escreveu. "Nada aconteceu" e "edge velha" ficam descartados;
--      • `_data_health_compute`: 24 checks intactos, le a proof, `vendas_cadastros` = ok;
--      • `seed_targets_faltantes`: le o ledger; `farmer_client_scores` 6256 -> 6632 (+376),
--        alvos 392 -> 0, e os 16 sem score sao `excluir_da_carteira` (legitimo), ZERO sem motivo.
--
-- ============================================================================
-- O DADO QUE SOME — e por que cada coluna e dispensavel
-- ============================================================================
--   user_id + omie_codigo_cliente ... coberto por `omie_customer_account_map` (16056 pares)
--                                     UNIAO `customer_canonical_alias` (1633): so-no-espelho = 0
--   created_at ...................... ja copiado p/ `carteira_membership_ledger.first_seen_at`
--                                     no backfill da Fatia 0
--   empresa_omie .................... 6909/6909 'colacor' — DEFAULT constante, nao e fato
--   omie_codigo_vendedor ............ a fonte account-correta e a proof (Fatia 1 migrou a carteira)
--   omie_codigo_cliente_integracao .. 41 linhas de 6909, todas de marco, zero leitores
--
-- /!\ O ARQUIVO MORTO NAO E PARANOIA — e o que torna esta acao REVERSIVEL. Um `DROP TABLE` nao
--     tem volta, e o `supabase/schema-snapshot.sql` e schema-only (nao guarda os 6909 registros).
--     Das colunas acima, a UNICA nao-reconstruivel a partir de proof ∪ alias ∪ ledger e
--     `omie_codigo_cliente_integracao`. Custo do arquivo: uma tabela de 6909 linhas (~1 MB),
--     trancada. Custo de NAO ter: se em 6 meses aparecer uma reconciliacao fiscal que precise do
--     codigo de integracao, o dado nao existe em lugar nenhum. Precisao > recall aplicado a
--     PROPRIA decisao de dropar.
--
-- ============================================================================
-- ORDEM (o bloco e atomico — ou tudo, ou nada)
-- ============================================================================
BEGIN;

-- 1) ARQUIVO MORTO — snapshot fiel, ANTES do DROP.
--    ⚠️ Tabela criada no SQL Editor nasce SEM RLS e legivel+GRAVAVEL por `anon` (default privilege
--    do Supabase — database.md §7). Este bloco a tranca no MESMO commit: RLS ligada, sem policy
--    nenhuma (=> nega tudo para quem nao bypassa) + REVOKE explicito de anon/authenticated/PUBLIC
--    (REVOKE FROM PUBLIC sozinho NAO tira anon/authenticated — eles tem grant proprio).
--    `service_role`/`postgres` seguem lendo por BYPASSRLS, que e o necessario p/ uma restauracao.
CREATE TABLE IF NOT EXISTS public._archive_omie_clientes_20260722 AS
  SELECT * FROM public.omie_clientes;

COMMENT ON TABLE public._archive_omie_clientes_20260722 IS
  'Arquivo morto do espelho omie_clientes, dropado na Fatia 5B do P0-B-bis (2026-07-22). '
  'Somente para restauracao/auditoria: a coluna omie_codigo_cliente_integracao (41 linhas) e o '
  'unico dado NAO reconstruivel a partir de omie_customer_account_map + customer_canonical_alias '
  '+ carteira_membership_ledger. NAO usar como fonte: empresa_omie e DEFAULT constante (falso).';

ALTER TABLE public._archive_omie_clientes_20260722 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._archive_omie_clientes_20260722 FROM PUBLIC, anon, authenticated;

-- 2) O DROP. Sem CASCADE de proposito: se algum dependente tiver surgido entre o preflight e o
--    Run, o comando FALHA e a transacao inteira reverte — em vez de derrubar em silencio um objeto
--    que ninguem inventariou. Falhar aqui e o resultado BOM.
DROP TABLE public.omie_clientes;

COMMIT;

-- ============================================================================
-- Validacao pos-apply (cole no SQL Editor apos o Run).
-- Espere: tabela_sumiu=t · arquivo_linhas=6909 · anon_le_arquivo=f · authenticated_le_arquivo=f
--         checks_sentinela=24 · trigger_orfao=0
-- ============================================================================
SELECT
  to_regclass('public.omie_clientes') IS NULL                                    AS tabela_sumiu,
  (SELECT count(*) FROM public._archive_omie_clientes_20260722)                  AS arquivo_linhas,
  has_table_privilege('anon','public._archive_omie_clientes_20260722','SELECT')  AS anon_le_arquivo,
  has_table_privilege('authenticated','public._archive_omie_clientes_20260722','SELECT') AS authenticated_le_arquivo,
  (SELECT count(*) FROM public._data_health_compute())                           AS checks_sentinela,
  (SELECT count(*) FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('trg_omie_clientes_to_ledger','update_omie_clientes_updated_at')) AS trigger_orfao;

-- As 2 funcoes que a Fatia 5A migrou continuam de pe SEM a tabela? (late-bound: so o EXECUTE prova)
SELECT source, status, freshness_basis FROM public._data_health_compute() WHERE source = 'vendas_cadastros';
