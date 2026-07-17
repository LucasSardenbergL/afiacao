# Correção do guard #10 (allowlist de CFOP) — apply

> **Contexto:** o PR-2 (#1308) já está mergeado na `main` e **aplicado em prod** com o guard `AND v.quantidade > 0` — premissa que o Codex **refutou**: o writer (`omie-sync-vendas-items`) grava `quantidade` sempre ≥0; a devolução é sinalizada por **CFOP**, não pelo sinal. Esse guard é quase no-op e **não cobre o furo real**: uma devolução de **compra** (CFOP `6202`, que é saída e positiva) de um pai com ficha explodiria consumo falso do insumo → demanda inflada → compra em excesso. Este PR troca o guard por uma **allowlist de CFOP de venda**. Furo **latente** (0 casos hoje — provado), mas real.

## Apply (1 passo — idempotente)

🟣 **SQL Editor do Lovable:** cole o conteúdo inteiro de [`db/reposicao-demanda-insumos-bom.sql`](../../db/reposicao-demanda-insumos-bom.sql) → **Run**. É `CREATE OR REPLACE VIEW` — re-aplica a `v_sku_demanda_efetiva` com o guard novo. **Não** precisa re-aplicar o religamento (as 4 views estatísticas não mudam).

## Validação pós-apply (read-only — cole no SQL Editor; eu confirmo via psql-ro)

```sql
SELECT 'guard_tem_cfop_allowlist' AS chk,
       (pg_get_viewdef('v_sku_demanda_efetiva'::regclass, true) LIKE '%cfop IN%')::text AS valor, 'true' AS esperado
UNION ALL
SELECT 'nenhum_consumo_de_6202', (count(*) = 0)::text, 'true'
  FROM v_sku_demanda_efetiva WHERE valor_total IS NULL AND cfop = '6202'
UNION ALL
SELECT 'sentinela_cfop_venda_novo', (count(*) = 0)::text, 'true'   -- pai vendendo com CFOP de saída fora da allowlist
  FROM v_venda_items_history_efetivo v JOIN v_pcp_malha_oben m ON m.pai_oben = v.sku_codigo_omie
  WHERE v.empresa = 'OBEN' AND (v.cfop LIKE '5%' OR v.cfop LIKE '6%')
    AND v.cfop NOT IN ('5101','5102','5107','5108','6101','6102','6107','6108','6202');
```

- `guard_tem_cfop_allowlist = true` — a v_sku_demanda_efetiva em prod passou a ter o guard de CFOP.
- `nenhum_consumo_de_6202 = true` — nenhuma linha de consumo veio de uma devolução de compra.
- `sentinela_cfop_venda_novo = true` — nenhum pai vende com CFOP de saída fora da allowlist. Se der `false` um dia: **adicione à allowlist SÓ se for CFOP de venda de saída legítimo** (5.1xx/6.1xx); **nunca** entrada/devolução — isso reabriria o furo.

## O que muda

Nada de comportamento observável **hoje** (0 casos de `6202` em pai com ficha — medido). Fecha o furo latente: se um pai passar a registrar devolução de compra, ela não infla mais a demanda do insumo.

## Prova

Harness PG17 `db/test-reposicao-religamento.sh` **PASS=16** (com falsificação): assert `C2` (devolução de compra `6202`, qtde positiva, não vira consumo) + `SAB1` (sem o guard de CFOP, as 2 devoluções `1201`+`6202` vazam → prova que o guard protege). Codex challenge do SQL (2ª opinião money-path) validou a allowlist.
