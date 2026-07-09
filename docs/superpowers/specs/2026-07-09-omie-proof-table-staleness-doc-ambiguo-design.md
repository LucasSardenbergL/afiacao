# Proof-table `omie_customer_account_map` — staleness (P1a) + doc-ambíguo-no-Omie (P1b) — design

> **money-path** (identidade de cliente → Customer360/reposição). 2 débitos **PRÉ-EXISTENTES** do algoritmo `syncCustomers`, levantados pela 2ª opinião Codex durante o PR #1260 (crons de `sync_customers` p/ colacor_vendas/servicos). NÃO introduzidos pelo #1260. Conduzido por Claude + `/codex consult high` (convergiu; parecer cru registrado na §7). Deploy PENDENTE do founder.

## 1. Problema (2 débitos do `syncCustomers`)

`syncCustomers` (`supabase/functions/omie-analytics-sync/index.ts:282-430`) popula a proof-table aditiva `public.omie_customer_account_map` (Fatia 3 do fix de rótulo — spec `2026-07-07-espelho-omie-rotulo-por-conta-design.md`), fonte account-correta de identidade Omie por conta. Roda **por conta** (`vendas`→oben, `colacor_vendas`→colacor, `servicos`→colacor_sc), casa **document-first** (`profiles.document` → `user_id`), e faz **upsert-only** `onConflict(user_id, account)`.

- **P1a — STALENESS: a proof-table nunca invalida row órfã.** Upsert-only nunca deleta/invalida linhas de clientes que sumiram do Omie, trocaram de documento, ou cujo código foi reatribuído a outro dono. Um vínculo `(user_id, account, omie_codigo_cliente)` obsoleto vive para sempre como verdade. Os consumidores confiam em **qualquer** row existente sem checar frescor: `useCustomerPreferredItems` (`hooks.ts:104-107`) lê só por `user_id`; `compare-customer-process` (`:229-234`, `:282-286`) idem. Viola "ausente ≠ zero" (serve dado stale como fresco).

- **P1b — DOCUMENTO DUPLICADO no lado Omie (last-write-wins silencioso).** O lado **profile** é fail-closed p/ documento ambíguo (`fetchProfileDocUserMap:270-274`: 2 profiles/users distintos no mesmo doc → removido do mapa). O lado **Omie NÃO**: se 2 registros Omie **distintos** (códigos diferentes) na **mesma conta** compartilham o mesmo doc normalizado → ambos resolvem para o mesmo `userIdByDoc` → `accountMapByUser.set(userIdByDoc, ...)` (`:348-355`) **sobrescreve** — o último da paginação vence, gravando um `omie_codigo_cliente` arbitrário. Customer360 então busca itens preferidos do **par errado** (código ERRADO, não só stale).

Ambos valem p/ as **3 contas** da proof-table.

## 2. Estado atual (evidência psql-ro, produção, 2026-07-09)

- Tabela **populada e consumida**: colacor 5156, colacor_sc 5275, oben 5238 linhas — todas `source='document'`, todas `updated_at` de hoje 05:00-05:40 UTC. Deploy da Fatia 3 + crons do #1260 já rodaram.
- Crons **DIÁRIOS**: `sync-customers-vendas-daily` 05:00, `-colacor-vendas-daily` 05:20, `-servicos-daily` 05:40. Runs completam limpo (sem cauda de timestamp velho).
- **Sem trigger** na tabela (`pg_trigger` = 0) → `updated_at` é 100% controlado pelo writer.
- **15669/15669 linhas** têm `updated_at > created_at + 1min` → o writer **comprovadamente refresca `updated_at` a cada run** que vê a linha. `updated_at` já **é**, factualmente, o `last_seen_sync_at`.
- Consumidores de LEITURA da proof-table: exatamente **2** (`hooks.ts` `useCustomerPreferredItems` + `compare-customer-process`) + 1 writer. Superfície pequena.

## 3. Design P1a — view fresca (frescor no relógio do banco)

**Reusar `updated_at` como `last_seen_sync_at`** (§2 prova que já o é) — sem coluna nova, sem tocar o writer p/ P1a. **Contrato explícito** (documentado aqui e no código): `updated_at` desta tabela = "última vez que o sync viu a linha no Omie". Válido enquanto o **sync (edge service_role) for o único writer**. Se surgir 2º writer / edição manual (`source='manual'`), promover a coluna dedicada `last_seen_sync_at` (não antes — YAGNI; Codex concordou, P2).

**View `omie_customer_account_map_fresco`** — os 2 consumidores leem a view, não a tabela. A invariante de frescor vive **perto do dado** (não duplicada na UI) e usa `now()` do **Postgres** (elimina clock-skew de `new Date()` no browser — furo 6d do Codex):

```sql
-- ⚠️ DESTINO: SQL Editor do Lovable. NÃO auto-aplica. NÃO vai em supabase/migrations/.
CREATE OR REPLACE VIEW public.omie_customer_account_map_fresco
WITH (security_invoker = true) AS
SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
FROM public.omie_customer_account_map
WHERE updated_at >= now() - interval '7 days';

GRANT SELECT ON public.omie_customer_account_map_fresco TO authenticated;
-- anon NÃO (espelha a tabela base — anon nunca vê).
```

- **`security_invoker = true`** é obrigatório: a view roda com os privilégios do CHAMADOR → a **RLS da tabela base se aplica** (staff ALL, user vê próprio). Sem isso, a view rodaria como owner e **bypassaria RLS** (vazamento). Edge (`service_role`, BYPASSRLS) vê todas as frescas; front staff vê todas as frescas; customer veria só a própria.
- **Threshold: 7 dias** (constante de produto, não env). Cron diário → 7 runs de folga; o `data_health_watchdog` grita "sync parado" muito antes de 7d. `30d` (minha proposta inicial) é folgado demais p/ money-path — Codex corrigiu (P2), aceito. Consistência garantida por ser **um único ponto** (a view).
- **Sem índice novo**: os consumidores filtram por `user_id` (idx_ocam_user) ou `(codigo,account)` (uq_ocam_codigo_account) e o frescor recai sobre as poucas linhas resultantes.

**Auto-cura / fail-safe:** o writer nunca deleta p/ P1a. Um run parcial (ex.: Omie mentindo `total_de_paginas` — alerta do CLAUDE.md) só deixa de refrescar algumas linhas; o próximo run completo as revive. Sync inteiro parado → tudo expira junto em 7d (degradação honesta acoplada ao frescor). **Zero risco de colapso de mapa** (contraste com delete-ativo, rejeitado — Codex §2).

## 4. Design P1b — fail-closed no doc-dup-Omie + **delete cirúrgico** do vínculo pré-existente

Espelhar o fail-closed do lado profile no lado Omie, **por conta**, dentro do run. **Furo P1 do Codex (6a):** "só não upsertar" NÃO fecha o P1b — deixa a linha antiga (código do last-write-wins) viva até o TTL expirar (7d). Fail-closed **de verdade** exige invalidar o `(user_id, account)` ambíguo **imediatamente**.

**Helper puro** (testável) — detecção nomeada, calculada 1× no laço:

```ts
// src/lib/omie/omie-doc-ambiguo.ts (+ espelho verbatim no edge, paridade textual no CI)
/** Docs que aparecem em 2+ registros Omie com códigos de cliente DISTINTOS na MESMA conta
 *  (ambíguos → não provam identidade). Espelha o fail-closed do lado profile (Codex P1b). */
export function docsComCodigoAmbiguoNoOmie(
  registros: Array<{ doc: string; codigo: number }>,
): Set<string> {
  const codigosPorDoc = new Map<string, Set<number>>();
  for (const r of registros) {
    if (!r.doc) continue;
    const s = codigosPorDoc.get(r.doc) ?? new Set<number>();
    s.add(r.codigo);
    codigosPorDoc.set(r.doc, s);
  }
  const ambiguos = new Set<string>();
  for (const [doc, cods] of codigosPorDoc) if (cods.size > 1) ambiguos.add(doc);
  return ambiguos;
}
```

**Integração no `syncCustomers`** (ordem):
1. No laço de paginação, acumular `registrosOmie: {doc, codigo}[]` (além do que já faz).
2. Após o laço: `ambiguos = docsComCodigoAmbiguoNoOmie(registrosOmie)`. Para cada doc ambíguo: `uid = userByDoc.get(doc)` → (a) `accountMapByUser.delete(uid)` (não grava código errado novo) + (b) coletar `uid` em `usersAmbiguosParaDeletar`.
3. Upsert `accountMapByUser` (linhas boas) — como hoje.
4. **DELETE cirúrgico** do vínculo pré-existente: `db.from('omie_customer_account_map').delete().eq('account', empresaMap).in('user_id', [...usersAmbiguosParaDeletar])` (chunk se necessário; ambíguos são raros). Fecha o furo P1.
5. **Log** (furo 6b): contagem de docs ambíguos + amostra **sanitizada** (doc mascarado, ex.: `***`+4 últimos dígitos) — fail-closed perde recall (matriz/filial, duplicata legítima); observabilidade sem PII em texto plano.

**Segurança do delete (≠ delete-ativo do P1a):** escopado a users **comprovadamente ambíguos NESTA conta**, não "tudo que não vi". Run parcial → vê menos ocorrências → detecta **menos** ambiguidades → deleta **menos** (fail-safe na direção certa). Conjuntos disjuntos: um user ou é bom-e-upserted, ou é ambíguo-e-deletado (sem conflito entre passos 3 e 4). Auto-cura: doc deixa de ser ambíguo no Omie → user re-mapeado no próximo run.

**Escopo:** só a proof-table (`accountMapByUser`). O espelho legado `omie_clientes`/`upsertByUser` (só `vendas`, CODE-FIRST, doc é fallback) **NÃO** é tocado — dívida consciente, aposentado na Fatia 4 (Codex §5, P2; nomeado p/ não parecer que o sistema todo virou fail-closed).

## 5. Consumidores que migram (view)

- `src/components/customer360/hooks.ts` `useCustomerPreferredItems`: fonte `omie_customer_account_map` → `omie_customer_account_map_fresco` (1 linha; select/`.eq('user_id')` idênticos).
- `supabase/functions/compare-customer-process/index.ts`: 2 pontos (segment lookup `:229`, reverse-map lookalikes `:282`) trocam a fonte p/ a view.
- `src/integrations/supabase/types.ts`: adicionar a view (o front tipa `.from('...')`).

## 6. Prova (gate)

- **`prove-sql-money-path` (PG17 + falsificação)** — estender `db/test-omie-customer-account-map.sh`:
  - Aplicar a view real. Seed: linha **fresca** (`updated_at=now()`) + linha **velha** (`now()-10d`).
  - Assert +: view retorna só a fresca; a tabela base retorna ambas.
  - Assert RLS na view (`SET ROLE authenticated` + GUC): user vê só a própria fresca; staff vê todas frescas; anon 0.
  - **Falsificação**: (1) view sem o `WHERE updated_at` → a velha aparece → vermelho; (2) `security_invoker=false` → user vê linha de outro → vermelho.
- **vitest (helper puro)** `docsComCodigoAmbiguoNoOmie`: casos +/− (1 doc/1 código → ø; 1 doc/2 códigos → ambíguo; mesmo código 2× → ø; doc vazio ignorado) + **falsificação** (helper que retorna `∅` sempre → teste vermelho). Paridade textual src↔edge no CI (MIRROR-START/END).
- **typecheck + test + lint**.

## 7. Decisões (Codex consult high, 2026-07-09)

Parecer cru arquivado (transporte `scripts/codex-async.sh`). **Convergiu com a direção**; 4 refinamentos aceitos (1 crítico):

- **(6a, P1 — ACEITO, crítico):** P1b precisa **deletar o vínculo pré-existente ambíguo**, não só "não upsertar" — senão a linha antiga vive até o TTL. → §4 passo 4 (delete cirúrgico).
- **(4/6d/6e, P2 — ACEITO):** centralizar frescor numa **view** (não filtro duplicado nos 2 consumidores). Argumento decisivo: `now()` do banco elimina clock-skew do browser + threshold único. → §3.
- **(3, P2 — ACEITO):** threshold **7d**, não 30d (cron diário; money-path pende p/ precisão). → §3.
- **(6b, P2 — ACEITO):** logar contagem + amostra sanitizada da ambiguidade Omie (fail-closed perde recall). → §4 passo 5.
- **(1, P2 — ACEITO com contrato):** reusar `updated_at` agora; coluna dedicada só com 2º writer. → §3.
- **(5, P2 — ACEITO):** P1b só na proof-table (dívida consciente, Fatia 4). → §4.

### Codex challenge do diff (2026-07-09, high) — 8 achados, 4 corrigidos no código

- **[item 1/7, P2 — CORRIGIDO]** Ordem/atomicidade: o DELETE cirúrgico rodava DEPOIS do upsert → se o upsert lançasse (colisão), o delete não rodava. → **delete-first**: o DELETE agora roda ANTES do upsert (remove o código errado antes de gravar o bom; falha do upsert não deixa o errado vivo).
- **[item 3, P2 — CORRIGIDO]** O DELETE apagaria uma linha `source='manual'` (override humano). → `.eq('source','document')` no delete (só remove o que o sync gravou; preserva correção manual).
- **[item 4, P3 — CORRIGIDO]** A view não concedia SELECT a `service_role` → o edge `compare-customer-process` cairia em permission denied e degradaria silencioso. → `GRANT ... TO ... service_role` + assert V8 no PG17.
- **[item 8, P3 — CORRIGIDO]** CI não pegava a preservação de `manual`. → assert textual `.eq("source","document")` no delete.
- **[item 5, P3 — contrato]** `updated_at` só é last_seen enquanto o sync for o único writer (edição manual furaria). Já é o contrato documentado (§3).
- **[item 6, P2 — comportamento desejado]** Sync parado > 7d → a conta some da view (Customer360 `[]`, compare sem segmento). É degradação honesta; o **alerta de "sync parado" é do `data_health_watchdog`** (canal dedicado), não do consumidor.
- **[item 2, P3 — TTL é o backstop]** Se um doc ambíguo não resolve `userByDoc` (profile mudou de doc/foi apagado), o delete não acha o user → a linha antiga não é removida; o **frescor (7d) é o backstop** desse canto.

**[item extra do challenge, P1 — RESÍDUO PRÉ-EXISTENTE, fora de escopo → decisão do founder]**
Para `account='vendas'`, o MESMO doc-dup-Omie ainda grava código arbitrário no **espelho legado `omie_clientes`** (`upsertByUser`), que tem leitores legados ativos (sync_pedidos, carteira-rebuild, ai-ops-agent). NÃO fechado aqui, de propósito: (a) a tarefa foi escopada à proof-table; (b) o design da Fatia 3 manda o espelho **INTOCADO** (sem delete/re-rótulo); (c) o espelho é **CODE-FIRST** — remover cegamente o user ambíguo teria **falso-positivo** (um vínculo resolvido por CÓDIGO, confiável, não é invalidado por doc ambíguo); (d) o fix seria **incompleto** (outros writers do espelho — `omie-cliente`, `omie-sync`, `Auth` signup — também gravam por doc). Fechamento correto = **Fatia 4** (aposenta o espelho e migra o pedido p/ a proof-table). Elevado à visibilidade do founder.

**Resíduos conscientes** (documentados, fora de escopo destes 2 débitos):
- **Reatribuição de código pura** (doc NÃO-ambíguo, código muda de dono) ainda pode abortar um chunk de upsert no `uq_ocam_codigo_account` (P2 pré-existente do design da Fatia 3). Visível: o upsert lança → `sync_state.status='error'` → `data_health_watchdog`. Não resolvido aqui (exigiria run-ledger; escopo Fatia 4).
- **P1b não tocado no espelho `omie_clientes`** (ver [item extra] acima; Fatia 4 o aposenta).

## 8. Deploy (ordem — aditivo, cada passo fail-safe)

1. **Migration da view** (SQL Editor do Lovable) — aditiva; ninguém lê ainda.
2. **Edge** `omie-analytics-sync` (P1b) + `compare-customer-process` (view) — deploy pelo chat do Lovable (verbatim do repo).
3. **Publish frontend** (`hooks.ts` lê a view) — só funciona após passo 1.
4. **Validar** (psql-ro): `omie_customer_account_map_fresco` existe, `security_invoker=on`, contagem fresca ≈ tabela; próximo run do sync não muda outcomes (guard de borda, não regressão).

Aditivo: view ausente → o front tiparia erro (por isso a ordem); mas nenhum passo corrompe dado. P1b endurece o writer sem quebrar casamento legítimo (só remove ambíguo provado).

## 9. Fatiamento (PR)

1 PR coeso (os 2 débitos são pequenos e relacionados) com **ordem de deploy explícita** no corpo: migration da view → edge → Publish. Auto-merge (squash) no CI verde. `db/omie_customer_account_map_fresco.sql` (view) + harness estendido + helper+teste + 3 consumidores (hooks, compare, types).
