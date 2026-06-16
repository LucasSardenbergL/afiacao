# Incidente — `omie-analytics-sync` `sync_inventory` estoura 60s (cmc defasado)

> Diagnosticado em 2026-06-14 via dogfood da skill `diagnose-supabase-sync` (acesso read-only `psql-ro`).
> Status: **causa raiz CONFIRMADA · AGUARDANDO AÇÃO HUMANA** (founder — fix é cron + edge, via Lovable).
> ⚠️ Aumentar `timeout_milliseconds` **não** é correção confirmada (ver mitigação).

## Causa raiz (confirmada, 3 evidências independentes)

O cron `omie-analytics-sync` action `sync_inventory` das contas **pesadas** (`vendas`/oben, `colacor_vendas`) processa SKUs em ordem e **morre aos 60s** no `timeout_milliseconds=60000` antes de terminar a conta.

1. **Schedule:** timeouts só em :00/:15/:30 (nunca :45/:05/:25). `:15` é exclusivo do `sync-inventory-colacor-vendas-1h`; `:25` (`servicos`) **nunca** estoura.
2. **Config:** os 3 crons `sync-inventory` têm `timeout_milliseconds=60000`; `servicos` (49 SKUs) retorna `200 {"totalSynced":49}` — completa dentro do limite.
3. **Efeito no dado (definitivo):** em `inventory_position`, `servicos` está 100% fresco (`min(updated_at)=max=01:25`), mas **`vendas` preso em 2026-05-25 (20 dias)** e **`colacor_vendas` em 2026-06-03 (12 dias)** — a passada atualiza só o começo da fila e morre antes do resto.

## Impacto (money-path-adjacente, severidade média)

`inventory_position.cmc` (Custo Médio Contábil) fica **defasado** nos SKUs do fim da fila → alimenta **NCG** (financeiro), **otimizador de compras** e o **preço de pedido cmc-first** (#669). Defasado ≠ ausente (há fallback p/ média quando `cmc<=0`), então não quebra a compra — usa custo velho. **Não é** incidente de plataforma (servicos completa) nem o motor de reposição (`sku_estoque_atual`/`sync_estoque` é caminho separado, mais fresco).

## Mitigação / ação pendente (founder — via Lovable)

1. **Curto prazo (cron, SQL Editor):** subir `timeout_milliseconds` 60000→150000 nos crons `sync-inventory-vendas-30m` e `sync-inventory-colacor-vendas-1h`. ⚠️ **NÃO é correção confirmada** — só ajuda se a edge não tiver budget interno próprio < 150s (o runtime do Supabase tem wall-clock limit). Testar antes de declarar resolvido.
2. **Correção real (edge, deploy via Lovable):** `omie-analytics-sync sync_inventory` precisa **paginar/cursor** (retomar de onde parou) ou rodar em **background via `EdgeRuntime.waitUntil`** — a mesma lição do `syncCustomers` (enumeração pesada do Omie não cabe no request síncrono). É money-path → cuidado/revisão (Codex) no fix.
3. **Confirmação:** ler os logs da edge `omie-analytics-sync` no Lovable (duração real + onde estoura).

## Como revalidar (read-only)

```sql
select account, min(updated_at), max(updated_at) from inventory_position group by account;
```
Resolvido quando `vendas`/`colacor_vendas` saírem de 2026-05-25/06-03 e o `min(updated_at)` ficar recente (cobertura fechou).

## Notas operacionais

- O join temporal `net._http_response × cron.job_run_details` **estoura** (a `job_run_details` é grande e sem índice em `start_time`) — a correlação foi feita por schedule + config + efeito, não por join. Vale um índice em `job_run_details(start_time)` se esse tipo de correlação virar rotina.
- Este registro é forward-compatible com o refactor do `CLAUDE.md` (frente 1): a lição durável vai pra `docs/agent/sync.md`; a narrativa, pra `docs/historico/sync.md`.
