-- Validação PÓS-APPLY de 20260731120000_farmer_assoc_rules_delete_qualificado.sql
--
-- LÊ CATÁLOGO, NÃO INVOCA a função (database.md §"Validação pós-apply que EXECUTA
-- o objeto mente nos DOIS sentidos"): assim roda igual no SQL Editor (superuser) e
-- no psql-ro, e um `permission denied` do REVOKE não se disfarça de falha da migration.
-- Mede a definição SEM COMENTÁRIOS — a própria migration injeta um comentário que
-- cita a forma do bug e casaria a si mesmo (§"o ALVO mente").
--
-- Esperado: as 4 linhas com ok = true.

WITH def AS (
  SELECT regexp_replace(
           pg_get_functiondef(to_regprocedure('public.farmer_association_rules_substituir(jsonb)')::oid),
           '--[^\n]*', '', 'g') AS nu
)
SELECT 'V1 função existe'                     AS check,
       to_regprocedure('public.farmer_association_rules_substituir(jsonb)') IS NOT NULL AS ok
UNION ALL
SELECT 'V2 DELETE está qualificado',
       position('DELETE FROM public.farmer_association_rules WHERE true;' in nu) > 0 FROM def
UNION ALL
SELECT 'V3 não sobrou DELETE sem WHERE',
       position('DELETE FROM public.farmer_association_rules;' in nu) = 0 FROM def
UNION ALL
-- o fix não pode ter afrouxado o gate nem a recusa de lote vazio
SELECT 'V4 gate staff + recusa de lote vazio intactos',
       nu ~ 'has_role\(auth\.uid\(\), ''master''' AND nu ~ 'TR001' FROM def;

-- Prova de EFEITO (rode ~1h depois do Publish/deploy, ou após forçar o recálculo):
-- as regras têm de voltar a se mover, e num ÚNICO timestamp — `now()` é o instante da
-- TRANSAÇÃO, então a RPC atômica grava N linhas com N timestamps IDÊNTICOS. Vários
-- timestamps distintos = ainda é o caminho antigo (INSERT por regra).
--
--   SELECT count(*) AS regras,
--          count(DISTINCT created_at) AS ts_distintos,   -- tem que ser 1
--          max(created_at) AS ultima
--   FROM public.farmer_association_rules;
