# Crédito-IA PR 6a — fila `/credito/fila`, recomendação IA, alerta > 2 h e enforcement DORMENTE (2026-11-25)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` · plano `docs/superpowers/plans/2026-11-25-credito-ia-pr6-fila.md` (com a tabela pós-Codex).

## O que entrou

> **Depende do PR 5** (#4192 — `20261125195900` índices + `20261125200000_credito_gate_v2_sombra.sql`): a aba Sombra, a recomendação de sombra e a prontidão leem o ledger dele (`credito_sombra_decisao`/`_lote`/`_tentativa`); a postcondição aborta se ele não estiver aplicado. Ordem de apply: PR 5 → 6a.

- **Migration** `20261125230000_credito_fila_enforcement_dormente.sql` — só objetos novos + 1 troca de ACL:
  - `credito_enforcement` (1 linha por empresa, as 3 **desligadas**) + `credito_enforcement_log`; único escritor `credito_definir_enforcement` (allowlist do PR 2 = o Lucas). Ligar exige `credito_enforcement_prontidao(empresa).pronto`; desligar nunca depende dela e cancela as solicitações abertas.
  - `credito_gate_v2_efetivo(pedido, empresa, revisão)` — dormente: desligado devolve `{resultado:'desligado'}` sem escrever nada; ligado avalia pelo núcleo do PR 2/5 em modo `efetivo`. Revisão errada é **resultado explícito**, nunca exceção (a edge não pode ler como "indisponível" e despachar conteúdo velho).
  - `credito_fila_v` (security_invoker): efetivo = solicitação (marcada `superada`/`congelada` quando não é mais acionável); sombra = **última** avaliação por pedido×empresa, só então filtrada para 🟡 resolvível.
  - `credito_decidir_fila` — único caminho de autorização (`credito_autorizar_solicitacao` do PR 2 perdeu o grant de `authenticated`).
  - Recomendação: `credito_fila_recomendacao` + `credito_fila_reivindicar_recomendacao` (claim antes da chamada paga) + `credito_registrar_recomendacao` (único escritor, descarta claim velho).
  - Alerta: `credito_fila_alerta` + `private.credito_fila_alertar()` (pg_cron 15 min) reusando `public._push_enviar` → edge `enviar-push`. Estado verdadeiro: `sem_canal` ≠ `enfileirado`.
- **Edge nova** `credito-fila-recomendar` (Anthropic direto, `MODELO_PADRAO`, prompt caching, tool-use não forçado, 5 itens por invocação, pg_cron 10 min, disparo só cron).
- **Tela** `/credito/fila` (abas Pedidos reais · Sombra · Ligar por empresa), item "Fila de crédito" no menu Financeiro com contador, Cmd-K.
- **Prova PG17** `db/test-credito-fila.sh`: 190 asserts (inclui 16 falsificações com controle verde), em `C` e `pt_BR.UTF-8`, aplicadas sobre as migrations REAIS do PR 5 (`20261125195900` + `20261125200000`).
- **Codex** em duas rodadas (desenho e diff, gpt-6.2-astra high): o diff achou 1 P0 (a conta DECLARADA escolhia o flag) e 7 P1 (retry do mesmo 🟡 tornava o item indecidível; r2 registrada deixava r1 aprovável; a sombra do PR 5 mora em outra tabela; o front fabricava fila vazia/flag desligado; "IA aprovar com prazo menor" autorizava o prazo integral; orçamento da IA só por invocação; cron 401 sem `verify_jwt=false`). Todos corrigidos e provados (F14–F16).

## Lições

- **`_push_enviar` volta em silêncio** sem `CRON_SECRET` ou sem destinatário — gravar "alerta enviado" depois dele é mentira. Meça o canal ANTES (segredo, assinatura) e registre `sem_canal`; e `enfileirado` no pg_net ainda não é entrega.
- **Defesa em camadas, falsifique todas juntas.** O dedupe do alerta tem 3 camadas (NOT EXISTS, CONTINUE sob lock, guarda "enfileirado é final"); sabotar só as 2 primeiras ficou VERDE — a guarda segurava. A falsificação útil derruba as 3.
- **`aborta` contra estado já migrado é cego.** Uma migration mutante que "esquece um REVOKE" aplica limpa se o REVOKE da aplicação anterior ainda vale; devolva o grant antes do mutante.
- **`to_char(…, 'G'/'D')` segue `lc_numeric`**: em `C` sai `5,000.00`. Texto que vai para o usuário com separador fixo: `translate(to_char(v, 'FM999,999,990.00'), ',.', '.,')`.
- **Conta autoritativa ANTES do flag.** Um gate que lê o flag pela empresa que o chamador DECLARA deixa uma chamada errada desligar a empresa ligada — e o teste que eu tinha escrito EXIGIA esse resultado. Leia a conta do pedido primeiro; divergência é resultado próprio.
- **Vigência numa fonte só.** View, contador, alerta, IA e ação liam "atual" de jeitos diferentes; um retry do mesmo 🟡 (decisão nova reusando a solicitação) virava "superada" num lugar e "aberta" noutro. A ação agora lê a vigência DA VIEW.
- **RETURNS TABLE em plpgsql** colide com coluna de mesmo nome (`decisao_id` ambíguo) — `#variable_conflict use_column`.
- **Medido em prod (psql-ro, 2026-11-25):** `push_subscriptions` = **0 linhas no app inteiro** — a infra de push existe e ninguém ativou. O alerta > 2 h só chega quando o Lucas ativar o push num aparelho (condição `aprovador_alcancavel` da prontidão).

## Para ligar (Lucas) — e quando

**Não ligue agora.** A prontidão recusa: faltam a 1ª leva de limites (PR 4), 14 d de sombra (PR 5), o 6b (edge) e os pré-requisitos de código/ensaio listados nela. Veja o estado a qualquer momento (SQL Editor ou psql-ro):

```sql
-- psql-ro (claude_ro tem EXECUTE) ou SQL Editor
SELECT c AS empresa, (q.p ->> 'pronto')::boolean AS pronto,
       x ->> 'chave' AS condicao, (x ->> 'ok')::boolean AS ok, x -> 'valor' AS valor, x ->> 'criterio' AS criterio
  FROM unnest(ARRAY['oben','colacor','colacor_sc']) c
  CROSS JOIN LATERAL (SELECT public.credito_enforcement_prontidao(c) AS p) q
  CROSS JOIN LATERAL jsonb_array_elements(q.p -> 'condicoes') x
 ORDER BY 1, 3;
```

Quando **todas** as linhas de uma empresa estiverem `ok = true`: `/credito/fila` → aba **Ligar por empresa** → **Ligar enforcement** (o botão só habilita com a prontidão cumprida) → motivo → Confirmar. O SQL Editor não liga (sem `auth.uid()` a RPC recusa). **Desligar** é o mesmo botão e funciona sempre (kill switch).
