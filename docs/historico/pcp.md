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

**Deploy executado (2026-07-04):** M1 aplicado ✓ · edge deployada ✓ · probe ✓ (shape real do Omie: lista em `produtosEncontrados`, itens em `itens`, pai em `ident.idProduto`, componentes com chaves diretas SEM sub-`ident` — o M2 lê por fallback `i->>'...'`) · sync ✓ (**41 páginas, 2011 produtos, 6732 componentes, shape_err=0**; cobertura: 1404 cintas de 1405, ~249 discos, 111 tingidores). Verificação empírica: `comp_sem_id=0 de 6732`.

**Achados dos dados reais (corrigidos ANTES de aplicar o M2):**
- **Modelo da FITA estava errado** — eu assumira aditivo (`largura/10 + overlap`); os dados provam **proporcional** (`coef × largura`, ~0.1125 cm/mm constante em 29 larguras; overlap aditivo varia 0.3–2.9). Corrigido (método `cm_por_mm_largura`); valida **96.1% das 1378 fitas** dentro de ±5% global. Cola/catalisador/abrasivo confirmados certos (cola ~0.0105 g/mm, catalisador 0.1111×cola, abrasivo área nominal exata).
- `custoProducao {vGGF,vMOD}` vem embutido em cada produto da malha → validação cruzada de custo (§1.12) fica de graça na Fase 2.

**Refinos anotados p/ Fase 2:** nomear `produtosEncontrados` no `extractLista` do edge (hoje pega por fallback determinístico); cron + frescor no Sentinela; limpar candidatos `i->'ident'` mortos do M2.

**Gate de amostragem (2026-07-04):** 1ª destilação em prod deu **78,4% ok** — 3 ofensores diagnosticados nos dados reais e tratados:
- **Cola (647 exc.):** a BOM do Omie é **TABELADA** (a cola é idêntica por (linha,largura) — spread 0%, independe do comprimento; founder confirmou ter a tabela), não fórmula. Decisão eu+Codex: modelo **híbrido** — cola tabelada por (linha,largura), fórmula onde os dados sustentam (abrasivo=área, fita=proporcional, catalisador=razão). Cola tabelada valida **97,4%** (vs 78%). SKU sem (linha,largura) cadastrada → sem_regra (não fabrica). Dispersão da tabela por MAD (robusta a outlier).
- **MYLAR (259 exc.):** fita de emenda alternativa (razão 0,110) — não reconhecida pela regex. Fix: MYLAR→fita.
- **Slitter (112 exc.):** rolo→jumbo usa quantidade simbólica ≠ área nominal — fora do escopo F1A (BOM da cinta); validação restrita a `tipo_item='cinta'`. Nível slitter entra na Fase 1B.
- Achado extra: parte das malhas de abrasivo tem **perda embutida** (consome >área nominal) — vira exceção legítima (revela a perda real; a spec manda a perda p/ camada de custo).

**Estrutura nova:** `pcp_bom_regras` ganhou `largura_mm` (0=fórmula, >0=tabela) + método `tabela_largura`; PK (linha,papel,largura_mm). destilação PASS=33.

**Gate final (2026-07-05):** modelo híbrido aplicado → **95,4% ok**; **223 exceções em 174 de 1398 cintas** (87,5% das cintas batem exato). A destilação virou **auditoria de cadastro do Omie** — a fila aponta os SKUs com dígito errado.

**Investigação das 223 (papéis CONFIRMADOS certos — não é falso-positivo do classificador; o componente É fita/catalisador/cola):**
- **abrasivo_base 100** (95 `excecao` + 5 `unidade_inesperada`): consumo de rolo cadastrado ~10–12× a área nominal (dígito errado; ex. CINTA 2909 50X290 → 0,145 vs 0,0145 m²) + 5 rolos em unidade ≠ M².
- **fita 57** (53 + 4 `regra_instavel`): fita de emenda cadastrada **~200× menor** que o físico (0,03–0,19 cm onde o modelo espera ~11 cm) — erro de dígito/unidade. Componente real é `FITA SHELDAHL`/`MYLAR` (papel certo).
- **cola 36** (30 + 6 `regra_instavel`): diverge da tabela da largura (parte 10× para menos).
- **catalisador 30**: **efeito cascata** — quando a cola do pai tem dígito errado, o esperado do catalisador (= razão × cola) fica baixo e o catalisador CERTO vira exceção; + casos do próprio catalisador ~10× baixo. Corrigir a cola na fonte zera boa parte.
- **Conclusão:** a fila é majoritariamente **erro de cadastro no Omie**; corrigir na fonte + re-sync leva o "bate exato" de ~95% p/ ~99%.

**Tela de revisão (frontend, 2026-07-05):** `src/pages/ProducaoBomExcecoes.tsx` na rota **`/producao/bom-excecoes`** (staff). Lê `pcp_bom_excecoes`, agrupa por papel (aba), destaca o **fator** de divergência (badge vermelho em ≥3× / ≤⅓), busca por código/descrição, e dispõe cada exceção (`aceitar`/`corrigir_omie`/`regra_especifica`) via RPC `fn_pcp_dispor_excecao` (staff-gated). Tela **neutra** (mostra observado×esperado, não pré-julga de quem é o erro). Cast `as never` no `.from()`/`.rpc()` — a tabela é nova e **não está nos types gerados** (fluxo Lovable não regenerou; `grep types.ts = 0`), mesmo padrão de `ProductionOrders`. Validado: **typecheck 0 · lint 0 · build 0**. **Deploy = Publish manual no Lovable** (merge ≠ produção no frontend).
