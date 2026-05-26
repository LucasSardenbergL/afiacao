# Mix/Gap — loop de conversão (ofertado / convertido / recusado)

> **Status:** design aprovado (founder + Claude/Codex), 2026-05-26. Próximo: writing-plans.
> **Programa:** Carteira-Omie. Continuação do Mix/Gap (RPC `get_meu_mixgap`).

## Problema

O Mix/Gap mostra ao vendedor clientes da carteira sem uma família que clientes parecidos compram (oportunidade de cross-sell). Hoje é **read-only**: o vendedor não tem como dizer o que fez com a oportunidade, então (a) ele vê a mesma sugestão pra sempre (mesmo depois de ofertar/vender/levar não), e (b) a gente não mede se o Mix/Gap **converte**.

## Objetivo (v1)

Deixar o vendedor marcar cada oportunidade (cliente × família faltante) como **ofertado / convertido / recusado**, e usar isso pra **(a) suprimir** o que não deve mais incomodar e **(b) capturar o sinal** (taxa ofertado→convertido, medível no PostHog). **Não** mexe nas regras de associação (decisão: escopo "suprimir + capturar", não ML).

## Decisões cravadas

| Decisão | Escolha | Origem |
| --- | --- | --- |
| Escopo do "alimentar o motor" | **Suprimir + capturar** (não re-pesar regras) | founder |
| `ofertado` | **Fica** na lista, com selo "ofertado" (opp aberta, lembra follow-up) | founder |
| `convertido` | **Some pra sempre** (vendeu) | founder |
| `recusado` | **Some por 90 dias**, depois pode reaparecer | founder |
| Supressão | **No servidor** (dentro da RPC), não só no cliente | Claude (verdade de servidor) |
| Write durante impersonação | **Bloqueado** (impersonação é read-only) | herdado do view-as |

## Não-objetivos (YAGNI v1)

- **Auto-detectar conversão** pelo sync do Omie (o gap já some sozinho quando o cliente compra a família — a RPC exclui famílias já compradas).
- **Re-pesar/re-rankear as regras** de associação por conversão (opção ML descartada pelo founder).
- Feedback fora do `MixGapCard` (só onde os gaps aparecem).

## Arquitetura

### 1. Migration (1 bloco via SQL Editor — sem edge function)

**Tabela `farmer_mixgap_feedback`:**
- `id uuid PK default gen_random_uuid()`
- `seller_user_id uuid NOT NULL` (dono que marcou — sempre `auth.uid()`)
- `customer_user_id uuid NOT NULL`
- `familia text NOT NULL`
- `status text NOT NULL CHECK (status IN ('ofertado','convertido','recusado'))`
- `created_at timestamptz NOT NULL default now()`
- `updated_at timestamptz NOT NULL default now()`
- `UNIQUE (seller_user_id, customer_user_id, familia)`
- RLS: SELECT = `seller_user_id = auth.uid() OR has_role(auth.uid(),'master')`; INSERT/UPDATE = `seller_user_id = auth.uid()`. (Master lê tudo pra análise; só o dono escreve.)

**RPC `mark_mixgap_feedback(p_customer uuid, p_familia text, p_status text)`** — `SECURITY DEFINER`, `SET search_path=public`:
- Gate: `IF NOT (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee')) THEN RAISE EXCEPTION 'forbidden'; END IF;`
- Valida `p_status IN ('ofertado','convertido','recusado')` senão `RAISE`.
- `INSERT INTO farmer_mixgap_feedback (seller_user_id, customer_user_id, familia, status) VALUES (auth.uid(), p_customer, p_familia, p_status) ON CONFLICT (seller_user_id, customer_user_id, familia) DO UPDATE SET status = EXCLUDED.status, updated_at = now();`
- `seller_user_id = auth.uid()` **sempre** (nunca do cliente). `GRANT EXECUTE TO authenticated`.

**Modificar o internal `_carteira_mixgap_for_owner(p_owner)`** (compartilhado por `get_meu_mixgap` e `get_meu_mixgap_for`):
- Adicionar CTE `feedback` = linhas de `farmer_mixgap_feedback` com `seller_user_id = p_owner`.
- No `gaps`/`top1`: **excluir** `(customer_user_id, familia)` onde existe feedback com `status='convertido'` OU (`status='recusado'` AND `updated_at > now() - interval '90 days'`).
- No objeto retornado por cliente: incluir `'feedback_status'` = o status quando `'ofertado'` (senão null) — pro selo.
- ⚠️ A chave do feedback é `familia` (= `familia_faltante`), consistente com o gap. Reusa o `p_owner` (escopo do dono) → view-as vê os selos/supressão do alvo, read-only.

### 2. Hook `useMarkMixGapFeedback` (client)

`useMutation` chamando `mark_mixgap_feedback(p_customer, p_familia, p_status)` (cast no boundary, RPC fora dos tipos gerados). **Optimistic** (padrão `SalesOrders.deleteOrder`):
- `onMutate`: cancela `['my-mixgap']`, snapshot, edita o cache — `convertido`/`recusado` removem a linha; `ofertado` seta `feedback_status='ofertado'` na linha + ajusta `totalComGap` se remover.
- `onError`: rollback pro snapshot.
- `onSettled`: `invalidateQueries(['my-mixgap'])`.
- Dispara evento `track('carteira.mixgap_feedback', { status })`.
- **Nunca usa `effectiveUserId`** — o write é `auth.uid()` na RPC (passa no guard `no-write-leak`).

### 3. UI — `MixGapCard`

Cada linha ganha, à direita, um **menu `⋯`** (`DropdownMenu` do shadcn) com 3 itens: **Ofertado · Convertido · Recusado**. O clique no menu usa `e.preventDefault()/stopPropagation()` pra **não** disparar o `<Link>` (navegação ao 360). Selo **"ofertado"** na linha quando `feedback_status==='ofertado'`. O menu fica **desabilitado quando `useImpersonation().isImpersonating`** (impersonação read-only) — com `title` explicativo.

### 4. Types

`GapCliente` (em `src/lib/mixgap/types.ts`) ganha `feedback_status?: 'ofertado' | null`.

## Fluxo de dados

```
Vendedor no FarmerCalls → MixGapCard lista os gaps (get_meu_mixgap, já filtrando convertido/recusado<90d)
  → clica ⋯ numa linha → "Convertido"
      → useMarkMixGapFeedback: onMutate remove a linha do cache (optimistic) + track(status)
      → RPC mark_mixgap_feedback(customer, familia, 'convertido') [seller=auth.uid(), upsert]
      → onSettled invalida ['my-mixgap'] → refetch confirma (a linha não volta: RPC exclui convertido)
  → "Ofertado" → linha fica com selo "ofertado"; "Recusado" → some por 90 dias
Master impersonando Regina → vê os selos/supressão DELA (read-only); menu ⋯ desabilitado.
```

## Segurança

- **Write sempre via RPC com `seller_user_id = auth.uid()`** — nunca client-provided, nunca `effectiveUserId`.
- Supressão **escopada ao dono** (`p_owner`) — consistente com view-as; master impersonando vê o feedback do alvo, read-only (menu desabilitado).
- RLS: dono escreve só o próprio; master lê tudo (análise).
- **Codex review** no gate (`mark_mixgap_feedback` + a modificação do internal) antes do merge.
- Guard `no-write-leak` segue verde (o hook de mutação não referencia `effectiveUserId`).

## Testing

- **TDD nos puros:** se extrair um helper de optimistic-update do cache (`applyFeedbackToMixGap(cache, customer, familia, status)`), testá-lo (ofertado→selo, convertido/recusado→remove, decrementa total). 
- **RPC:** validação no rollout — marcar via RPC e conferir que o gap some (convertido/recusado) / ganha selo (ofertado); confirmar que `seller_user_id` gravou `auth.uid()`.
- **Contrato preservado:** `get_meu_mixgap` sem feedback retorna igual a hoje (a CTE de feedback é LEFT/anti-join — sem linhas de feedback, nada muda).

## Rollout (Lovable)

1 migration (SQL Editor): `farmer_mixgap_feedback` + RLS + `mark_mixgap_feedback` + `CREATE OR REPLACE` do internal `_carteira_mixgap_for_owner`. **Sem edge function.** Validação: marcar um gap de teste e conferir supressão/selo. Front-end via deploy normal do Lovable.

## Riscos / decisões em aberto

- **Colisão no `_carteira_mixgap_for_owner`**: é o internal do view-as (na main). Modificá-lo é `CREATE OR REPLACE` — conferir que o corpo atual (da migration `20260525210000`) é a base, e só adicionar a CTE de feedback + os filtros. Entregar o internal completo no bloco.
- **`familia` como chave**: o feedback casa por `(customer, familia)`. Se a mesma família reaparecer por outra regra, o feedback continua valendo (é por família, não por regra) — correto pro comportamento desejado.
- **Optimistic + `totalComGap`**: ao remover uma linha, decrementar `totalComGap` no cache pra o header não piscar; o refetch reconcilia.
