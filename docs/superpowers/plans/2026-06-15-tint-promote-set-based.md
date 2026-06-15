# Plano — reescrever a promoção tintométrica para set-based (eliminar timeout/lock no bootstrap)

> ✅ **IMPLEMENTADO 15/06 (Opção A).** Migration `20260615160000_tint_promote_set_based.sql`
> (CREATE OR REPLACE da `tint_promote_sync_run` — só o motor E2/E3 virou set-based; advisory lock,
> latest-staging, E1, E4 recalc e E5 purge ficaram VERBATIM). `statement_timeout='300s'` movido p/ o
> cabeçalho da função (CREATE OR REPLACE descartaria o ALTER de 20260615140000). Validado em PG17
> `db/test-tint-promote.sh`: os 12 cenários antigos (C1-C12) passam inalterados + **CENÁRIO 13** de
> VOLUME que roda o **loop antigo preservado** (RENAME → `tint_promote_sync_run_oldloop`) e o set-based
> sobre o MESMO seed (600 expansões, mix NULL-honesto + subcoleção) e exige **EXCEPT=0 nos dois sentidos**
> (identidade contábil) + **falsificação** (F1 NULL-honesto furado → 720 divergências; F2 fator=1 →
> 1920 divergências; restauração → 0). Tempo no teste: set-based ~180ms vs loop ~250ms (o ganho explode
> em 481k: o loop é O(linhas) com subqueries por linha → estoura o gateway; o set-based são ~10
> operações em lote). PR: `claude/tint-promote-set-based`. **Falta só o re-flip** (roteiro no fim).
>
> **Re-flip (founder, quando quiser):** 1) Aplicar `20260615160000` no SQL Editor (pode ser em shadow —
> só troca a função, não roda nada). 2) Pré-flight opcional (de-risca): `BEGIN; SELECT
> tint_promote_sync_run('<run formulas recente>'); ROLLBACK;` com `clock_timestamp()` → prova que roda
> rápido em dados REAIS sem commitar nada. 3) Flip: `sc stop` → apagar `state.json` → `automatic_primary`
> → `sc start` → BLOCO 4 (`publicadas_30min` alto). 4) CSV aposentado.



## Contexto / diagnóstico (15/06, flip ao vivo)
- Sync validado 100% (corantes 14/14, cores 8238, bases 56, emb 4, produtos 20, regra de 3 exata, blast 3,2%).
- Flip pra `automatic_primary` revelou bug de PERFORMANCE na `tint_promote_sync_run`:
  1. 1ª manifestação: `statement timeout` (57014) → **resolvido em parte** com índices
     (`20260615140000_tint_promote_indices_timeout.sql`: idx em `tint_staging_formula_itens(staging_formula_id)`
     etc. + `ALTER FUNCTION ... statement_timeout='300s'`). Os índices FICAM (ajudam o delta também).
  2. 2ª manifestação (pós-índices): `lock timeout` + `upstream request timeout`. Causa: a promoção
     ainda demora > timeout do GATEWAY (~30-60s) no full re-scan; o conector dá retry; as invocações
     concorrentes brigam pelo `pg_advisory_xact_lock` → lock timeout em cascata → sobrecarga.
- **Estado estabilizado**: revertido pra `shadow_mode` (travado no banco) + 251 cores reativadas
  (`UPDATE tint_formulas SET desativada_em=NULL`). Oficial = CSV puro (481.721 ativas). Venda 100% normal.
  `tint_formulas_backup_preflip` existe como rede.

## Causa-raiz
`tint_promote_sync_run` seção E2/E3: `FOR r IN _formulas_latest LOOP` (cada fórmula) → inner
`FOR v_emb_id,v_fator IN (embalagens vendáveis) LOOP` → por iteração: lookup produto/base, ensure
subcoleção, `tint_calc_preco_final` (subqueries), upsert `tint_formulas`, delete+insert
`tint_formula_itens`. É O(fórmulas × embalagens) PROCEDURAL. Pro bootstrap (~121k fontes → ~481k
expansões) é inviável dentro de um request. Foi desenhada pra DELTAS pequenos (poucos pares/cores).

## Solução
Trocar o motor da seção E2/E3 por **set-based** (mantendo TODA a regra de negócio idêntica):
1. `_expand` = `_formulas_latest` ⨝ `tint_skus` (vendáveis: `volume_ml>0`) ⨝ `tint_embalagens`
   → 1 linha por (fórmula, embalagem destino) com `fator = e.volume_ml / volume_final_ml`. Set-based.
2. Resolver FK produto/base via join (não SELECT por linha). Pares sem produto/base/zero-vendáveis/
   volume<=0 → logar em `tint_sync_errors` em massa (INSERT...SELECT dos descartados) — preserva a
   degradação honesta atual.
3. Preço set-based: `tint_calc_preco_final` vira um CTE agregado (base × imposto × margem + Σ
   corantes ⨝ staging por fator). **NULL-honesto preservado**: faltou custo/precos_base → NULL
   (nunca 0). Hoje `precos_base` vazio → preço NULL em tudo (correto; venda usa Omie).
4. Upsert `tint_formulas` em massa: `INSERT...SELECT FROM _expand ON CONFLICT (chave) DO UPDATE`
   (mesma uq_tint_formulas_chave; `desativada_em=NULL` reativa).
5. Itens em massa: após upsert, `DELETE ... WHERE formula_id IN (afetadas)` + `INSERT...SELECT`
   join `_expand` × `tint_staging_formula_itens` × `tint_corantes` (resolve corante_id). Em massa.
6. Manter S1 (advisory lock), soft-delete (keys-snapshot) e o E4 (recalc por insumo) — só o motor de
   fórmulas muda.

## Decisão de arquitetura a confirmar na implementação
- **Opção A (preferida):** reescrever a seção E2/E3 da própria `tint_promote_sync_run` set-based →
  cada chamada por lote fica rápida (cabe no gateway) → o flip volta a funcionar pelo fluxo normal.
- **Opção B (fallback):** função `tint_promote_bootstrap(account,store)` separada (promove TODOS os
  pares de uma vez, set-based), rodada 1× pelo founder no SQL Editor pra carga inicial; depois o
  delta diário usa a função atual. Menor risco (não toca o caminho do delta) mas exige passo manual.
  → Decidir A vs B no início da implementação (provável A, com o oráculo TS atualizado).

## Validação (obrigatória — money-path)
- Helper TS `src/lib/tint/sync-promote.ts` é o oráculo — manter espelhado.
- PG17 `db/test-tint-promote.sh` (já existe, 17 grupos C1-C12b): re-rodar + adicionar cenário de
  VOLUME (centenas de fórmulas × N embalagens) provando que o set-based dá o MESMO resultado do loop
  (identidade contábil) e roda rápido.
- Reconciliação: após re-flip, `BLOCO 4` deve mostrar `publicadas_30min` alto + cores novas entrando.
- Codex adversarial (se cota disponível) no diff SQL antes de aplicar.

## Rollout
1. Aplicar migration nova (CREATE OR REPLACE da função) no SQL Editor.
2. `sc stop` → apagar `state.json` → trocar pra `automatic_primary` → `sc start` (full re-scan limpo).
   Promoção set-based publica em segundos.
3. `BLOCO 4` confirma. Critério de pronto: altera preço/fórmula no SayerSystem → app reflete ≤15 min.
4. CSV aposentado.

## Nota
Esta sessão (15/06) ficou MUITO longa (dia inteiro de flip). A IMPLEMENTAÇÃO da função (money-path)
deve ser feita com contexto fresco (/compact ou nova sessão) pra evitar erro. Os índices já estão no
ar; o balcão está seguro em shadow. Sem pressa.
