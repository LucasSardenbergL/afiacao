# "Segurar compra" escreve no motor — suspensão de recompra por SKU (Oben, Frente C da leva PME/PMR)

2026-10-31/11-01 · Frente C de `docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md` · spec própria
`docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md` · migration `20261101090000_reposicao_compra_suspensa.sql`
(manual, lovable-db-operator) · prova `db/test-compra-suspensa-motor.sh` · envelope `db/aplicar-compra-suspensa-oben-180d.sql`.

## Por quê

A aba Ciclo (`fin_ciclo_giro_sku`) etiquetava `segurar_compra` (cobertura >180d) e **só lia**. Medido em prod 2026-10-31:
190 SKUs de giro com cobertura ≥180d = R$ 143.781, 125 deles no motor automático (R$ 108.777); 56 SKUs com cobertura
≥180d receberam compra nos 90 dias anteriores (R$ 56k). Decisão do founder: suspender a recompra já, com sensor no
mesmo PR e reativação em 1 clique.

## O que entrou

- **Registro próprio** `reposicao_compra_suspensa` (autor, motivo, origem, lote, data de REVISÃO, foto de saldo/cmc/
  cobertura 365d e 90d/no_motor/venda 90d). 1 writer = RPCs `reposicao_compra_suspender` / `reposicao_compra_reativar`
  (SECURITY DEFINER, gate `cap_compras_escrever` — master). Leitura: `_candidatos`, `_listar`, `_runs` (`cap_compras_ler`).
  Sessão direta sem JWT (SQL Editor / db:aplicar / cron) passa; PostgREST sem JWT (`session_user` authenticator) não.
- **Motor respeita** (`gerar_pedidos_sugeridos_ciclo`, fonte viva `db/embalagem-motor-rpc.sql`): CTE `suspensas_ativas`
  (`reativado_em IS NULL`); a linha cujo SKU FINAL (âncora ou galão escolhido) OU âncora do grupo está suspensa sai de
  `skus_inseriveis` e vai para `reposicao_compra_suspensa_log` com a MESMA `qtde_final` que iria ao pedido (pós-teto,
  pós-embalagem do portal); `reposicao_motor_run.suspensas_compra_n`.
- **App** (`/financeiro/capital-giro?aba=ciclo`, só Oben): coluna "Compra" na tabela de giro (Segurar / suspensa ·
  Reativar), diálogo com motivo + "revisar em" (30/60/90/180d), botão "Segurar compra de todos ≥180d" (coorte
  recalculada pelo banco), painel "Compras suspensas" (ativas, estoque hoje, último run, runs em 30d, lista ordenada
  por venda 90d com selo "risco de falta" quando cobertura 90d < 60d).
- **Candidatos ao lote** = classe giro, saldo>0, cobertura ≥N nas DUAS janelas (365d E 90d), sem corante
  (`Concentrados LC`, consumo dosado não registrado), sem substituído, sem já suspenso; fonte de consumo tem de estar
  fresca (≥330d de histórico, ≤7d de atraso) senão P0001 fail-closed. Medido: a dupla janela corta 30 SKUs/R$19k que
  aceleraram; coorte final 154 SKUs / R$ 121k (106 no motor, R$ 92k).

## Decisões (e por que não o caminho óbvio)

- **Não** `habilitado_reposicao_automatica=false` nem `tipo_reposicao='sob_encomenda'` (caminho do Raio-X
  `manter_suspender_recompra` e do Baixo Giro): são destrutivos e sem validade; religar é UPDATE PostgREST cru (lição
  2026-10-29: não consulta `sku_substituicao`, dispara o trigger de desconsolidação); SKU desligado com venda em 90d
  cai em `v_reposicao_sku_fora_do_motor` = 190 alertas vermelhos; e o motor não calcularia a sugestão → R$ evitado
  invisível. O `manter_suspender_recompra` do Raio-X continua existindo (semântica diferente: sob encomenda permanente).
- **Suspensão NÃO vence sozinha** (Codex desenho P1): `revisar_em` é data de revisão. Vencimento silencioso recompraria
  excesso: saldo 500/consumo 1 por dia/pp 600 → após 90d ainda 410d de cobertura e o motor sugeriria 490 un.
- **Compra evitada é R$ de SUGESTÃO suprimida por run, não caixa** (Codex P1-7): a mesma necessidade reaparece a cada
  run. O painel mostra o último run e o denominador (runs em 30d, quantos com supressão) e rotula a Σ como R$·run.
- **Grupo de embalagem** (Codex P1-5): segurar a âncora segura o grupo; segurar só o galão segura só quando o galão é o
  escolhido (provado em R7/R8 do harness). O log grava `ancora_sku` + `grupo_id`; `reativar` devolve `impedimento`
  (`ancora_suspensa` / `fora_do_motor` / `substituido`) para o clique não prometer o que não restaura.
- **Envelope compara CONJUNTOS** (Codex P1-11): a lista aprovada vai literal; quem saiu da coorte entre relatório e
  apply não é suspenso e é listado; quem entrou não é suspenso.
- **Sensor no banco, não em `analytics_ledger_registrar`**: a tabela + o log são o ledger com denominador, server-side;
  a allowlist do ledger é função compartilhada pelas 3 frentes paralelas hoje (1 writer por slug). `track()` só no clique.
- **ACL do log = padrão do teto** (SELECT+INSERT `cap_compras_ler`): quem completa o motor INVOKER já tem o cap;
  `WITH CHECK true` deixaria falsificar o audit. Limite aceito: staff com o cap pode inserir no log por fora (mesmo do
  teto). `GRANT SELECT` explícito na decisão — policy sem GRANT abortaria o "Recalcular" em 42501.

## Prova

`db/test-compra-suspensa-motor.sh`: 80 asserts em `LC_ALL=C` e `pt_BR.UTF-8`, RPCs sob `SET LOCAL ROLE authenticated`
+ `request.jwt.claims` (master / só-leitor / sem cap) e login real `authenticator` para o caminho sem JWT; motor
executado como authenticated. 4 falsificações com vermelho ESPECÍFICO (SKU suspenso DENTRO do pedido): filtro de
`skus_inseriveis` removido, ATIVA lida ao contrário, âncora ignorada no grupo com troca QT→GL, gate morto. Harnesses
irmãos do motor (teto, embalagem, gate, em-trânsito) re-rodados com a fixture nova; ganharam stubs de `anon`/
`service_role`/`auth.uid`/`private.cap_compras_ler` porque a cauda da fixture agora cria as tabelas da suspensão.

## Codex adversarial de CÓDIGO (gpt-6-astra high, 170 s, 115k tokens) — 2 P1 + 6 P2, todos absorvidos

- P1 "o alerta de falta some quando o estoque zera": `_reposicao_compra_foto` por lista passou a incluir SKU com saldo 0
  (cobertura 0 → risco visível) e sem linha de estoque (saldo NULL = desconhecido, nunca 0); prova R9.
- P1 "lote aplicado com coorte velha do cache": o diálogo só confirma com leitura FRESCA (`isSuccess && !isFetching && !isError`).
- P2: Σ de runs rotulada parcial quando há linha sem preço em qualquer run; erro de leitura vira "—" (não 0 /
  "Nenhuma" / "Segurar compra"); `reativar([âncora, galão])` não devolve `ancora_suspensa` da âncora da própria chamada
  (snapshot do CTE); `pendentes_n` conta os membros do grupo (pedido pode estar no galão); diálogo não fecha durante a
  mutação e zera motivo ao trocar de alvo; receita de rollback do envelope com sintaxe válida.
- Sem bypass do gate pelo PostgREST (`session_user` = authenticator); `ON CONFLICT` casa o índice parcial; custo da foto
  não multiplica por SKU (`dem` materializada uma vez).

## Lições

- **A cauda da fixture do motor é a ÚNICA fonte das provas irmãs**: trocar a cauda sem repetir o que as caudas
  anteriores criavam (`pedido_compra_item.estoque_comprometido`, `GRANT SELECT (omie_reconciliado_em)`) quebrou 4
  harnesses no INSERT do item. A cauda nova tem de acumular o que o motor exige, não só o que ESTA entrega acrescenta.
- **PÓS na cauda não pode checar o que uma prova irmã sabota**: o harness do gate remove o INSERT do marker e recarrega
  a fixture; uma PÓS que exigia `suspensas_compra_n` no corpo derrubava a sabotagem (rc=3). PÓS da cauda = invariantes
  que nenhuma falsificação legítima toca.
- Em harness, `auth.uid()` que lê `request.jwt.claims` tem de fazer `::uuid` no texto do sub — "return type mismatch"
  no CREATE aborta a ZONA inteira em silêncio se o bloco roda com `-q`.

## Pendências (fora deste PR)

- Apply em massa: relatório (`db/relatorio-compra-suspensa-oben.sql`) → OK do founder no chat → envelope → 2ª testemunha.
- Guardrail fill-rate: sensor de ruptura é da Frente A; até existir, a lista por venda 90d + "risco de falta" é o
  sinal provisório (não é fill-rate).
- Compra manual fora do motor (portal Sayerlack digitado/importado) não vê a suspensão; medir vazamento confrontando
  `cmc_ledger`/recebimentos no intervalo suspenso é entrega própria.

## Apply em prod (2026-11-01, founder: "Aprovo os 156")

- Migration `20261101090000` aplicada por `bun run db:aplicar` (recibo #823, commit `c0be33dc1`); 2ª testemunha psql-ro: 8 corpos
  com md5 igual ao arquivo, ACL/RLS/índice como desenhados. Pré-voo: motor vivo byte-idêntico à `20261010210000`.
- Relatório da coorte (`db/relatorio-compra-suspensa-oben.sql`, `--ensaio`): **156 SKUs / R$ 122.201**, 107 no motor
  (R$ 92.676), 73 sem venda 90d, 68 Sayerlack, 84 com cobertura >2 anos. Envelope `db/aplicar-compra-suspensa-oben-180d.sql`
  com os 156 literais: ensaio 156=156 (ninguém saiu/entrou), apply recibo #830, **lote `bc8635a1-a355-4553-b31b-c3f8147de404`**,
  `revisar_em 2027-01-30`, `suspenso_por_texto envelope:claude_rw:2026-11-01`.
- **Lição**: as RPCs têm EXECUTE só para `authenticated`/`service_role` → nem `psql-ro` nem `psql-rw` cru as chamam (42501); o
  caminho é o executor (`aplicar_sql`, dono `postgres`), cujo `EXECUTE` descarta SELECT → relatório por `DO` + `RAISE NOTICE`,
  envelope SEM `BEGIN;/COMMIT;`.
- **Próximo sinal (query, não recado)**: 1º run do motor após o apply deve mostrar `suspensas_compra_n` > 0 em
  `reposicao_motor_run` e linhas em `reposicao_compra_suspensa_log` com `run_id` desse run; se ficar 0 com pedidos gerados
  para SKUs do lote, a suspensão não está sendo lida. Rollback = `reposicao_compra_reativar('OBEN', <skus do lote>, motivo)`.

## Prova viva (2026-11-01, psql-ro, 2 runs do motor depois do apply)

| run (SP) | `pedidos_gerados` | `skus_incluidos` | `suspensas_compra_n` | log |
|---|---|---|---|---|
| 2026-10-31 17:16 (antes do apply) | 2 | 11 | 0 | — |
| 2026-11-01 06:15 | 2 | 10 | **1** | 8689787819 VERNIZ PU FOSCO FO5.6748.00GL · Sayerlack · 1 un · R$ 154 evitado |
| 2026-11-01 07:15 | 2 | 10 | **1** | idem |

- O motor LEU a suspensão: o SKU segurado é do lote `bc8635a1` (`suspensa_id` bate), saiu do pedido (11 → 10 SKUs) e foi
  logado com preço e valor evitado. Dos 10 itens dos 2 pedidos Oben de hoje (`pedido_compra_item`), **0 pertencem ao lote**.
- Denominador honesto: 1 de 156 suspensos estava elegível neste ciclo; os outros 155 não teriam sido pedidos de qualquer jeito
  hoje (cobertura ≥180d). O valor evitado acumula só quando o motor TENTA — R$ 309 em 2 runs é o sinal, não a economia.
- Query da prova (repetir a cada leva): `SELECT run_id, criado_em, pedidos_gerados, skus_incluidos, suspensas_compra_n FROM
  reposicao_motor_run WHERE empresa='OBEN' ORDER BY criado_em DESC LIMIT 3;` + `SELECT count(*) FROM pedido_compra_item i JOIN
  pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.empresa='OBEN' AND p.data_ciclo=current_date AND i.sku_codigo_omie::text IN
  (SELECT sku_codigo_omie::text FROM reposicao_compra_suspensa WHERE reativado_em IS NULL)` — tem de ser 0.
