# Sentinela de Saúde de Dados — Design

> Spec de design (brainstorming). Data: 2026-05-26. Autor: sessão Claude + consulta Codex.
> Status: aprovado pelo founder, aguardando plano de implementação.

## Problema

O app é profundo e bem-construído, mas o gargalo pra "nível mundial" não é polish de UI — é **confiança nos dados**. O sintoma comprovado nesta sessão: os saldos das contas correntes apareceram **R$ 0,00 silenciosamente por semanas** porque um sync chamava um método Omie inexistente (`ResumirContaCorrente`). Foi uma **falha de dados SILENCIOSA numa tela de dinheiro**. O `CLAUDE.md` documenta o mesmo padrão repetidamente (crons 401, dados 56 dias parados, cursores travados).

A **Sentinela de Saúde de Dados** transforma falhas silenciosas de dados em **alertas visíveis** — antes que enganem alguém numa decisão.

## Escopo (MVP) — decisões travadas

| Decisão | Escolha |
| --- | --- |
| O que faz ao detectar | Badge global + tela "Saúde de Dados" + **banner inline não-bloqueante** nas telas críticas |
| Fontes cobertas | Financeiro, Syncs Omie + crons, Carteira/scoring, Estoque/reposição (registro extensível) |
| Audiência do badge + tela | Master/gestão (banners inline aparecem pra quem abre a tela crítica) |
| Ação | **Só diagnóstico** (read-only). Sem botão "re-executar sync" no MVP |
| Arquitetura | RPC on-demand (sem cron novo, sem edge function) |

**Fora do escopo (pilares posteriores):** snapshot por cron (histórico/tendência/dead-man switch), circuit-breakers que **bloqueiam** telas, "Runbook Autopilot" com botão de ação, Decision Ledger.

## Princípio não-negociável: SEM VERDE SILENCIOSO

A camada que existe pra pegar falhas silenciosas **não pode falhar em silêncio**. Se a Sentinela não consegue *provar* saúde (tabela vazia, não consegue ler `cron`/`net`, correlação ambígua, erro de query), o status é **`unknown` ou `broken`** com `probable_cause='diagnostic_incomplete'` — nunca verde por omissão. Erro de query no frontend → badge vermelho/cinza, **nunca some**.

## Arquitetura

### Abordagem escolhida: RPC on-demand
Uma RPC Postgres `SECURITY DEFINER` `get_data_health()` que computa todos os checks **ao vivo** quando o badge/tela carrega. Frontend lê via react-query (`staleTime ~60s`). **1 migration + frontend; zero cron novo; zero edge function.** Combina com o constraint do Lovable (deploy manual mínimo) e a saúde é sempre fresca.

Constrói sobre infra existente, não reinventa: `fin_sync_log` (status/error_message/completed_at/companies), `get_carteira_saude()` (`20260525160000`), watchdogs `fin_sync_watchdog` (`20260525200000` + sweep `20260526030000`).

### Fonte de verdade (correção crítica do Codex)
- **Primária:** frescor de tabela (`max(updated_at)` / `max(saldo_data)` / `calculated_at`) + `fin_sync_log` (status='error' recente, `completed_at`).
- **Evidência (secundária):** `net._http_response` — status HTTP recente, escopado a janela curta (24-72h) + allowlist de funções + `left(content, 500)`. Marcado como `evidence`, não status canônico (a correlação job→HTTP é fraca porque os crons fazem `PERFORM net.http_post(...)` e descartam o `request_id`).
- **NÃO usar como verdade:** `cron.job_run_details` — reporta `succeeded` mesmo quando o `pg_net` só *enfileirou* a chamada (mesmo em 401). Foi exatamente o ponto cego do bug do saldo. (O `get_carteira_saude()` atual ainda repete esse ponto cego — a Sentinela corrige.)

### Registro de checks: blocos `UNION ALL` estáticos in-RPC
Cada check é um bloco SQL estático com contrato de saída consistente. **Não** usar tabela de config com texto de query (vira "mini query engine" numa função privilegiada). Extensível = adicionar um bloco `UNION ALL`.

### Contrato de cada check
```
{
  source:                 text,   -- ex: 'saldo_bancario', 'omie_cr_colacor'
  domain:                 text,   -- 'financeiro' | 'omie_sync' | 'carteira' | 'estoque'
  status:                 text,   -- 'ok' | 'stale' | 'broken' | 'unknown'
  observed_at:            timestamptz,  -- o timestamp de frescor observado
  age_seconds:            bigint,
  expected_max_age_seconds: bigint,     -- threshold (default por check)
  freshness_basis:        text,   -- 'max_updated_at' | 'max_saldo_data' | 'calculated_at' | 'last_complete_sync'
  last_error:             text,   -- só pra audiência full
  probable_cause:         text,   -- só pra audiência full
  how_to_fix:             text,   -- só pra audiência full (ex: "rode sync_contas_correntes no chat do Lovable")
  severity:               text    -- 'critical' | 'warning' | 'info'
}
```

### Checks por domínio (separados, depois roll-up)
Reportar cada sub-fonte **separadamente** (CP fresco não pode mascarar CR stale), e a tela faz o roll-up por domínio.

- **Financeiro:** saldo bancário (`fin_contas_correntes.saldo_data` null/velho), CR / CP / movimentações / aging — **cada um** com idade própria.
- **Syncs Omie + crons:** último `fin_sync_log` ok por entidade/empresa + evidência HTTP recente.
- **Carteira/scoring:** `farmer_client_scores` / `customer_visit_scores` (`calculated_at`) + snapshot de positivação.
- **Estoque/reposição:** frescor de picking/recebimento + sugestão de compra.

(Cada check define explicitamente sua `freshness_basis` e `expected_max_age_seconds` — não há mapeamento genérico "uma coluna serve todas", porque `updated_at`/`saldo_data`/`calculated_at`/`completed_at` significam coisas diferentes.)

### Segurança e redação por papel (1 RPC, 2 audiências)
Gate **no corpo da RPC**, fail-closed:
- `auth.uid()` obrigatório (senão erro).
- Audiência **full** = `master` OU `employee` + depto gestão (`COALESCE(..., false)` em todo check de papel).
- `SECURITY DEFINER SET search_path = public, pg_temp`; `GRANT EXECUTE TO authenticated`; revoke `anon/public`.
- **NÃO** copiar o bypass de cron (`request.jwt.claims IS NULL`) do `20260524203000` — esta RPC é user-facing, não precisa de acesso de cron.

**Redação:** a RPC **deriva a audiência do papel do chamador** (`auth.uid()` → check de papel), sem parâmetro. Audiência full (master/gestão) → todos os campos. Qualquer outro `authenticated` → só campos banner-safe (`source`, `status`, `age_seconds`, `message`), pro banner inline. Assim a mesma RPC serve as duas superfícies sem vazar HTTP/erro/causa pra quem não é gestão.

## Componentes (unidades isoladas)

| Unidade | Faz | Depende de |
| --- | --- | --- |
| `get_data_health()` (RPC SQL) | Computa todos os checks; redação derivada do papel do chamador | `fin_contas_correntes`, `fin_contas_receber/pagar`, `fin_sync_log`, `farmer_client_scores`, `customer_visit_scores`, `net._http_response` (evidência), tabelas de estoque/reposição |
| `src/lib/dataHealth/health-helpers.ts` (puro) | Roll-up domínio, derivação de cor do badge, formatação de idade — **testável isolado (vitest)** | nada (puro) |
| `useDataHealth()` (react-query hook) | Lê a RPC, staleTime 60s, mapeia erro→badge vermelho | RPC, helpers |
| `<DataHealthBadge />` (topbar) | Verde/amarelo/vermelho + contagem; master/gestão | `useDataHealth` |
| `SaudeDados.tsx` (`/gestao/saude-dados`) | Lista por fonte: status/idade/erro/causa/como-resolver; master/gestão | `useDataHealth` |
| `<DataHealthBanner source=... />` | Banner inline não-bloqueante numa tela crítica | `useDataHealth` (filtra a fonte) |

## Fluxo de dados
1. Badge/tela/banner montam → `useDataHealth()` chama `get_data_health()`.
2. RPC computa checks ao vivo, aplica redação por papel, retorna array.
3. Helper puro faz roll-up por domínio + deriva cor do badge.
4. UI renderiza. Erro de query → estado vermelho/unknown explícito.

## Tratamento de erro
- RPC não consegue ler uma fonte → aquele check vira `unknown`/`broken` (`diagnostic_incomplete`), não some.
- `useDataHealth` com erro/timeout → badge vermelho "saúde indisponível", não verde.
- Cada check é independente: um falhar não derruba os outros (blocos `UNION ALL` com `COALESCE`/try-safe por bloco).

## Testes
- **Helper puro** (`health-helpers.ts`): roll-up, cor do badge, formatação de idade, lógica "sem verde silencioso" → vitest.
- **RPC**: validada pelo ritual Lovable (apply no SQL Editor + query de checagem retornando os checks esperados; incluir um cenário stale forçado).

## Deploy (constraint Lovable)
- **1 migration** (a RPC + grants) colada no SQL Editor → Run → validar.
- Frontend mergeia normal (rebuild automático do Lovable).
- Sem edge function, sem cron.

## Critérios de sucesso
1. Se o saldo bancário parar de sincronizar, o badge fica vermelho e `/financeiro` mostra banner "Saldo não sincroniza há X dias" — **o bug do saldo seria pego no dia 1**.
2. A Sentinela nunca mostra verde quando não consegue provar saúde.
3. Zero edge function / cron novo no MVP.
4. Master/gestão veem diagnóstico completo; outros veem só o banner-safe.

## Riscos / pontos de atenção
- Acesso `SECURITY DEFINER` aos schemas `cron`/`net`: confirmar grants no apply; se falhar leitura, degradar pra `unknown` (não quebrar).
- Performance da leitura de `net._http_response`: escopar duro (janela curta + allowlist + `left(content,500)`).
- `expected_max_age_seconds` por check: começar com defaults sensatos (saldo ~36h, CR/CP ~26h, scoring ~30h); ajustáveis depois.
