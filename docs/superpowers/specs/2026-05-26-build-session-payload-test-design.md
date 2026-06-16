# Cobertura de teste do `buildSessionPayload` — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma (lane seguro/não-colidente). `src/lib/call-session/build-session-payload.ts` monta o payload de `farmer_calls.insert` ao fim de uma ligação — sem teste.

## Goal

Travar o cálculo de duração, o "lite" do transcript, a serialização e os defaults. Sem mudança de código.

## Regras (do código)

- `duration_seconds = ended - started` em segundos, arredondado; **negativo → 0**.
- `transcript` vira "lite": só `speaker/text/isFinal/startedAt` (dropa `id`/`endedAt`).
- `started_at`/`ended_at` → ISO.
- `entities_extracted = aggregateEntities(analyses)`; `analyses` passa cru.
- defaults: `call_type='venda'`, `call_result='atendeu'` (vendedor edita depois).
- passthrough: `farmer_id`, `customer_user_id`, `phone_dialed`, `call_backend`.

## Cenários

1. duração 150s + ISO; 2. duração negativa→0; 3. sub-segundo arredonda; 4. transcript lite (dropa id/endedAt); 5. `entities_extracted` do `aggregateEntities` (chamado com `analyses`); 6. passthrough de analyses + identificadores; 7. defaults venda/atendeu.

## Mock

- `vi.mock('../aggregate-entities')` → `aggregateEntities` retorna sentinela (isola do agregador, que tem teste próprio à parte).

## Testing

`src/lib/call-session/__tests__/build-session-payload.test.ts` (vitest). 7 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- `aggregateEntities` (mockado); o insert real no Supabase.
