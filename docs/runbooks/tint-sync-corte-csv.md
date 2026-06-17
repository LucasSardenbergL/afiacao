# Runbook — Corte do CSV do Tintométrico (faxina → re-scan → reconciliação → flip)

> Operação de **corte**: aposentar o CSV manual de catálogo e ligar o sync SayerSystem em tempo real.
> Gerado em 2026-06-16 (sessão `reverent-snyder`). Spec: `docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md` (§13–14).
> ⚠️ **money-path:** o **flip** (§Bloco B) é a operação de RISCO (precisão > recall). Só flipe após a reconciliação provar divergência ~zero (§3). Se o sync falhar silencioso em `automatic_primary`, o balcão mostra fórmula errada/faltando.

## 0. Estado de produção (diagnóstico 16/06 23:33 Brasília, via `psql-ro` read-only)

- `integration_mode = shadow_mode` — **seguro** (a promoção não roda; o balcão lê do oficial + preço via Omie).
- Conector **v0.1.7** (host `DESKTOP-BCTR6K6`), parado às 17:18 Brasília (**máquina desligada**). O **fix do loop (v0.2.0) está no PR #914 — DRAFT, não deployado**.
- `tint_staging_formulas`: **9,2 M linhas / 7 GB** · `tint_staging_formula_itens`: **32,8 M / 5,8 GB** → lixo do loop (full-scan permanente). Faxina = Bloco A.
- `tint_formulas` (oficial): **481.721 fórmulas, 0 desativadas** — íntegro. **O balcão NÃO depende do conector** (catálogo já no oficial; preço via Omie).
- Funções em prod ✅: `tint_promote_sync_run(uuid)`, `tint_run_reconciliation(uuid)`, `tint_apply_keys_snapshot(uuid)` (todas SECURITY DEFINER).
- **O flip já foi exercido em prod** (129 importações `tipo='sync_agent'`, última 16/06 11:54): a edge em prod **tem o gate de promoção e ela rodou sem dano aparente** (oficial íntegro). ⚠️ Mas rodou sobre o staging **poluído** → a **reconciliação limpa** (§3d) é o juiz final, não esse histórico.

## 1. Pré-requisitos (antes de iniciar o corte)

1. **PR #914 mergeado** na `main` (tirar do DRAFT → auto-merge no CI verde).
2. **`sayersync.exe` v0.2.0 buildado** — cross-compile `GOOS=windows GOARCH=amd64` **sem CGO** (procedimento no corpo do #914).
3. **Edge `tint-sync-agent` em PROD** — ✅ **já confirmado por evidência**: 129 promoções `sync_agent` rodaram em prod (última 16/06 11:54), logo o gate existe e funciona (`index.ts:397` `/catalogs`, `index.ts:542` `/formulas`). **Revalidar com `lovable-deploy-verify` só se a edge for redeployada** antes do flip.

> 🛡️ **Proteção barata até o v0.2.0:** o serviço `SayerSync` pode ficar **PARADO/desabilitado** sem nenhum impacto no balcão. **NÃO** religar o v0.1.7 (reenche o staging). Como a máquina está desligada, o risco é só amanhã ao abrir a loja — deixar o serviço em *startup manual* elimina o risco.

## 2. Sequência de corte (a ORDEM importa — anti-corrida)

Founder no balcão (PowerShell Admin) + SQL Editor do Lovable, na ordem, **antes de o v0.1.7 rodar um ciclo**:

1. **[Balcão]** `net stop SayerSync` — garantir parado (se a máquina acabou de ligar, parar **antes** do 1º ciclo).
2. **[Balcão]** Trocar o exe pelo **v0.2.0** (preserva `config.json`).
3. **[Balcão]** Apagar **`state.json`** (zera o high-water mark → força full re-scan) **E `hashes.json`** (senão o cache de hash acha que "já enviou tudo" e não reenvia nada).
4. **[Banco / SQL Editor]** Rodar o **Bloco A** (faxina). Conferir staging ~0.
5. **[Balcão]** `net start SayerSync`. 1º ciclo = full-scan: envia ~485k fórmulas **limpas** + popula `hashes.json`. Ciclos seguintes: só delta (~0) → **loop morto**.
6. Acompanhar **§3** (re-scan saudável + reconciliação ~zero).
7. Só então **Bloco B** (flip).

---

## Bloco A — Faxina do staging  ·  `🟣 Lovable → SQL Editor → cola → Run`

```sql
-- FAXINA: apaga ~12,8 GB de lixo do loop de re-envio.
-- Seguro: zero triggers nas staging; NENHUMA tabela oficial referencia staging
-- (FKs só staging→tint_sync_runs e filho→pai). TRUNCATE (não DELETE): instantâneo + libera disco.
BEGIN;
TRUNCATE TABLE
  tint_staging_formulas,
  tint_staging_formula_itens,
  tint_staging_produtos,
  tint_staging_bases,
  tint_staging_embalagens,
  tint_staging_skus,
  tint_staging_corantes,
  tint_staging_cores_catalogo,
  tint_staging_cores_personalizadas,
  tint_staging_preparacoes,
  tint_staging_preparacao_itens,
  tint_staging_precos_base
CASCADE;
COMMIT;
```

**Validação pós-faxina** (agora o `count` é instantâneo — tabela vazia):

```sql
SELECT 'formulas' AS t, count(*) FROM tint_staging_formulas
UNION ALL SELECT 'formula_itens', count(*) FROM tint_staging_formula_itens;
-- esperado: 0 e 0.
```

> Higiene opcional (separada, não-urgente): `tint_formulas_backup_preflip` (481.721 linhas / 103 MB) é resíduo do flip prematuro revertido. Pode ser `DROP`ada **depois** que o flip definitivo estabilizar — mantenha como rede até lá.

---

## 3. Validação pós re-scan (read-only — Claude roda via `psql-ro`, ou founder no SQL Editor)

```sql
-- (a) o loop morreu? runs/hora deve despencar (era ~400-510/h)
SELECT date_trunc('hour', started_at) AS hora, count(*) AS runs, sum(total_records) AS regs
FROM tint_sync_runs WHERE started_at > now() - interval '6 hours'
GROUP BY 1 ORDER BY 1 DESC;

-- (b) staging estabilizou em ~121k (fórmulas CRUAS; expandem ~4× p/ ~481k no oficial), não crescendo
SELECT count(*) FROM tint_staging_formulas;   -- esperado ~121k, ESTÁVEL entre ciclos (NÃO 9M)

-- (c) conector é v0.2.0 e heartbeat fresco
SELECT agent_version, last_heartbeat_at, now() - last_heartbeat_at AS idade
FROM tint_integration_settings WHERE store_code = 'M01';   -- esperado: 0.2.0

-- (d) reconciliação (rodar pela tela TintReconciliation → /tintometrico/integracao; resultado aqui)
SELECT started_at, status, total_compared, matches, divergences, only_csv, only_sync
FROM tint_reconciliation_runs ORDER BY started_at DESC LIMIT 3;
-- meta: divergences ~0 (ou explicadas = cores novas da Sayerlack desde o último CSV).
```

> ⚠️ A `tint_reconciliation_runs` formal só tem registros de **29/03** (testes iniciais, 9–36 comparações). A reconciliação de 12/06 (spec §13.2) foi **spot-check manual** — **rode a formal de novo** sobre o staging limpo (tela `TintReconciliation`) antes do flip.

---

## Bloco B — Flip → `automatic_primary`  ·  `🟣 SQL Editor` (só após §3 = divergência ~zero)

**Pré-condições — confirmar TODAS:**
- [ ] **migration `20260617130000_tint_promote_preserva_preco` aplicada em prod** — a promoção PRESERVA o preço (COALESCE); SEM ela o flip grava `preco_final_sayersystem=NULL` em tudo → subfatura ~19k cores (calc<CSV). Provada em PG17 + Codex (sem P1). Validar com a query do Bloco C.
- [ ] conector **v0.2.0** no heartbeat (§3c)
- [ ] **loop morto** (§3a: runs/hora baixo)
- [ ] **staging estável ~121k cru** (§3b)
- [ ] **reconciliação ~zero** (§3d)
- [ ] **edge `tint-sync-agent` em PROD** com o gate de promoção — ✅ já confirmado (129 promoções `sync_agent` rodaram; §0)

**B.1 — Flip** (`🟣 SQL Editor`, idempotente):
```sql
BEGIN;
UPDATE tint_integration_settings
SET integration_mode = 'automatic_primary', updated_at = now()
WHERE store_code = 'M01' AND integration_mode = 'shadow_mode';
-- ⚠️ deve afetar EXATAMENTE 1 linha. Se 0 → já flipado ou store errado: ROLLBACK e investigar.
COMMIT;
```

**B.2 — Forçar o re-envio** (⚠️ CRÍTICO — sem isto o flip não promove NADA). Com o hash, o conector
já enviou tudo e manda ~0/ciclo; a promoção processa só as chaves DO RUN (`WHERE sync_run_id=...`),
então sem dado novo ela não promove. Force um re-envio em `automatic_primary` — no balcão (Prompt Admin):
```cmd
net stop SayerSync
del "C:\SayerSync\hashes.json"
del "C:\SayerSync\state.json"
net start SayerSync
```
O 1º ciclo re-envia catalogs + as ~121k fórmulas em `automatic_primary` → cada run dispara
`tint_promote_sync_run` → o oficial é atualizado (151 cores novas entram; preço PRESERVADO). ~8 min.
(O staging cresce com o re-envio; a purga automática de 30d limpa o excedente.)

**B.3 — Validar** (read-only — Claude via psql-ro, ou founder no SQL Editor):
```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE preco_final_sayersystem IS NULL) AS sem_preco,
       count(*) FILTER (WHERE desativada_em IS NOT NULL) AS desativadas,
       max(updated_at) AS ult_update
FROM tint_formulas;
-- ⚠️ 'sem_preco' tem que continuar BAIXO (~0). Se disparar p/ centenas de milhares → a migration de
--    preço NÃO estava aplicada: REVERTER o flip (§4) e aplicar a migration antes. 'desativadas' pequeno.
```

**Blast-radius pós-flip** (a promoção tem guarda >20% das ativas OU snapshot <50% → ABORTA;
481.721 ativas → 20% ≈ 96.344): em B.3, `desativadas` perto disso = parar e investigar.

---

## Bloco C — Deploy da migration de preço (PRÉ-REQUISITO do flip) · `🟣 SQL Editor`

A migration `supabase/migrations/20260617130000_tint_promote_preserva_preco.sql` faz
`CREATE OR REPLACE` de `tint_promote_sync_run` com o `COALESCE` que preserva o preço. **Aplique
ANTES do flip.** Cole o conteúdo INTEIRO do arquivo no SQL Editor e Run (é a função set_based de
prod + 3 linhas de COALESCE; provada em PG17 `db/test-tint-promote-preserva-preco.sh` + Codex sem P1).

**Validação pós-apply** (read-only — confirma que a versão com COALESCE está no ar):
```sql
SELECT CASE WHEN pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure)
  LIKE '%COALESCE(EXCLUDED.preco_final_sayersystem%'
  THEN '✅ promoção preserva o preço (COALESCE no ar)'
  ELSE '❌ versão SEM COALESCE ainda no ar — NÃO flipar' END AS status;
```

## 4. Reversão (se algo der errado pós-flip)

```sql
-- volta ao modo seguro (a promoção para de rodar; balcão volta a depender só do oficial atual)
UPDATE tint_integration_settings SET integration_mode='shadow_mode', updated_at=now() WHERE store_code='M01';
-- rede: tint_formulas_backup_preflip preserva o oficial de antes do 1º flip (481.721 linhas).
```

## 5. Critério de pronto (spec §8.6)

Founder altera um preço no **Omie** → o balcão reflete (sync de produtos Omie ~2h). E altera uma **fórmula** no SayerSystem → o app reflete em ≤ ~15 min, **sem ação humana, sem CSV**.
