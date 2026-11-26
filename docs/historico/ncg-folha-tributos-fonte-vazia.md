# NCG: folha e tributos 0 afirmados — fonte vazia (engine v2.6)

**Incidente (25/11/2026):** o 1º snapshot medido da `fin-cashflow-engine` v2.5 (10:00–10:10 UTC, 3 empresas × 3 cenários) gravou `ncg_folha_30d = 0` e `ncg_tributos_a_pagar = 0` em `fin_projecao_snapshots`. Não era NULL: era um zero afirmado. O card "Como a NCG se forma" (PR #4170) mostrou isso fielmente.

## Causa raiz (psql-ro, só contagens)

| Fonte que `calcularNCG` lê | Estado nas 3 empresas |
|---|---|
| tributos = CP aberto com `categoria_codigo LIKE '3.99%'` | **0 linhas** (o prefixo não existe no plano Omie do grupo) |
| folha = `fin_eventos_recorrentes` (`is_folha`) | **0 linhas** |
| folha = CP de `fin_config_cashflow.folha_categorias_codigos` na janela de 30 d | **config vazia** |

O plano real (`fin_categorias`, igual nas 3) tem **2.03 Despesas com Pessoal** e **2.06 Impostos e Taxas**, com títulos abertos: 2.06 nas 3 empresas e 2.03 sobretudo na colacor_sc, onde vive a folha do grupo. Esses títulos caíam em `cp_fornecedor`. O **total** da NCG estava certo; a **composição** é que estava errada, com o 0 nascendo de um filtro que nunca casa. É o `Number(null) === 0` em forma de filtro.

## O que a v2.6 faz (só medida)

`NCG.fontes = { folha, tributos }`: a parcela só é medida se a regra achar obrigação **aberta** (ou, na folha, um recorrente). Histórico pago não atesta a janela (achado Codex). Fonte vazia → `colunasComposicaoNcg` grava as **6** `ncg_*` NULL, porque o CHECK `fin_projecao_snapshots_ncg_composicao_coerencia_ck` não aceita só a parcela NULL. `ncg`, PCO, semanas, saldos e `saldo_tesouraria` ficam **idênticos** à v2.5. Efeito esperado em prod: a composição das 3 empresas passa a "não medida" até a fonte ser trocada.

## Desenho descartado: reclassificar por família 2.03/2.06

A v1 deste PR lia tributos de `2.06*` e folha de `2.03*`. O Codex reprovou (5 achados P1):

1. **Dupla contagem:** uma categoria configurada como folha e também em 2.06 entrava duas vezes no PCO.
2. **Histórico como atestado:** um único 2.03 pago "media" folha 0.
3. **Exceções nas famílias:** na colacor, 2.03.76 é distribuição de lucros. 2.06.94 é ICMS-ST de fornecedor e 2.06.98 é licença ambiental. ISS, IPTU e IPVA ficam em 2.04.
4. **Janela sem limite inferior:** folha vencida havia 120 d entrava em `folha_30d`, e o recorrente ignora a vigência (`fim`).
5. **A4:** `saldo_tesouraria` alimenta `financiar_ja` × `financiar_condicional`, e a resposta ao vivo segue com `folha_30d = 0` mesmo quando o snapshot diz "não medido".

## Pendência (decisão de método, não deste PR)

A fonte certa é o mapa curado por empresa e código `fin_categoria_fluxo_mapping`: `op_pessoal`, `op_impostos`, `op_impostos_lucro`, `op_impostos_parcelamento`. Antes de ligá-lo, é preciso decidir:

- se parcelamento e IRPJ/CSLL entram em "tributos a pagar";
- se a reserva de folha da tesouraria inclui atrasados;
- se INSS/IRRF retidos duplicam o salário bruto em CP aberto;
- se colacor e oben têm folha própria ou centralizada na colacor_sc.

Também está fora deste PR a resposta ao vivo, que ainda devolve `folha_30d = 0` quando a fonte está vazia (consumida por `NcgDecomposicao.tsx` e pela A4).
