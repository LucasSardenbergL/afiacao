# `analytics_outbox` — telemetria decisória emitida server-side

> Spec do padrão descrito em [`docs/agent/analytics.md`](../../agent/analytics.md) §6,
> subseção *"A quarta saída: outbox server-side (preferida sobre (c) puro)"*.
> Data: 2026-08-25.

## 1. O problema que isto resolve

A telemetria client-side do app é **censurada** por bloqueadores de rastreador, não esparsa
(PR #1984). E a censura **correlaciona com perfil**: quem bloqueia tende a usar mais. Medição de
2026-08-25: o último evento de browser no PostHog é de `2026-08-23T11:09Z`, enquanto
`dashboard_visits` — que escreve por PostgREST, fora do cano do PostHog — ganhou linha em
`2026-08-25T01:32Z` com 16 min de sessão. **O zero é do canal, não do fenômeno.**

A resposta anterior era a regra *"sinal que DECIDE nasce em tabela própria"*. Ela está cumprida em
**1 de 111** sensores `track()`, e não se sustenta sozinha por um motivo estrutural:

> **"Sinal que decide" muda DEPOIS da coleta.** Um evento classificado hoje como conveniência vira
> métrica decisória amanhã — e aí o histórico dele já nasceu censurado. Retroatividade que nenhuma
> regra de estilo conserta.

Dual-write manual espalhado por N tabelas produz divergência. Outbox transacional, não.

## 2. O fato de negócio — medido, não presumido

⚠️ **`public.orders` tem ZERO linhas na prod** (total e 30 dias). O exemplo natural de "pedido
criado/aprovado/concluído" está morto; ancorar a outbox nele seria fabricar exatamente a *fase sem
sinal* que este trabalho existe para evitar.

O fato vivo é **`public.pedido_compra_sugerido`** (medido 2026-08-25, `psql-ro`):

| status | 30 dias |
|---|---|
| `expirado_sem_aprovacao` | 84 |
| `disparado` (aprovado → enviado) | 44 |
| `pendente_aprovacao` | 2 |
| `cancelado_humano` | 2 |

Essa razão — 44 aprovados contra 84 expirados — **é** a métrica que decide a fase N+1 do piloto de
auto-aprovação Sayerlack, o precedente 1 de [`fase-sem-sinal.md`](../../historico/fase-sem-sinal.md).

**Por que trigger e não dual-write no código:** `aprovado_em` tem **dois escritores** — o frontend,
via `UPDATE` PostgREST sob a identidade do usuário (`src/components/reposicao/`), e a edge
`disparar-pedidos-aprovados`, sob `service_role`. Só um trigger no banco captura os dois. Um
dual-write divergiria no primeiro caminho esquecido, que é a falha que a outbox existe para não ter.

## 3. Arquitetura

```
                    ┌─ (A) trigger AFTER INSERT/UPDATE — mesma transação
 pedido_compra_     │        ON pedido_compra_sugerido
   sugerido  ───────┤
                    │                                        ┌──────────────────┐
                    └──────────────────────────────────────► │ analytics_outbox │
                                                             │  (fila, não      │
 MixGapCard ──► RPC analytics_ledger_registrar() ──────────► │   arquivo)       │
   (B) ledger autenticado, SECURITY DEFINER                  └────────┬─────────┘
       user_id := auth.uid() — NUNCA do parâmetro                     │
                                                                      │ pg_cron */5min
                                                                      │ net.http_post
                                                                      ▼
                                                        edge analytics-outbox-drain
                                                        (authorizeCronOrStaff)
                                                                      │
                                                                      ▼
                                                        PostHog /batch/  ($insert_id)
```

Dois caminhos de escrita, **uma** tabela:

- **(A) Fato de domínio** — trigger `FOR EACH ROW` na mesma transação do `INSERT`/`UPDATE`. Se a
  transação de negócio faz rollback, o evento some junto. É o que garante que a série e a tabela
  nunca divergem.
- **(B) Jornada crítica sem mutação de domínio** — uma RPC `SECURITY DEFINER` que o front chama.
  Um ledger, **não 111 tabelas espelho**.

Interação puramente de UI (`cmdk.opened`, `theme.changed`) **continua client-side e assumidamente
censurável**. Não se tenta cobrir tudo — esse era o erro de mirar nos 111.

## 4. Esquema

```sql
CREATE TABLE public.analytics_outbox (
  id            bigserial PRIMARY KEY,
  event_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  evento        text        NOT NULL,          -- convenção <area>.<action>, igual ao track()
  distinct_id   text        NOT NULL,          -- casa com identify(userId) do front
  user_id       uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  props         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  chave_dedup   text        NOT NULL UNIQUE,   -- dedup na ORIGEM
  ocorrido_em   timestamptz NOT NULL DEFAULT now(),
  enviado_em    timestamptz NULL,              -- NULL = na fila
  tentativas    smallint    NOT NULL DEFAULT 0,
  ultimo_erro   text        NULL
);
```

Decisões que não são óbvias:

- **`distinct_id` casa com o front.** `src/lib/analytics.ts` chama `identify(userId)` com o uuid do
  Supabase, então usar `user_id::text` server-side junta as duas séries na **mesma pessoa** — a
  outbox não cria uma segunda identidade.
- **Fato sem pessoa não carrega pessoa.** `sugestao_criada` e `sugestao_expirada` são do sistema:
  `distinct_id = 'sistema:reposicao'` e `user_id IS NULL`. Só aprovação e cancelamento humano
  carregam titular. Minimização estrutural, não por política.
- **`chave_dedup` UNIQUE + `ON CONFLICT DO NOTHING`.** Sem o `DO NOTHING`, uma colisão levantaria
  exceção **dentro da transação de negócio** e derrubaria a aprovação de um pedido — a telemetria
  passaria a poder reprovar o money-path.
- **`ON DELETE SET NULL`** e não `CASCADE`: apagar o usuário não pode apagar a contagem do fato.

RLS obrigatória (tabela nova sempre): sem policy de `INSERT`/`SELECT` para `authenticated` — o
front nunca fala com esta tabela diretamente. `service_role` para o worker, `master` para auditoria.

## 5. Retenção (LGPD) — decidida no ritual Codex, contra a minha posição

O founder delegou esta decisão ao ritual. Minha posição era: purgar 30 dias após o envio e **nunca**
purgar em silêncio uma linha ainda não enviada — ela fica e alerta. **Foi refutada, e o argumento é
melhor que o meu:**

> Um payload inválido ou uma credencial permanentemente errada **nunca vão atingir a finalidade**.
> Guardá-los indefinidamente não transforma falha em necessidade — deixa retida para sempre
> justamente a linha mais defeituosa, que é o oposto de minimização.

O que ficou:

| estado | retenção |
|---|---|
| aceito pelo PostHog | **7 dias** após o aceite |
| pendente / em retry | teto de **30 dias desde a criação** — não desde a última tentativa, senão o retry renova o prazo para sempre |
| quarentena (erro permanente) | o mesmo teto de 30 dias, já herdado |

Implementado como `purgar_em timestamptz **NOT NULL** DEFAULT now() + 30 days`, encurtado para 7
dias no aceite. **Nesta tabela não existe o estado "fica para sempre"** — é uma propriedade do
esquema, não uma política que alguém precisa lembrar de aplicar. Estender exige alterar `purgar_em`
explicitamente, o que é decisão humana registrada, não acidente de retry.

**Tabela própria não dispensa LGPD:** dado em tabela nossa continua sendo tratamento de dado
pessoal (arts. 6º III, 15 e 16). O ponto (c) resolve censura, nunca obrigação legal.

E há uma minimização anterior à retenção, que vale mais: **o caminho (A) não grava pessoa nenhuma**
(ver §4). Só o ledger carrega titular. A pergunta certa não é "por quanto tempo guardo" — é "preciso
identificar alguém para responder isto?", e no funil de compra a resposta era não.

## 6. Eventos do conjunto mínimo

Escolhidos por fundamentarem uma fase N+1 concreta — não por serem fáceis.

| evento | origem | decide |
|---|---|---|
| `reposicao.sugestao_criada` | trigger, INSERT | denominador do funil de compra |
| `reposicao.sugestao_aprovada` | trigger, `aprovado_em` NULL→NOT NULL | numerador — piloto de auto-aprovação |
| `reposicao.sugestao_expirada` | trigger, status → `expirado_sem_aprovacao` | a perda que a auto-aprovação evitaria |
| `reposicao.sugestao_cancelada` | trigger, status → `cancelado_humano` | recusa deliberada ≠ desatenção |
| `carteira.mixgap_visto` | ledger (RPC) | fase 2 do MixGap — o evento do #1900 |

## 7. Worker

Edge `analytics-outbox-drain`, gate `authorizeCronOrStaff`, registro server-side via
`_shared/registro-execucao.ts` (slug `analytics-outbox-drain`, **1 escritor**). Cron `*/5`, com
`timeout_milliseconds` **explícito** — o default de 5 s mata silencioso. E `cron.job_run_details =
succeeded` só prova o **enqueue**: a verdade HTTP está em `net._http_response`.

## 8. Três coisas que a verificação mudou no desenho

**(a) O PostHog não deduplica por `$insert_id`.** Eu tinha escrito isso. A doc oficial
(posthog.com/docs/data/events, lida em 2026-08-25) diz: *"Events that share the same **uuid, event
name, timestamp, and distinct_id** are treated as duplicates"*, e *"Keep the timestamp identical to
the original, or the event won't be deduplicated"*. Consequências no worker: `uuid` vai **top-level**
(não em properties), `timestamp` sai do `ocorrido_em` **persistido** — nunca de `now()` no retry — e
**nada de `sent_at`** na query string, porque o PostHog usa esse parâmetro para ajustar o timestamp.
Errar isso não perderia eventos: **inflaria** a contagem, porque cada retry viraria evento novo. E a
contagem inflada é exatamente a que decide ligar a auto-aprovação.

**(b) O trigger não pode reprovar o money-path — mas fail-open só se sustenta com reconciliação.**
Aprovar uma compra não pode falhar porque a telemetria está indisponível, então o `INSERT` na outbox
tem `EXCEPTION WHEN OTHERS`. Isso deixa de ser outbox transacional **estrita**, e a troca fica
declarada em vez de escondida. O que a separa da "sonda que degrada em silêncio" do CLAUDE.md é a
view `analytics_outbox_reconciliacao`: o silêncio é auditável contra a fonte, e a ausência ganha
denominador. A view declara a própria confiança por linha — `aprovada` é **prova** (`aprovado_em` é
timestamp imutável); `expirada` é só **indicativa**, porque a expiração não tem timestamp próprio e
usa `atualizado_em`, que qualquer UPDATE posterior reescreve. Corrigir isso pede um `expirado_em` no
domínio — fora do escopo, registrado em vez de fingido.

**(c) A prova PG17 pegou um bug que o `CREATE` não pega.** `analytics_outbox_claim` compilava e
quebrava só ao executar, com `column reference "tentativas" is ambiguous`: cada nome do
`RETURNS TABLE` vira variável OUT e colide com a coluna homônima no `SET`/`WHERE`. Em produção teria
falhado a cada 5 minutos com `cron.job_run_details = succeeded` — que só prova o *enqueue* — mostrando
tudo verde. Resolvido com `#variable_conflict use_column`.

## 9. O que ficou de fora, e por quê

- **A concorrência entre os dois escritores de `aprovado_em`.** Frontend e edge escrevem a mesma
  coluna sem compare-and-set nem máquina de estados; aprovação, cancelamento e expiração podem
  disputar a linha. A outbox registraria fielmente o resultado errado. É um defeito **real e
  anterior a este trabalho**, do domínio de reposição — outro PR.
- **Projeto PostHog separado para eventos server-side.** O token de captura é público (o mesmo tipo
  roda no browser), então qualquer um pode empurrar um evento com qualquer nome. A mitigação que
  importa já está no desenho: **o PostHog não é fonte de autoridade** — quem decide é o Postgres.
  Um projeto dedicado é melhoria operacional, não pré-requisito.
- **Os outros 106 sensores `track()`.** Interação de UI segue client-side e assumidamente
  censurável. A regra nunca foi espelhar tudo.
