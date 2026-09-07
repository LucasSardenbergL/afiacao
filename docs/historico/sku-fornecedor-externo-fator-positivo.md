# `sku_fornecedor_externo.fator_conversao` — CHECK de positividade E finitude (2026-09-04)

**Contexto.** O #2149 pôs a edge `enviar-pedido-portal-sayerlack` a converter litro → balde
(`qtde_portal = ceil(round6(qtde_final × fator))`) e a ABORTAR o pedido inteiro
(`erro_nao_retentavel`) se o fator for ≤ 0 ou não-finito. O guard morava só no WRITER da UI
(`MapeamentoFormDialog`/`useSkuMapeamento` rejeitam ≤ 0). SQL Editor, import e qualquer writer
novo entravam 0/negativo/NaN/Infinity sem barreira — e a TABELA tinha 0 CHECKs.

**Entrega.** Migration `20260904233000_sku_fornecedor_externo_fator_positivo.sql`:
`CHECK (fator_conversao > 0 AND fator_conversao < 'Infinity'::numeric)`, atômica (BEGIN/COMMIT),
idempotente (DROP IF EXISTS + ADD), com postcondição embutida que relê o catálogo
(`convalidated`) **e executa** o CHECK em subtransação: os 5 venenos (0/-1/NaN/Infinity/-Infinity)
têm de dar 23514 e um valor válido (0.5) tem de entrar — tudo desfeito, nenhuma linha muda.

**Por que os dois lados.** `CHECK (x > 0)` aceita NaN E Infinity; `CHECK (x > 0 AND x <> 'NaN')`
aceita Infinity (money-path.md). `x < 'Infinity'` é FALSE para os dois (NaN ordena acima de
Infinity em `numeric`), então o par `> 0 AND < 'Infinity'` fecha os três lados; NULL já é do
`NOT NULL` da coluna.

**Pré-flight PROD (psql-ro).** 309 linhas (não as 292 do briefing — cresceu no dia), 0 NULL,
0 ≤ 0, 0 NaN/Infinity: 306 × 1 e 3 × 0.2 (ids 131/139/252). Tabela pequena → ADD direto.
O de-para automático (`reposicao-depara-sayerlack-auto`) não escreve `fator_conversao`
(herda `DEFAULT 1`) — a constraint não o quebra.

**Prova.** `db/test-sku-fornecedor-externo-fator-positivo.sh` (PG17, 28 asserts, exit 0):
acervo válido sobrevive, válidos entram (INSERT e UPDATE), 5 venenos barrados em INSERT e 2 em
UPDATE (SQLSTATE 23514 casada, `WHEN OTHERS THEN RAISE`), re-run idempotente, dado sujo derruba o
apply e deixa o banco como estava (P8-P10). Falsificação: cópias sabotadas com `> 0`, com
`> 0 AND <> NaN` e sem o ADD fazem a postcondição gritar `A2`/`A2`/`A1 FALHOU` e o estado real
sobrevive à sabotagem (atomicidade medida); sem a constraint a sonda do harness fica VERMELHA
(dente do assert provado).

**Lição de harness (2 vermelhos falsos antes do verde).** `bool_and(...)::text` devolve `true`,
não `t`; e um `CASE WHEN bool_and(...)` sobre 0 linhas cai no `ELSE` — o `coalesce` do lado de
fora nunca vê NULL. Sonda de estado de catálogo: trate o "não existe" explicitamente
(`IS NULL THEN '-'`) antes de mapear t/f.
