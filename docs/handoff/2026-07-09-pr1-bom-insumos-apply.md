# PR-1 — Apply das views de demanda de insumos (BOM)

> **Status:** ✅ pronto. PG17 verde (PASS=46, com falsificação) · Codex challenge do SQL (8 furos latentes, 3 corrigidos + 5 vigiados) · review final da branch **aprovado para merge**. Aguarda só o seu apply.
> **Natureza:** money-path, mas **INERTE por construção** — cria 4 views novas e NÃO religa nada. Aplicar isto **não muda nenhum número do cockpit** (provado no PG17: `EXCEPT ALL` nas 4 views estatísticas + `pg_depend`). O comportamento só muda no **PR-2** (religamento).

## Por que é manual

O Lovable não aplica migration de nome custom (falha silenciosa). Este SQL vive em `db/reposicao-demanda-insumos-bom.sql` (fonte viva, fora de `supabase/migrations/`), no padrão dos outros money-path do repo (`db/embalagem-motor-rpc.sql`, `db/reposicao-consolidacao-demanda.sql`). Você cola no SQL Editor do Lovable → Run.

## Passo 1 — aplicar o SQL

Abra [`db/reposicao-demanda-insumos-bom.sql`](../../db/reposicao-demanda-insumos-bom.sql), copie o conteúdo inteiro e cole no **🟣 Lovable → SQL Editor → Run**. São 4 `CREATE OR REPLACE VIEW` + `REVOKE/GRANT` — idempotente (re-colar é seguro).

## Passo 2 — validação pós-apply (read-only)

Cole e rode no SQL Editor. Os valores esperados vêm da medição em produção (2026-07-09):

```sql
SELECT 'insumos_elegiveis'      AS chk, count(DISTINCT comp_oben)::text AS valor, '23'   AS esperado FROM v_pcp_malha_oben
UNION ALL
SELECT 'quarentena_unidade',    count(DISTINCT comp_oben)::text, '33'
  FROM v_pcp_malha_oben_quarentena WHERE motivo = 'unidade_divergente'
UNION ALL
SELECT 'base_tingimix_visivel', count(*)::text, '1'
  FROM v_pcp_malha_oben WHERE comp_oben = 8689961993
UNION ALL
SELECT 'demanda_base_L_por_dia', round(sum(quantidade) / 90.0, 2)::text, '~0.58'
  FROM v_sku_demanda_efetiva
  WHERE sku_codigo_omie = 8689961993 AND data_emissao >= CURRENT_DATE - 90
UNION ALL
SELECT 'anon_nao_le',            has_table_privilege('anon','v_pcp_malha_oben','SELECT')::text, 'false';
```

Leitura do resultado:
- `insumos_elegiveis = 23` — os insumos que o PR-2 vai destravar (inclui BASE TINGIMIX + 4 soluções XT.1803).
- `quarentena_unidade = 33` — insumos com unidade da ficha ≠ unidade de estoque; **ficam listados, não somem** (precisão > recall).
- `base_tingimix_visivel = 1` e `demanda_base ≈ 0.58` — o item que originou tudo, agora com demanda explodida (~4× a de venda direta).
- `anon_nao_le = false` — a anon-key pública **não** lê a ficha técnica (security_invoker + REVOKE).

Eu rodo essa mesma validação via `psql-ro` depois que você aplicar, para confirmar de forma independente.

## Passo 3 — quarentena (diagnóstico opcional)

Para ver o que ficou de fora e por quê (útil para decidir a Fase 2 — conversão de unidade):

```sql
SELECT motivo, count(DISTINCT comp_oben) AS insumos
FROM v_pcp_malha_oben_quarentena
GROUP BY motivo ORDER BY insumos DESC;
```

## O que NÃO fazer ainda

- **Não** é o PR-2. Nada no cockpit muda com este apply. Não espere o TINGIMIX aparecer na tela de pedidos ainda.
- O PR (se criado) fica **DRAFT** até a validação pós-apply passar — o auto-merge do repo mergeia PR não-draft assim que o CI fica verde.

## Achados desta entrega (para você decidir, fora do PR-1)

1. **Chip `PRD03688`** — cadastro duplicado no Omie (2 produtos ativos OBEN com o mesmo código). O guard os quarentena; impacto de demanda zero. Limpar no Omie quando puder.
2. **Chip `security_invoker` em `v_venda_items_history_efetivo`** — o texto de `db/reposicao-consolidacao-demanda.sql` recria essa view sem `security_invoker`, mas a prod tem (do P0). Reaplicar aquele arquivo regride a proteção. Dívida pré-existente, fora deste PR.
