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

## Estado em prod (2026-11-26)

- **Migration aplicada:** `db:aplicar` a partir da main `0d391c0fe`, com ensaio verde (POS OK) → recibo **#1445** (`aplicada`, sha256 `ad8c8316d19f…`). PR #4191 mergeado em `14c92cd04`.
- **2ª testemunha psql-ro:**
  - **flag DESLIGADO** em oben, colacor e colacor_sc (versão 0);
  - as 4 tabelas com RLS, as 2 guardas e 0 grants de escrita fora do dono;
  - `credito_fila_v` com `security_invoker=on`;
  - `credito_gate_v2_efetivo` só para service_role; `credito_definir_enforcement` e `credito_decidir_fila` só para authenticated; `credito_autorizar_solicitacao` (PR 2) sem grant;
  - crons `credito-fila-alertar` (`*/15`) e `credito-fila-recomendar` (`*/10`) ativos como `postgres`;
  - prontidão `false` nas 3 empresas.
- **Edge `credito-fila-recomendar`: deployada e atestada (2026-11-26).** Pacote `9fb1c38c6842` (contra a main `9efe21ae2`) enviado ao Lovable às 10:31:13Z. O agente conferiu 9/9 hashes e deployou (`source_sha256 df155533…`). A sonda, disparada pelo envelope (recibo **#1456**), deu **DEPLOY CONFIRMADO** `v1.0-fila-recomendacao`; o `pendencias:deploy` lista a edge em "confere".
  - O sensor de edição deu `EDICAO_DETECTADA`, mas é o falso positivo já documentado (`agente-lovable-conserta-o-que-nao-pediram.md` §6): o `commit_sha` da resposta (`4015ad9d6`, "Work in progress") só regenera `src/integrations/supabase/types.ts` a partir do banco, e o transcript do agente não tem tool de escrita. Não havia nada a reverter.
- **Follow-up `claude_ro` resolvido:** o laço de ACL da view tinha revogado o SELECT do `claude_ro` em `credito_fila_v` (as tabelas mantinham). A migration `20261126010000` (PR #4200) devolveu o SELECT, foi aplicada pelo envelope (recibo **#1453**) e a 2ª testemunha confirmou: SELECT `t`, INSERT `f`, `anon` sem SELECT, a view lida pelo psql-ro (44 linhas).
- **Publish (founder): liberado** — a edge já está no ar. A tela `/credito/fila` e o item "Fila de crédito" no menu Financeiro só aparecem após o Publish.

## 403 da `credito_fila_v` em toda tela (2026-11-26, ~11h–12h13)

Depois do Publish, todo `GET /rest/v1/credito_fila_v?…` do contador do menu dava **403**, inclusive para o master. Duas causas empilhadas, as duas invisíveis no PG17 porque o stub dava permissão demais:
1. **Coluna fechada lida pela view** (#4206, recibo #1464). O `authenticated` tem SELECT em `sales_orders` **por coluna**, e `vendedor_user_id` está fechada (#d7a15546d). Com `security_invoker`, uma coluna sem grant derruba a view inteira com 42501. A coluna passou a vir `NULL::uuid` (mesmo nome e tipo; `CREATE OR REPLACE` preserva o ACL). A postcondição pega a **classe**: por `pg_depend` de colunas, toda coluna lida pela view tem grant.
2. **Policies de SELECT chamando a função errada** (#4210, recibo #1468). Desde `20260718180000`, a `public.pode_ver_carteira_completa` só executa para o `service_role`, e o `authenticated` usa a `private.` Mesmo assim, **18 policies** `*_select_gestor` da família `credito_*` (PR 2 a PR 8) chamavam a versão `public`. As RPCs SECURITY DEFINER não passam pela policy, por isso só a view (invoker) falhava. As 18 foram reapontadas com `ALTER POLICY`, só na forma exata, com `quote_all_identifiers`/`search_path` fixados (Codex).

A sessão da onda D confirmou **200** no navegador às 12:13:48Z. O harness passou a reproduzir as duas permissões da prod (E11/E12, F18/F19).

## 6b — o `omie-vendas-sync` chama o gate v2 efetivo (2026-11-26)

- **#4213** (v1.49): módulo `gate-v2.ts`, chamado em `criar_pedido` (depois do piso, tint e ATP, antes do claim) e em `alterar_pedido` (fora do `edicaoExigeGate`, antes de `ExcluirItemPedido`). Com o flag desligado, a RPC devolve `desligado` e o pedido segue o caminho de hoje. Amarelo, vermelho, pendência e revalidação saem como **erro**, nunca como `blocked` novo. O verde exige `ligado:true` e UUIDs de decisão e reserva. Nada da resposta vai à mensagem nem ao log. Codex: desenho (2 P0 e 3 P1) e diff em 2 rodadas, tudo acatado.
- **#4217** (v1.51): **opção (b) do founder** (Q1, "Deixar seguir"). Sem resposta da RPC (transporte ou formato inesperado), o pedido **segue** e grava `gate_indisponivel` em `venda_bloqueio_credito_log`. Antes, com a opção (a), o pedido ficava segurado; essa foi a única diferença em relação ao caminho de hoje com o flag desligado. A v1.50 tinha ido ao ar pelo PR da edição de pedido já com a (a): por algumas horas, uma falha da RPC teria segurado pedido real.
- **Deploy:** pacote `4e13ae8086fb` (43 arquivos, main `d5f0b163e`) pelo Lovable MCP às 16:22Z. O agente conferiu 43/43 hashes e respondeu sem `edit_id`. A sonda saiu pelo **relé** (recibo #1480), porque o bloco de POST direto é recusado nesta edge: num bundle velho, ele rodaria o fluxo real. **Atestado:** sensor `SEM_EDICAO` (0 commits do bot, confirmação presente) e ledger com `v1.51-gate-v2-sem-veredito-segue` servida às 16:27Z; `pendencias:deploy` 94/94 em "confere".
- **Prontidão** (#4223, aplicada depois da atestação, recibo **#1482**; 2ª testemunha: 13 pendentes, prontidão `false` nas 3, flag desligado nas 3, ACL intacto): sai o item 6b; entram `m_front_trata_credito_fila_e_retomada_do_envio` e `n_gate_v2_volta_a_fail_closed_antes_de_ligar`. Os pré-requisitos d, e, f e g a l continuam.

## Lições

- **`_push_enviar` volta em silêncio** sem `CRON_SECRET` ou sem destinatário — gravar "alerta enviado" depois dele é mentira. Meça o canal ANTES (segredo, assinatura) e registre `sem_canal`; e `enfileirado` no pg_net ainda não é entrega.
- **Defesa em camadas, falsifique todas juntas.** O dedupe do alerta tem 3 camadas (NOT EXISTS, CONTINUE sob lock, guarda "enfileirado é final"); sabotar só as 2 primeiras ficou VERDE — a guarda segurava. A falsificação útil derruba as 3.
- **`aborta` contra estado já migrado é cego.** Uma migration mutante que "esquece um REVOKE" aplica limpa se o REVOKE da aplicação anterior ainda vale; devolva o grant antes do mutante.
- **`to_char(…, 'G'/'D')` segue `lc_numeric`**: em `C` sai `5,000.00`. Texto que vai para o usuário com separador fixo: `translate(to_char(v, 'FM999,999,990.00'), ',.', '.,')`.
- **Conta autoritativa ANTES do flag.** Um gate que lê o flag pela empresa que o chamador DECLARA deixa uma chamada errada desligar a empresa ligada — e o teste que eu tinha escrito EXIGIA esse resultado. Leia a conta do pedido primeiro; divergência é resultado próprio.
- **Vigência numa fonte só.** View, contador, alerta, IA e ação liam "atual" de jeitos diferentes; um retry do mesmo 🟡 (decisão nova reusando a solicitação) virava "superada" num lugar e "aberta" noutro. A ação agora lê a vigência DA VIEW.
- **RETURNS TABLE em plpgsql** colide com coluna de mesmo nome (`decisao_id` ambíguo) — `#variable_conflict use_column`.
- **Stub de permissão mais largo que a prod esconde a classe inteira.** Grant de tabela inteira e EXECUTE para todos no PG17 deixaram passar dois 403 seguidos (coluna fechada; função `public` sem EXECUTE). O harness tem de **reproduzir o ACL da prod** (grant por coluna, REVOKE da função `public`) antes de afirmar que uma view `security_invoker` é legível. E a postcondição precisa olhar a classe (`pg_depend` de colunas; nenhuma policy chamando a função `public`), não só o caso que mordeu.
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
