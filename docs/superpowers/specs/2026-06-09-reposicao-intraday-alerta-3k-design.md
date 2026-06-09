# Reposição intra-day + alerta R$3k Sayerlack + gate de mínimo de faturamento — design

> 2026-06-09. Pedido do founder: (1) e-mail toda vez que um pedido sugerido der R$3.000+ no cockpit
> — **R$3.000 é o mínimo de faturamento da Sayerlack**; pode acontecer várias vezes ao dia, com
> pedidos diferentes; (2) motor de sugestões rodando com maior frequência ao longo do dia, pra
> reduzir lead time (pedido que sairia amanhã sai hoje); (3) reduzir o período de estoque ("dente
> de serra") em compras. Decisões do founder (AskUserQuestion): gatilho **por pedido** ≥ R$3k;
> cadência **a cada 2h em horário comercial**; **GATE no disparo** barrando pedido Sayerlack
> < R$3k (que a Sayerlack não fatura).

## Contexto descoberto (o que muda o desenho)

- O estoque que o **motor lê** (`sku_estoque_atual.estoque_fisico/estoque_pendente_entrada`, edge
  `omie-sync-estoque`) sincroniza **3×/dia** (9, 14, 19 UTC). O `inventory_position` (cmc) já
  sincroniza a cada 30min. O **motor** (`gerar_pedidos_sugeridos_ciclo` via edge
  `gerar-pedidos-diario`) roda **1×/dia** (9h15 UTC). O gargalo é o motor, não a consulta ao Omie.
- A **limpeza** da RPC vigente (`20260606190000`) é `DELETE ... WHERE empresa AND data_ciclo=hoje
  AND status='pendente_aprovacao'` — **tipo_ciclo-blind** (apagaria oportunidades pendentes das
  11h05 UTC), não toca `bloqueado_guardrail`, sem advisory lock.
- O **corte** (`disparar-pedidos-aprovados`, 13h UTC) expira pendentes com `.eq('data_ciclo',
  hoje)` — rodadas pós-corte criariam **zumbis** (pendentes de data_ciclo antigo que nada expira e
  o cockpit, que filtra hoje, não mostra).
- Aprovação manual **já dispara na hora** (#638). `runAutoApprove` é client-side (só ao abrir o
  painel). O `ciclo_oportunidade_do_dia` (11h05 UTC) tem limpeza própria **tipo-aware** (apaga só
  os pendentes `oportunidade_%` do dia) — falta a simetria no motor normal.
- O split Sayerlack (`dividirPedidosGrandesSayerlack`, >4 itens) roda **dentro do disparo**, marca
  filhos com `split_parent_id`. Um pai ≥R$3k pode virar filhos <R$3k cada — o mínimo de
  faturamento vale pro **valor aprovado**, não pro filho.
- Infra de e-mail: `fornecedor_alerta` (CHECK de tipo vigente na `20260605120000`, 11 valores) →
  `dispatch-notifications` cron `*/30`. Padrão anti-spam de transição: UNIQUE parcial
  `WHERE dismissed/resolvido IS NULL` + `ON CONFLICT DO NOTHING` + `IF FOUND → enfileira`.
- ⚠️ Codex em usage-limit até 11/06 → **caminho B** (acordado em precedente): passe adversarial
  próprio + validação PG17 exaustiva; Codex retroativo quando voltar.

## PR1 — Alerta "pedido Sayerlack atingiu R$3k" (SQL puro)

Migration `20260609150000_reposicao_alerta_pedido_minimo.sql`:

1. **CHECK** de `fornecedor_alerta.tipo` estendido (lista vigente + `reposicao_pedido_minimo`).
2. **Config** em `company_config`: `reposicao_alerta_pedido_valor_minimo` = `'3000'`,
   `reposicao_alerta_pedido_fornecedor_ilike` = `'%SAYERLACK%'` (a régua é UMA — alerta e gate
   leem as mesmas keys).
3. **Tabela de estado** `reposicao_alerta_pedido_minimo` (empresa, fornecedor_nome,
   `grupo_codigo text NOT NULL DEFAULT ''` — NULL e '' são a MESMA identidade, senão o UNIQUE
   parcial com NULL deixa duplicar; pedido_id informativo — o id morre na regeneração;
   valor_alertado/valor_ultimo; alertado_em/resolvido_em). UNIQUE parcial
   `(empresa, fornecedor_nome, grupo_codigo) WHERE resolvido_em IS NULL`. RLS: SELECT staff;
   escrita só definer/service_role.
4. **Tick** `reposicao_alerta_pedido_minimo_tick()` (SECURITY DEFINER, REVOKE de
   anon/authenticated/PUBLIC, GRANT service_role — a edge de geração chama via `.rpc`):
   - Config ausente/inválida → RETURN (alerta desligado; é régua comercial, não segurança).
   - **Novos**: pendente_aprovacao com `fornecedor_nome ILIKE pattern` e `valor_total ≥ régua`,
     agrupado por (empresa, fornecedor, COALESCE(grupo,'')) → INSERT estado `ON CONFLICT ... DO
     NOTHING`; `IF FOUND` → enfileira `fornecedor_alerta` (1 e-mail por transição). Alerta já
     ativo → só atualiza `valor_ultimo` (3.2k→10k não re-spamma; o valor vivo está no cockpit).
   - **Resolve**: ativo sem pendente ≥ régua correspondente → `resolvido_em=now()` (re-arma: o
     próximo pedido do grupo que cruzar R$3k gera e-mail novo — "aprovei → quando acumular de
     novo, me avisa").
   - E-mail: título `[Compras] Pedido SAYERLACK atingiu R$ X — pronto pra aprovar`; corpo com
     grupo, nº SKUs e link **genérico** pra `/admin/reposicao/pedidos` (deep-link `?id=` morreria
     na regeneração seguinte).
5. **Cron** `reposicao-alerta-pedido-minimo` `*/30 * * * *` (SQL local, sem `net.http_post` —
   sem armadilha de timeout). Latência pior-caso ~60min (tick + dispatch); com o hook do PR2 na
   edge, cai pra ≤30min (só o dispatch).

Por que por-pedido e não saldo total: R$3k é mínimo de **faturamento por pedido** na Sayerlack —
o founder aprova pedido a pedido, e o pedido sugerido (fornecedor+grupo) é a unidade que vira PO.

## PR2 — Ciclo intra-day + gate de disparo

### Migration `20260609160000_reposicao_ciclo_intraday.sql`

RPC `gerar_pedidos_sugeridos_ciclo` = corpo **VERBATIM** da `20260606190000` + 4 marcas
`[INTRADAY]` (pré-requisitos de segurança pra regeneração 6×/dia):

1. **Advisory lock** `pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:'||
   lower(p_empresa)))` — serializa cron × botão manual × retry (a RPC não tinha proteção; com
   1×/dia nunca colidia).
2. **Expira zumbis**: `UPDATE → expirado_sem_aprovacao` de pendentes **normais** com
   `data_ciclo < p_data_ciclo` (rodadas pós-corte criam pendentes que o corte `.eq` nunca expira;
   dentro da RPC cobre cron E botão manual). Oportunidade fica fora (território do
   `ciclo_oportunidade_do_dia`); `bloqueado_guardrail` antigo fica (status quo, chip de atenção).
3. **Limpeza do dia tipo-aware + bloqueados**: `DELETE ... status IN ('pendente_aprovacao',
   'bloqueado_guardrail') AND COALESCE(tipo_ciclo,'normal')='normal'`.
   (a) tipo-aware: sem isso, toda rodada pós-11h05 apagaria as oportunidades pendentes do dia —
   com motor 1×/dia às 9h15 isso nunca se manifestou (roda ANTES delas).
   (b) bloqueados do dia entram: sem isso, a rodada seguinte re-sugere os MESMOS SKUs num pedido
   pendente novo ao lado do bloqueado (em_transito não conta bloqueado) → aprovar os dois =
   **compra dupla**. O `aplicar_promocoes_no_ciclo` da mesma rodada re-bloqueia se a condição
   persistir; se ele falhar (best-effort), não há promoção aplicada → não há infla → o guardrail
   não seria necessário naquela rodada (consistente).
4. **NOT EXISTS anti-oportunidade** no `skus_necessitando`: não re-sugerir SKU presente em pedido
   pendente/bloqueado de `tipo_ciclo <> 'normal'` — anti compra dupla na janela 11h05→13h UTC; se
   a oportunidade for rejeitada/expirar, a rodada seguinte (≤2h) re-sugere no ciclo normal.

Crons:
- `gerar-pedidos-intraday-oben` `15 10,12,14,16,18,20 * * *` (7h–17h BRT, 6 rodadas), body
  `{"empresa":"OBEN","intraday":true}`.
- `omie-sync-estoque-intraday-oben` `40 9,11,13,15,17,19 * * *` (estoque fresco ~35min antes de
  cada rodada).
- `omie-sync-estoque-diario` reagendado `0 9,14,19` → `0 9 * * *` (o 14/19 vira redundante com o
  intraday; o 9h serve a rodada matinal das 9h15 que continua intacta, com digest).

### Edge `gerar-pedidos-diario` (deploy manual via Lovable)

- `body.intraday === true` → **suprime o digest** de e-mail (senão 6 digests/dia matariam o valor
  do alerta R$3k); rodada matinal continua com digest. `metadata.intraday` no log.
- **Hook do tick** (best-effort, try/catch): `db.rpc('reposicao_alerta_pedido_minimo_tick')` após
  a RPC+promoções — derruba a latência do alerta pra "próximo dispatch".

### Edge `disparar-pedidos-aprovados` — GATE de mínimo de faturamento (deploy manual)

Helper puro TDD `src/lib/reposicao/disparo-gate-helpers.ts` (`deveBloquearPorMinimoFaturamento`),
espelhado **verbatim** no Deno. Roda **ANTES do split** (sobre os pedidos aprovados originais),
barrando com `falha_envio` + motivo claro (padrão do guard de custo/qtde #422/#433; o erro fica
em `resposta_canal.erro`). Isenções (a ordem importa):

1. Config ausente/inválida → gate desligado (fail-open deliberado: régua comercial).
2. `split_parent_id` preenchido → **isento** (filho herda a aprovação do pai que passou no gate;
   um pai de R$10k vira filhos de ~R$2k — barrá-los re-quebra o split; e o gate pré-split também
   evita o furo de pedido <R$3k com >4 itens escapar via filhos).
3. Fornecedor não casa o pattern → isento.
4. **Já tocou o fornecedor** (`portal_protocolo` não-nulo OU `status_envio_portal` ∈
   {sucesso_portal, enviado_portal, aceito_portal_sem_protocolo, indeterminado_requer_conciliacao})
   → isento — barrar agora criaria órfão pior (PO no portal sem Omie); o fluxo de
   reconciliação/idempotência segue.
5. `valor_total ≥ régua` → passa. Senão → **barra**: "abaixo do mínimo de faturamento Sayerlack
   (R$3.000) — aguarde o ciclo acumular mais itens ou cancele o pedido".

Cobre TODOS os caminhos de disparo (cron de corte, aprovar-e-disparar manual, re-disparo
individual, motor de retry) — todos passam pela edge. Escape hatch v1: ajustar a config.

## Validação (PG17 local, padrão `db/test-*.sh`)

- `db/test-alerta-pedido-minimo.sh`: transição (1 e-mail), anti-spam (tick 2× sem novo e-mail),
  valor cresce sem re-spam (valor_ultimo atualiza), aprovação resolve, re-arma com pedido novo,
  fornecedor fora do pattern não alerta, < régua não alerta, config inválida não explode,
  grupo NULL × '' não duplica.
- `db/test-rpc-intraday.sh` (base: harness do `test-rpc-account-aware.sh`): re-rodada preserva
  oportunidade pendente; apaga e regenera bloqueado normal do dia; expira pendente normal de
  ontem; NOT EXISTS exclui SKU de oportunidade; aprovado/disparado intactos; comportamento base
  (gera pro SKU abaixo do ponto) inalterado.
- Gate: vitest no helper puro (split filho, portal-tocado, pattern, régua, config ausente).

## Dente de serra (análise — fase 2 NÃO construída agora)

Estoque médio = lote/2 (ciclo) + estoque de segurança. O pacote ataca:
- **Adiantar o disparo** ~0,5–1 dia (venda da manhã vira pedido à tarde) → lead time efetivo ↓.
- **Lote ótimo Sayerlack**: com custo de transação ~zero (motor → 1 clique → portal → Omie), o
  lote ideal é o MENOR que o fornecedor fatura = R$3k. Alerta (pede assim que dá) + gate (nunca
  pede o que não fatura) = o menor dente possível dado o mínimo de faturamento.
- **Fase 2 (gated em 2–4 semanas de medição)**: recalibrar `ponto_pedido`/`estoque_seguranca`/
  `cobertura_alvo_dias` com período de revisão 24h→2h, via esteira `param_auto` existente
  (fusível/pin/log). Recalibrar sem medir = risco de ruptura. Custos honestos do dente menor:
  mais recebimentos físicos (conferência), pisos de frete/faturamento de outros fornecedores.

## Não-objetivos (v1)

- Mexer no fluxo do `ciclo_oportunidade_do_dia` (incl. o fato de o corte das 13h UTC expirar
  oportunidades ~2h após nascerem — comportamento pré-existente, fora do escopo).
- Preservar ajustes manuais em pendentes através da regeneração (preservar criaria double-count
  de SKU: em_transito não conta pendente → o SKU preservado renasceria no pedido novo). Regra
  operacional: ajustou → aprova (dispara na hora). Trade-off aceito pelo founder no design.
- Gate por valor agregado do dia (a régua é por PO; o split prova que a Sayerlack agrupa).
- Mínimo de faturamento por fornecedor além da Sayerlack (config single-pattern v1; extensível).
- Recalibração de parâmetros (fase 2, gated em medição).

## Riscos aceitos / registrados

- Race aprovar-durante-regeneração: janela pequena; aprovação falha limpa (0 rows) — nada
  dispara errado. UX de erro do front já existe.
- Deep-link `?id=` de qualquer e-mail antigo pode morrer na regeneração (link genérico no novo
  alerta; o digest matinal já era assim).
- Oscilação do valor em torno da régua (2.9k↔3.1k) re-armaria o alerta — raro (valor cresce
  monotonicamente com vendas; cai com recebimento/aprovação), aceito.
- `omie-sync-estoque` 3→7×/dia e motor 1→7×/dia: carga Omie marginal (sync de pedidos já é 12×,
  inventory 48×/dia); edges idempotentes.
- Pendência pós-merge (founder): colar 2 migrations no SQL Editor + deploy de 2 edges via chat
  do Lovable + Publish não necessário (sem mudança de frontend).
