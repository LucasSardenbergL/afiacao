# Reset-path robusto — `farmer_client_scores` (F1 + F2)

> Data: 2026-06-18 · **Money-path** (scores guiam priorização do farmer). Frente dedicada do close-out Codex dos PRs #936/#941. Consenso Codex alcançado (sessão `019edd2f`). F4 já feito em #945; F5 e resurrection viram chips.

## Problema (pré-existente, DORMENTE até um reset de fcs)

- **F1 — gate frágil.** `calculate-scores` (edge `n`) só semeia `farmer_client_scores` quando `if (!clients || clients.length === 0)` (~linha 183). `scoring-recalc-client` (~linha 429) faz `upsert` ESPARSO (só `signal_modifiers`+`last_signal_recalc_at`, `onConflict customer_user_id`). Num reset (fcs esvaziada), se o recalc rodar primeiro p/ ≥1 cliente → cria linha → tabela não-vazia → seed SUPRIMIDO → milhares de clientes nunca semeados.
- **Fabricação.** A linha esparsa tem `days_since_last_purchase = 0` (DEFAULT da coluna, NÃO null) → no compute (~linha 383) `recencyScore = 100` → cliente sem venda parece "comprou hoje" → `priority_score` fabricado **polui a agenda do farmer** (`src/lib/scoring/agenda.ts` lê o `priority_score` derivado). Viola "ausente ≠ zero".
- **F2 — writes não fail-closed.** Seed batch insert (~315-334) e compute batch update (~482-488) só `console.error` e seguem; o fallback one-by-one nem checa o erro. Parcial → 200 OK silencioso. (#936 fez fail-closed só na LEITURA da RPC.)

## Realidade do schema (psql-ro, prod)

Todos os campos-base de `farmer_client_scores` têm DEFAULT (`days_since_last_purchase int DEFAULT 0`, `health_class DEFAULT 'critico'`, `*_score DEFAULT 0`, `calculated_at DEFAULT now()`, `signal_modifiers DEFAULT '{}'`). `UNIQUE(customer_user_id)` existe. **Não há sentinela confiável** "semeado vs esparso" (defaults mascaram; o compute sobrescreve `health_class` p/ todos). → a ideia do brief de "detectar campos-base null" não se aplica.

## Ecossistema

- `scoring-recalc-batch` (cron noturno) drena a fila E re-recalcula TODOS os pares com call nos últimos 30d (**rede de segurança** — signal_modifiers reacumula ≤24h). Fila populada por trigger `enqueue_score_recalc_from_call` em `farmer_calls` insert.
- `reverter_exclusao_fornecedor` (migration 20260606170100) re-enfileira o recalc esperando reconstruir a linha de fcs que `aplicar_exclusao_fornecedores` deletou. Comentário diz "reconstruídos pelos **drains/crons existentes**" (plural) — `calculate-scores` É um cron existente.

## Decisão: Design 1 (edge-only, SEM migration) — consenso eu+Codex

- **F1a** — `calculate-scores`: semeia clientes **FALTANTES** (`eligible − existing` por `customer_user_id`, com dado real de `get_customer_sales_summary`; ausente → days=999, honesto). Gate deixa de ser `length===0`: roda o seed sempre que houver faltantes; re-fetch; compute sobre todos. Steady-state (0 faltantes) → pula seed, compute como hoje.
- **F1b** — `scoring-recalc-client`: `upsert` → **`update().eq('customer_user_id', …).select('id')`** (UPDATE-only). 0 linhas = cliente ainda não semeado → `ok:true` (skip; será semeado pelo `calculate-scores`, e o batch noturno reaplica signal_modifiers ≤24h). **Mata a fonte da linha esparsa** (prevenção > reparo).
- **F2** — collect-and-throw no seed e no compute (estado money-path; idempotente → retry converge; falha visível em `net._http_response`). History/priority-log ficam **FORA** da fronteira fail-closed (audit, não estado-money-path → logam warning, nunca 500 → evita retry duplicando time-series).

### Por que não os outros

- **Design 2 (sempre re-semear tudo):** janela de fabricação transitória (recalc-insert → próximo seed) + shift de recência base-wide. **Rejeitado pelo Codex** (viola precisão>recall).
- **Design 4/5 (drop defaults→NULL / coluna sentinela):** migration + auditoria de TODO reader que faz `?? 0`/`|| 0` (senão a mentira só sobe de camada). Dominado pela **prevenção na fonte**: como o Design 1 torna o recalc update-only, não existe linha esparsa p/ reparar → a vantagem do sentinela é nula.

## Contrato que MUDA (documentado, não quebrado)

`reverter_exclusao_fornecedor`: a linha do fornecedor revertido passa a ser reconstruída pelo **seed noturno do `calculate-scores`** (≤24h, dado REAL) em vez de imediatamente-mas-esparsa pelo recalc-drain. Sem dependência em código de reconstrução sub-noturna (confirmado por Codex). Se o produto exigir visibilidade imediata na agenda pós-reverter, é expectativa de ops/produto — decidir à parte.

## Fora de escopo → chips

- **Resurrection race:** compute usa `upsert(onConflict:'id')` → se `aplicar_exclusao_fornecedores` deletar a linha mid-run, re-INSERE (ressuscita fornecedor) ou colide com `UNIQUE(customer_user_id)`. Fix correto = RPC `UPDATE … FROM jsonb_to_recordset` (update-only, throughput de batch) → **prove-sql-money-path próprio**. Sob Design 1 o vetor concorrente-recreate some (inseridor runtime único); sobra o flag-mid-run (raro, manual, auto-cura no próximo cleanup). F2 já faz a variante-colisão falhar alto.
- **recalc-batch farmer_id:** `scoring-recalc-batch`/`recalcOne` filtram calls por `farmer_id`=dono → call feita por farmer não-dono é perdida no recálculo.
- **F5:** `src/hooks/useFarmerScoring.ts:467` usa `onConflict: 'customer_user_id,farmer_id'` (composite ANTIGO) — a constraint real é `UNIQUE(customer_user_id)` → quebraria em prod (42P10).

## Teste (cheapest-test-that-catches-the-wrong-output)

- Helper PURO `computeSeedTargets(existingIds, eligible)` (diferença de conjunto) + **vitest** — é a lógica nova falsificável.
- Revisão **/codex adversarial** no diff (money-path, reasoning xhigh).
- Sem SQL novo no Design 1 → `prove-sql-money-path` não se aplica (reservado p/ o chip da RPC).
- Validação **psql-ro** pós-deploy (frescor de `calculated_at`, sem fabricação).

## Deploy (MANUAL, pós-merge, via chat Lovable, VERBATIM)

Dois edges mudam: `calculate-scores` (deployado como **`n`**) e `scoring-recalc-client`. Instruir o chat a ler do repo e deployar verbatim. Verificar por comportamento (psql-ro), não pela palavra do Lovable.
