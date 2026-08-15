# Watchdog de saúde de dados envelhece MUDO — diagnóstico e desenho

> 2026-08-14 · money-path · diagnóstico fechado com evidência de prod (psql-ro) + Codex challenge xhigh.
> **Estado: desenho REPROVADO na forma simples; correção não aplicada.** Esta spec é o ponto de partida
> da sessão que for implementar. Nada foi mergeado além do cancelamento do pedido 1276.

## O gatilho

`pedido_compra_sugerido.id = 1276` (OBEN · RENNER SAYERLACK · R$ 8.237,08 · 5 SKUs) ficou **22 dias**
em `aprovado_aguardando_disparo` sem ninguém saber. Detectado no ritual `/fecho` de 2026-08-14.

## Veredito: o pedido está CERTO; o canal de alerta é que travou

### 1. O pedido 1276 é bloqueio LEGÍTIMO e terminal — não dispare

- `status_envio_portal='erro_nao_retentavel'`, 2 tentativas, erro do portal:
  `Grupo errado (Prz Ent != lead time do grupo): linha 5 (Prz 5 != 8)`.
- Causa: o SKU `8689776765` (DILUENTE PU DF.4056LT) é `sayerlack_rapido` (LT 5) e ficou **congelado**
  dentro de um pedido `sayerlack_normal` (LT 8). É a armadilha já documentada no fim de
  `docs/agent/reposicao.md` — e o "#1276" daquele parágrafo é **este pedido (id)**, não um PR.
  ⚠️ Todos os outros `#NNNN` do doc são PRs; este não. Ambiguidade que já custou releitura.
- A fonte JÁ foi corrigida (24/07): hoje os outros 4 SKUs estão em `sayerlack_normal` e esse em
  `sayerlack_rapido`. Ciclos novos não repetem o erro.
- **A mercadoria já foi comprada por outros pedidos**: os 5 SKUs voltaram no ciclo de 30/07
  (`disparado`), mais 05/08 e 10/08. **Disparar o 1276 hoje = compra dupla de R$ 8,2k.**
  O botão "Re-disparar" naquele card é a armadilha real.
- Por que o cron nunca o pegou (desenho explícito, não bug): o modo lote filtra
  `.eq("data_ciclo", hoje)` (`disparar-pedidos-aprovados/index.ts:1531`) e o backlog exige
  `aprovado_por LIKE 'auto:sayerlack%'` + `aprovado_em >= now-72h` + `status_envio_portal='nao_aplicavel'`
  (`:1543`). Este pedido falha nos **três** (aprovado por humano, 22 dias, tocou o portal).
- Supressão de compra: durou 7 dias (23→30/07), já fechada pelo #1636. A migration `20260802120000`
  está **aplicada em prod** e cobre exatamente este pedido (protocolo NULL, nº Omie NULL) — conferido.

**Ação:** `SELECT public.cancelar_pedido_sugerido(1276, '<email>', '<justificativa>');`
A RPC aceita `aprovado_aguardando_disparo` e reseta `status_envio_portal='nao_aplicavel'` — o que
destrava os DOIS canais de alerta de uma vez.

### 2. O travamento real: o watchdog detecta certo e nunca escala

O vigia existe e está correto — `reposicao_disparo` em `_data_health_compute()`:
`>48h = stale`, `>168h = broken`. Rodado em 2026-08-14: **`broken`, 537h, 1 pedido**.

Mas o registro em `fin_alertas` está **congelado desde 25/07**: `contexto->>'status'='stale'`,
`age_seconds=176400` (49h), severidade `aviso`, `dismissed_at IS NULL`. E `fornecedor_alerta`
(a fila que vira e-mail) tem **1 único e-mail** desse source, de 25/07. Nunca mais.

Causa em `data_health_watchdog()` (cron `*/30`):

```sql
INSERT INTO fin_alertas (...) VALUES (...)
ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
IF FOUND THEN   -- só aqui nasce o e-mail
  INSERT INTO fornecedor_alerta (...) VALUES (..., 'pendente_notificacao');
END IF;
```

Havendo alerta aberto: nada é atualizado e **nenhum e-mail sai**. O primeiro aviso é o único aviso.
A escalada `stale → broken` não re-emite. Agravante: o check `reposicao_disparo` tem `severity`
**literal `'warning'`** — não vira `critical` nem em `broken`.

**É a 3ª mordida do mesmo mecanismo.** O repo já o conhece: o check `pedidos_compra_sync` traz o
comentário *"severity FIXO 'critical' (money-path): evita o furo do ON CONFLICT do watchdog
(escalonamento de severidade no mesmo source não re-emailaria)"*. E o incidente 30/06–02/07 passou
mudo pelo mesmo motivo. As duas lições anteriores corrigiram a **fonte** de um check; o **mecanismo**
seguiu intacto.

### 3. Dano prospectivo: o alerta preso ENTUPE o canal

A chave é `(company, tipo)`. Enquanto um alerta estiver preso aberto, **qualquer novo incidente do
mesmo source fica mudo**. Um pedido de R$ 50k travado amanhã não geraria e-mail. Em 2026-08-14 havia
3 presos, todos `aviso`, todos com `status` congelado em `stale`, todos sem e-mail desde a criação:

| tipo | dias aberto |
|---|---|
| `vendas_familia_ausente` | 31 |
| `reposicao_portal_humano` | 22 |
| `reposicao_disparo` | 20 |

Um pedido zumbi silenciou dois vigias da área de compras.

### 4. ⚠️ A semântica de "dispensar" está INVERTIDA (achado do Codex, confirmado em prod)

O índice é **parcial**: `fin_alertas_unique_ativo ON (company, tipo) WHERE dismissed_at IS NULL`.
Dispensar tira a linha do índice ⇒ a próxima rodada ruim **insere um alerta novo e manda e-mail**.

Provado no histórico de `reposicao_portal_humano`: criado 23/07 17:30 → dispensado 24/07 00:30 →
**reaberto 24/07 02:30 com e-mail novo**. (Bate com os 2 e-mails de 23 e 24/07 em `fornecedor_alerta`.)

⇒ **Hoje, "dispensar" é o ÚNICO jeito de rearmar o alerta.** Clicar faz voltar; não clicar faz sumir
para sempre. O `reposicao_disparo` ficou 20 dias mudo precisamente porque ninguém o dispensou.
Também: a UI grava `dismissed_at` **e** `dismissed_until` (`useCashflowAlertas.ts`), mas o watchdog
**ignora `dismissed_until`** — o "snooze" não governa o produtor.

## Desenho: REPROVADO na forma simples (Codex challenge xhigh, 2026-08-14)

A proposta inicial era: `ON CONFLICT DO UPDATE` incondicional + re-emitir e-mail quando a severidade
escala ou quando vence um lembrete. **Reprovada.** Os 5 P1:

1. **Severidade + lembrete não pegam incidente NOVO.** Source já `critical`, e-mail há 1h, outro pedido
   entra: nenhuma condição dispara. Falta **identidade da violação** (`dedupe_key`/fingerprint dos
   pedidos que cruzaram o threshold + métrica de impacto). O fingerprint deve **excluir idade,
   mensagem e timestamps**, senão muda a cada cron = 48 e-mails/dia.
2. **A premissa sobre `dismissed_at` estava errada** — ver §4 acima (confirmado em prod).
3. **`NULL` em `status` já é falha ABERTA hoje.** `IF r.status <> 'ok'` com NULL não é verdadeiro ⇒
   cai no `ELSE` ⇒ **dispensa o alerta ativo**. Severidade desconhecida/nula vira `aviso` pelo
   `CASE ... ELSE`. O watchdog deve aceitar só valores conhecidos e **abortar** no resto.
4. **Um erro em 1 dos 18 checks aborta os outros 17** (o `FOR LOOP` não isola). Só é aceitável com um
   **dead-man independente**: gravar `last_success_at` apenas após a rodada completa e alertar
   externamente quando envelhecer.
5. **`CREATE OR REPLACE` sobre o corpo do repo é P1 aqui** (drift conhecido): obter a definição VIVA,
   validar e abortar em divergência. O corpo de prod usado neste diagnóstico está em `pg_get_functiondef`.

### Critério de reemissão aprovado

```
deve_notificar =
     nunca_enfileirou
  OR rank(severidade_atual) > rank(ultima_severidade_NOTIFICADA)
  OR houve_nova_violacao_ou_impacto_material
  OR clock_timestamp() >= proxima_notificacao_em
```

Âncora contra o último estado **notificado**, nunca contra a rodada anterior (senão o gatilho foge
junto com o valor). Padrão a **reusar**, não reinventar: `_tint_watchdog_fase5_transicao`
(`20260730120000`), que já resolveu isto com duas âncoras (`_n` × `_n_email`), UPDATE incondicional
do estado, rearme na recuperação e `UPDATE ... RETURNING` anti-corrida.

⚠️ **Furo que o reuso do tint NÃO cobre:** a âncora do tint é uma CONTAGEM. Dos 18 checks, **13 são de
frescor e 5 são de contagem** (`vendas_familia_ausente`, `custos_proxy_conf_alta`,
`custos_product_cost_revivido`, `reposicao_sayerlack_fabricado`, `tint_vinculo_omie`) — e nesses 5 o
`age_seconds` vem **NULL**. `COALESCE(age_seconds, 0)` daria âncora zero ⇒ `p_n >= 1` ⇒ e-mail a cada
rodada ⇒ 48/dia (o `dispatch-notifications` drena a cada 30 min). É o `ausente ≠ zero` de novo, e
atingiria justamente `vendas_familia_ausente`, um dos 3 presos.

### Estado, backoff e reconhecimento

Guardar no episódio de `fin_alertas` (não consultar `fornecedor_alerta`, que não tem FK/source
estruturado): `email_enfileirado_em` (último **enqueue**, não envio — se o dispatcher morrer,
"último envio" enfileiraria 48×/dia), `ultima_severidade_notificada`, `proxima_notificacao_em`,
`notificacoes_enfileiradas`, `ultimo_fingerprint_notificado`, `avaliado_em`.

Backoff **híbrido**: novo episódio, `stale→broken` e nova violação material ⇒ imediato; enquanto
persistir ⇒ cadência fixa por severidade (defaults: crítico 24h, aviso 72h). Nada de exponencial sem
teto (reduz atenção justo quando o custo de inação cresce), nem cadência única para 18 checks
heterogêneos.

Separar 4 conceitos hoje colapsados em `dismissed_at`: resolução automática (só com `ok` explícito),
reconhecimento humano (`acknowledged_at/by`), snooze com vencimento, e mute administrativo auditado.
**A UI precisa mudar junto** — se seguir gravando `dismissed_at`, continua criando episódios novos a
cada cron e contorna a máquina inteira.

**Ramo de recuperação — fail-closed:** só `status='ok'` explícito resolve; `NULL`/desconhecido/source
ausente/source duplicado **abortam**; nunca resolver por `NOT IN (resultado atual)`. Falha interna
deve deixar o alerta aberto e o marcador de sucesso envelhecer (falha barulhenta, não silenciosa).

## Prova PG17 exigida (14 cenários + 7 falsificações)

Um teste ingênuo `ok → broken → existe 1 linha e 1 e-mail` aprovaria até uma versão que ficasse muda
20 dias. Exigidos: 48 rodadas `stale` ⇒ 48 updates e **1** e-mail · `stale→broken` ⇒ +1 imediato ·
lembrete só em `T` · mudança cosmética ⇒ 0 e-mail · pedido B cruza threshold com A crítico ⇒ e-mail
antes do lembrete · 2 sessões simultâneas ⇒ 1 linha e 1 outbox · `status` NULL/typo/duplicado ⇒ função
falha e alerta ativo NÃO é resolvido · source ausente ⇒ `last_success_at` não avança · warning
reconhecido → critical ⇒ supera o reconhecimento · falha forçada no outbox ⇒ rollback do claim ·
`broken→ok→stale` ⇒ 2 episódios · linha histórica com `email_enfileirado_em=NULL` ⇒ **1** catch-up
após o apply, nunca 48/dia · functiondef vivo divergente ⇒ migration aborta.

Falsificar removendo, uma por vez: predicado temporal · predicado de escalada · fingerprint/materialidade ·
gate anti-spam · validação de NULL · atomicidade do claim · guard de drift. Cada sabotagem = vermelho
específico, nos locales `C` **e** `pt_BR.UTF-8` (regra do CLAUDE.md).

## Alcance

8 harnesses PG17 tocam `data_health_watchdog` (`db/test-data-health-*.sh`, `test-familia-ausente-lista-email.sh`,
`test-tint-cobertura-lista-email.sh`, `test-tint-vigia-cobertura.sh`) — todos precisam re-rodar.
`_data_health_compute` tem 3 dependentes SQL (`fin_sync_heartbeat`, `get_data_health`, o watchdog);
**manter a assinatura intacta** — mudar o `RETURNS TABLE` exigiria DROP + recriar os três.

## Alternativas avaliadas

| Abordagem | Esforço | Risco residual | Parecer |
|---|---|---|---|
| `severity` fixa `'critical'` nos 2 checks | S | Alto | Só mitigação; não corrige estado nem lembretes — e **não ajuda os já presos** (o `DO NOTHING` impede update e e-mail) |
| Máquina stateful em `fin_alertas` + fingerprint | M | Baixo | **Recomendada** |
| Tabela própria de incidentes/outbox multicanal | L | Baixo | Ideal, escopo excessivo agora |

**Veredito do Codex:** fazer a correção estrutural, mas **não aplicar** sem os 4 pontos —
identidade/materialidade de incidente, separação resolução×reconhecimento, claim atômico do enqueue,
e contrato fail-closed para os 18 checks. Sem eles, reduz o silêncio mas não elimina o furo.

Parecer integral: transcript da sessão 2026-08-14 (`codex-async.sh`, gpt-5.6-sol, xhigh).
