# PCP (Planejamento e Controle de Produção) — diário de entregas

Blueprint/spec: `docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md` (v3.2, Gate 0 tri-modelo fechado).
Planos por fase: `docs/superpowers/plans/`.

## Fase 1A — Malha Omie & Dados Mestres (2026-07-04)

**O que shipou** (código na `main`; deploy no Lovable é manual — ver pacote abaixo):
- **`db/pcp-f1a-m1-staging.sql`** (M1): `pcp_run_logs` + `pcp_malha_staging` (payload jsonb bruto, `sync_run_id NOT NULL`) com RLS staff-read fail-closed. Policies com `DROP IF EXISTS` (re-colar no SQL Editor é esperado).
- **`supabase/functions/omie-malha-sync/index.ts`**: edge que espelha a ESTRUTURA (malha) do Omie Colacor. Ação `probe` (trava o shape da API sem escrever) + `sync` (pagina `geral/malha` até página vazia, dedupe por página, upsert, limpeza de órfãos com guarda de plausibilidade, resume via `desde_pagina`). Trata `faultstring` do Omie (fim×erro×transitório).
- **`db/pcp-f1a-m2-nucleo.sql`** (M2): extração da malha (views `vw_pcp_malha_itens`/`_componentes`), parser dimensional (`fn_pcp_parse_dimensoes`), `pcp_itens` (`fn_pcp_refresh_itens`), destilação paramétrica da BOM por linha de abrasivo (`fn_pcp_destilar_bom` — mediana + regra global + MAD), validação (`vw_pcp_bom_validacao`), fila de exceções (`pcp_bom_excecoes` + `fn_pcp_materializar_excecoes` + helper `fn_pcp_dispor_excecao` staff-gated).
- **Provas PG17** (Lei de Ferro, com falsificação): `test-pcp-f1a-m1-staging.sh` (RLS, PASS=10), `test-pcp-parser-dimensoes.sh` (golden real, PASS=15), `test-pcp-f1a-destilacao.sh` (recupera os coeficientes do print KA169, PASS=31).

**Método:** subagent-driven-development em 3 lotes (A=M1, B=edge, C=M2+provas), cada um com revisão dupla (spec + qualidade). Painel tri-modelo (Claude+Codex+Gemini) sobre o plano ANTES do código (25 findings) + consulta pontual ao Codex na execução (base do catalisador ambígua).

**Bugs pegos na bancada (não chegaram à produção):**
1. **`CREATE POLICY` sem `DROP IF EXISTS`** → 2ª colagem no SQL Editor daria ROLLBACK (re-colar é rotina). [revisão de qualidade, Lote A]
2. **Edge ignorava `faultstring` do Omie** → erro/fim-de-paginação (HTTP 200+faultstring) viraria "página vazia" → **malha truncada reportada como "ok"**. [revisão de qualidade, Lote B]
3. **Limpeza de órfãos NULL-blind** (`.neq(sync_run_id)` não pega NULL) → fix na raiz: `sync_run_id NOT NULL`. [revisão de qualidade, Lote B]
4. **`NULL` sem cast em `UNION ALL`** na coluna `dispersao numeric` → função destila OK no CREATE mas **falha em runtime** (late-bound); revertia a destilação inteira. Fix: `NULL::numeric`. [prova PG17, Lote C]
5. **Gate de `fn_pcp_dispor_excecao` por `current_user`** → sob `SECURITY DEFINER` é o OWNER (postgres), furando o gate: **qualquer authenticated disporia exceção**. Fix: gatear por `auth.uid()`. [prova PG17 + revisão de qualidade, Lote C]
6. **`LIMIT 1` sem `ORDER BY`** na cola do pai → coef do catalisador **não-determinístico** com 2+ colas. Codex recomendou "não fabricar sob ambiguidade" → status `cola_ambigua` (exceção p/ revisão humana). [revisão de qualidade, Lote C]
7. **Fan-out** do fallback por `codigo` não-único (dobra a razão na mediana) → endurecido com `LATERAL`+`ORDER BY`+`LIMIT 1`. [revisão de qualidade, Lote C]
8. **MAD da regra global** media heterogeneidade legítima entre linhas → marcava linha rala como `regra_instavel` por construção. Fix: só marca instável regra de LINHA. [revisão de qualidade, Lote C]

**Lições reforçadas:** PL/pgSQL é late-bound (prova EXECUTANDO, não só criando); `SECURITY DEFINER` troca `current_user` pelo owner (gate por `auth.uid()`); negação PostgREST é NULL-blind (raiz: coluna NOT NULL); Omie sinaliza erro por HTTP 200+faultstring (nunca confiar só no status). Idioma do harness PG17: `Pq() { P -tA -q ...}` (o `-q` evita `SET` vazar na captura escalar de multi-statement).

**Pendente (founder):** deploy das 3 camadas no Lovable (M1 SQL Editor → edge no chat → probe → sync → M2 SQL Editor → refresh/destilar) + **gate de amostragem** da BOM destilada antes de qualquer consumo. Recorrência do sync (cron + frescor no Sentinela) fica para a Fase 2.
