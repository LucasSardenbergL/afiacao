# "Segurar compra" escreve no motor — suspensão de recompra por SKU (Oben) — spec

> Frente C da leva Oben PME/PMR (`2026-10-31-oben-pme-pmr-plano-design.md` §4). **Money-path**: mexe em
> `gerar_pedidos_sugeridos_ciclo` (RPC quente, fonte viva `db/embalagem-motor-rpc.sql`). Decisão do founder
> 2026-10-31: suspender a recompra JÁ em todos os SKUs de giro com cobertura ≥180d, com sensor no mesmo PR e
> reativação em 1 clique.

## 1. Problema (medido em prod, 2026-10-31, psql-ro)

- A aba Ciclo (`fin_ciclo_giro_sku`) etiqueta `segurar_compra` (cobertura >180d) e **só lê**. Nada escreve no motor.
- Coorte hoje: **190 SKUs** de giro com cobertura ≥180d = **R$ 143.781** em estoque. **125** estão no motor
  automático (R$ 108.777); 6 são `Concentrados LC`; 167 venderam algo em 90d (giram, mas devagar demais p/ o saldo).
- Vazamento: entrada de compra em 90d em 56 SKUs com cobertura ≥180d (R$ 56k) — o motor e o comprador seguem
  repondo o que já tem meio ano de estoque.
- `sku_parametros` OBEN: 606 linhas, 389 habilitadas, 144 habilitadas sem `cobertura_alvo_dias`.

## 2. Decisão de desenho

**Suspensão é um REGISTRO próprio, não um flag em `sku_parametros`.** O motor passa a consultar a tabela
`reposicao_compra_suspensa` e **exclui a linha do pedido** quando o SKU final (âncora ou galão escolhido) OU a
âncora do grupo tem suspensão ATIVA, **logando a compra evitada** (qtde × preço) em `reposicao_compra_suspensa_log`.

Por que não `habilitado_reposicao_automatica=false` / `tipo_reposicao='sob_encomenda'` (o caminho do Raio-X
`manter_suspender_recompra` e do Baixo Giro):
1. esses flags são **destrutivos e sem validade** — `motor_antes` jsonb é o único rastro; religar passa por UPDATE
   PostgREST cru que nem consulta `sku_substituicao` (lição 2026-10-29) e dispara o trigger de desconsolidação;
2. SKU desligado com venda em 90d cai em `v_reposicao_sku_fora_do_motor` = **alerta vermelho** em Gerir pedidos —
   190 SKUs virariam ruído e esconderiam o caso real (flag desligado sem dono);
3. o sensor "compra evitada" precisa que o motor **calcule** a sugestão e depois a segure — com o flag desligado o
   SKU nem entra em `sku_base` e o R$ evitado é invisível.

**Ativa** ⇔ `reativado_em IS NULL`. **Não vence sozinha** (pós-Codex, P1-1/P1-3): `revisar_em` é data de REVISÃO
(default hoje+90, aparece na tela e marca "revisão vencida"), nunca de liberação — vencimento silencioso recompraria
excesso (saldo 500, consumo 1/dia, pp 600: após 90d ainda 410d de cobertura e o motor sugeriria 490 un). Reativar é 1
clique; o episódio reativado fica na tabela (histórico), e um novo `suspender` abre episódio novo (índice único parcial).

## 3. Objetos (migration `20261101090000_reposicao_compra_suspensa.sql`, apply via `lovable-db-operator`)

> Estado FINAL pós-Codex de desenho (parecer 2026-10-31, 11 P1 — absorvidos abaixo e no `docs/historico/compra-suspensa-segurar-compra-no-motor.md`). Onde §3–§6 abaixo divergirem do texto original, vale: `revisar_em` (sem `valido_ate`); candidatos com DUPLA janela (365d E 90d ≥ N) e corante fora por padrão; log com `ancora_sku`+`grupo_id`; `suspender` devolve `recusa`/`pendentes_n` e `reativar` devolve `impedimento`; `_listar` traz situação AO VIVO; `_runs` é o denominador; envelope compara CONJUNTOS (lista aprovada literal).

### 3.1 `reposicao_compra_suspensa` (1 writer: as RPCs abaixo; RLS SELECT `cap_compras_ler`, sem policy de escrita)
`id uuid PK · empresa text ('OBEN') · sku_codigo_omie bigint · motivo text NOT NULL · origem text
('ciclo_ui'|'lote_cobertura'|'envelope') · suspenso_por uuid · suspenso_por_texto text (envelope: 'envelope:2026-11-01')
· suspenso_em timestamptz · valido_ate timestamptz NOT NULL · reativado_em · reativado_por · motivo_reativacao ·
foto_saldo · foto_cmc · foto_valor (NULL sem custo) · foto_cobertura_dias (NULL sem consumo) · foto_no_motor bool ·
foto_valor_vendido_90d · criado_em`. UNIQUE parcial `(empresa, sku_codigo_omie) WHERE reativado_em IS NULL`.

### 3.2 `reposicao_compra_suspensa_log` (escrito pelo motor; RLS `cap_compras_ler` em SELECT **e** INSERT, padrão do teto)
`run_id · empresa · sku_codigo_omie · sku_descricao · fornecedor_nome · suspensa_id · qtde_final · preco_unitario ·
valor_evitado (NULL se preço NULL — ausente ≠ zero) · criado_em`. `reposicao_motor_run.suspensas_compra_n` (ADD COLUMN).

### 3.3 Funções
- `_reposicao_compra_foto(p_empresa, p_skus bigint[])` — STABLE, interna: saldo/cmc (`inventory_position`, account
  `_fin_estoque_account`), cobertura 365d por `v_sku_demanda_efetiva` (uma avaliação da view, não por linha),
  no_motor, `valor_vendido_90d`. Mesmas regras de `fin_ciclo_giro_sku` (classe giro, substituído excluído).
- `reposicao_compra_suspensa_candidatos(p_empresa, p_min_dias int DEFAULT 180)` — STABLE, SECURITY DEFINER, gate
  `cap_compras_ler`: todos os SKUs de giro com saldo>0 e `dias ≥ p_min_dias`, excluindo substituídos e já suspensos;
  é a fonte do botão "Segurar todos ≥180d", do relatório prévio e do envelope.
- `reposicao_compra_suspender(p_empresa, p_skus bigint[], p_motivo, p_dias_validade int DEFAULT 90, p_origem text
  DEFAULT 'ciclo_ui')` — SECURITY DEFINER, gate `cap_compras_escrever`; insere com foto; `ON CONFLICT DO NOTHING`
  no índice parcial (idempotente); retorna `(sku, inserido bool)`. Rejeita array vazio, `p_dias_validade` ∉ [1,365],
  motivo em branco (P0001).
- `reposicao_compra_reativar(p_empresa, p_skus bigint[], p_motivo)` — SECURITY DEFINER, gate `cap_compras_escrever`;
  `UPDATE … SET reativado_em = now(), reativado_por, motivo_reativacao WHERE ativa`; retorna `(sku, reativado bool)`.
- `gerar_pedidos_sugeridos_ciclo` — CTE `suspensas_ativas` lida uma vez; `skus_inseriveis` ganha
  `AND NOT sn.compra_suspensa`; CTE `log_suspensa_ins` grava a linha que SERIA comprada. Pré-flight
  `pg_get_functiondef` da prod = `db/embalagem-motor-rpc.sql` (paridade CI). O motor é INVOKER → `GRANT SELECT` da
  tabela ao `authenticated` já vem da policy; INSERT no log pela policy `cap_compras_ler` (igual ao teto).
- REVOKE PUBLIC+anon em todas; GRANT authenticated (+service_role nas de leitura). Helper interno sem GRANT.

## 4. Apply em massa (envelope, só com OK do founder no chat após relatório)

`db/aplicar-compra-suspensa-oben-180d.sql`: `SELECT reposicao_compra_suspender('OBEN', array_agg(sku), 'cobertura
≥180d em 2026-11-01 (leva PME)', 90, 'envelope')` sobre `reposicao_compra_suspensa_candidatos('OBEN', 180)`,
idempotente (índice parcial), postcondição: `count(ativas) ≥ count(candidatos antes)` e zero candidato restante.
Pré-voo psql-ro: a query da coorte (§1). 2ª testemunha: psql-ro depois do commit. Relatório prévio = a lista dos
candidatos com R$, cobertura, no_motor, `valor_vendido_90d` (para o founder reativar rápido os críticos).

## 5. App (`/financeiro/capital-giro?aba=ciclo`, só Oben)

- Coluna "Compra" na tabela de giro: `Suspensa até dd/mm` + **Reativar** (1 clique, motivo opcional) ou
  **Segurar compra** (dialog: motivo + validade 30/60/90/180d).
- Botão no cabeçalho: "Segurar compra de todos ≥180d (N · R$)" → confirma → `reposicao_compra_suspender` com os
  candidatos.
- Painel "Compras suspensas": N ativas · R$ em estoque na foto · **compras evitadas** (Σ `valor_evitado` do log, com
  denominador: nº de runs do motor no período e linhas sem preço) · lista ordenada por `foto_valor_vendido_90d DESC`
  (fallback do guardrail enquanto o sensor de ruptura da Frente A não existe) com Reativar.
- `fin_ciclo_giro_sku` fica intocada (mudar RETURNS exige DROP → reset de ACL); a tela cruza por SKU com a leitura
  da tabela (`.range()` paginado).
- Sensor: a tabela + o log SÃO o ledger com denominador (server-side, imune ao bloqueador). `track()` só para o
  clique. **Não** toca `analytics_ledger_registrar` (função compartilhada pelas 3 frentes hoje; 1 writer por slug).
- Estoque de giro semanal: Frente A (série dos snapshots) — não duplicar writer.

## 6. Prova

- PG17 `db/test-compra-suspensa-motor.sh` (molde do teto): (1) SKU no ponto, sem suspensão → compra (controle);
  (2) com suspensão ativa → fora do pedido + 1 linha no log com `valor_evitado = qtde×preço`; (3) suspensão
  **expirada** → compra de novo, sem log; (4) **reativada** → compra; (5) grupo de embalagem: suspensão na âncora
  segura a linha do grupo; (6) `valor_evitado` NULL quando preço NULL; (7) RPC `suspender` idempotente (2ª chamada
  `inserido=false`) e gate 42501 sem cap; (8) `reativar` só ativa. Falsificações: remover o `NOT compra_suspensa` →
  2 e 5 vermelhos; remover o filtro `valido_ate > now()` → 3 vermelho; sabotar o gate → 7 vermelho. `LC_ALL=C` e
  `pt_BR.UTF-8`.
- vitest dos helpers puros (totais com NULL → "—", ordenação por venda 90d).
- Paridade `embalagem-motor-paridade.test.ts` (migration ⇄ `db/embalagem-motor-rpc.sql`).

## 7. Fora de escopo (decidido)

Liquidação (PR 2, Raio-X inequívoco) · `cobertura_alvo_dias` por SKU (teto por SKU no motor é outra análise) ·
mexer no `manter_suspender_recompra` do Raio-X (continua existindo; é "sob encomenda" permanente, outra semântica) ·
alongar PMP · tetos universais.
