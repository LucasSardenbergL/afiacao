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

## Fase 1B — M1: núcleo de execução event-sourced (2026-07-05)

**Plano:** `docs/superpowers/plans/2026-07-05-pcp-fase1b-m1-execucao.md` (v2 — painel tri-modelo incorporado). Escopo **cintas-first** (gargalo guilhotina→prensa) + consumo-motivo do Tingimix.

**O que shipou** (código na branch; **deploy SQL Editor PENDENTE** — founder):
- **`db/pcp-f1b-m1-execucao.sql`**: `pcp_etapas_catalogo` (roteiro da cinta, tempos NULL), `pcp_eventos_producao` (append-only, `id=client_event_id`, `device_seq`), `production_orders` EVOLUI (colunas nullable **exclusivas da projeção**), `fn_pcp_projetar_op` (**FSM na projeção** + advisory lock por OP), `fn_pcp_registrar_evento` + wrappers iniciar/finalizar (idempotente, staff-gated **fail-closed**). RLS + `REVOKE` de PUBLIC nas funções.
- **`db/test-pcp-f1b-execucao.sh`** (**PASS=26**, falsificação validada).

**Painel tri-modelo — BLOCK do v1 → v2** (Claude+Codex+Gemini, convergência total, 0 divergências): 5 P1 (3 confirmados por ≥2 modelos). Correções normativas **C1–C7**: lock por OP; 1-writer (projeção NÃO toca `completed_at`/`status` — donos da edge Omie, evidência `omie-vendas-sync/index.ts:2901`); `REVOKE` PUBLIC + gate fail-closed; `device_seq` + detecção de late-arrival por `server_ts`; idempotência valida payload imutável; invariantes do `consumo_mp` + **semântica com o backflush** (consumo apontado é a verdade do yield; backflush do M2 reconcilia, não soma); provas de concorrência.

**Bugs pegos na bancada (não chegaram à produção):**
1. **`v_inseriu boolean` recebendo `ROW_COUNT` (int)** → erro em RUNTIME (`boolean = integer`), late-bound. Fix: `v_rows int`. [prova PG17]
2. **Detecção de late-arrival DENTRO do loop `client_ts`** não via o fecho (o `finalizar` vem depois na ordem) → passagem separada com `EXISTS` sobre `server_ts`. [prova PG17]
3. **TESTE-TEATRO do lock**: a 2ª conexão bloqueava no *row-lock* do `UPDATE`, não no advisory lock → a prova passava mesmo SABOTADA. Só a **falsificação** revelou. Fix: testar `pg_try_advisory_xact_lock` direto (isola do row-lock). [falsificação]
4. **`SET` vazando na captura escalar** (`P -tA` sem `-q`) → `Pq`. [armadilha CLAUDE.md]

**Lição-chave:** a falsificação não é cerimônia — **pegou um teste que passava com E sem a regra que dizia testar**. Sem sabotar, o lock (o P1 nº1 do painel) ficaria "provado" por acidente do row-lock.

**Pendente (founder):** aplicar `db/pcp-f1b-m1-execucao.sql` no SQL Editor → verificar via psql-ro.

## Fase 1B — M2: modelo de dados do corte múltiplo (2026-07-05)

**Plano:** `docs/superpowers/plans/2026-07-05-pcp-fase1b-m2-corte-multiplo.md` (v3 — painel tri-modelo BLOCK incorporado). Escopo: **rota alternativa + coproduto obrigatório + rateio de custo** — o ÚLTIMO componente da Fundação (Fase 1). **NÃO** inclui o motor de sugestão (Fase 3) nem backflush/outbox (Fase 2 — nativo do Omie; o "M2 = corte + backflush" da nota anterior estava mal-escopado: backflush é F2).

**Decisões do founder (arbitradas antes do código):** perda por **ABSORÇÃO** (fração 0; custo redistribuído nas cintas boas) · sobra **PARAMÉTRICA** (a rota guarda a largura; o SKU concreto e o estoque resolvem na OP/F3 — sem FK a `omie_products`) · rotas **DERIVADAS** das larguras reais da 1A (`fn_pcp_derivar_rotas_simples`, fator inteiro 2..8).

**O que shipou** (código na branch; **deploy EXECUTADO 2026-07-05** — 109 rotas, 0 violações):
- **`db/pcp-f1b-m2-corte-multiplo.sql`**: `pcp_bom_rotas` (chave `(linha,base,alvo,esquema)`) + `pcp_bom_rota_saidas` (papel principal/coproduto/sobra/perda, `CHECK perda⇒fração0`); `fn_pcp_rota_fracao_default` (rateio por área, perda absorve); **CONSTRAINT TRIGGER DEFERRED** `fn_pcp_validar_rota` (Σárea física **=base** · Σfração das boas =1 · ≥1 principal na alvo · valida **origem+destino** num UPDATE); trigger de **imutabilidade** de base/alvo; `fn_pcp_ratear_corte` (**INVOKER** + guard de custo + **normalização** f/Σf, resíduo **determinístico** na maior); `fn_pcp_cadastrar_rota` (staff-gated, **anti-mistura** de frações, guard de `p_saidas`); `fn_pcp_derivar_rotas_simples`. RLS staff-read + `REVOKE` de PUBLIC (inclui os helpers internos).
- **`db/test-pcp-f1b-m2-corte-multiplo.sh`** (**PASS=35**, 4 sabotagens falsificadas + ZONA 10 do painel PR).

**Painel tri-modelo — BLOCK do v2 → v3** (Claude+Codex+Gemini). O painel achou no MEU plano v2 (não em produção):
- **3 P1** — geometria deixava **material SUMIR** (`Σ<base` aceito: `150→2×50` e os 50mm somem) → fix `Σ=base`; **coproduto omitido com custo ZERO** (mistura de frações) → fix anti-mistura; **o teste do INVOKER dava FALSO-VERDE** (calculava o `rota_id` já sob a RLS de não-staff → NULL, mascarando um eventual DEFINER) → fix capturar o id **literal** como staff antes.
- **Confirmados por ≥2 modelos** — UPDATE de `rota_id` furava a validação da rota **origem**; **perda com fração>0** distorcia custo (re-absorvida inteira na maior boa); **Σfração aproximada** (round 4) amplificava resíduo → **normalizar**.
- **P2/P3** — base/alvo imutáveis · custo NULL/negativo · REVOKE dos helpers · teto do fator k · fixture de derivação isolada · migração defensiva da chave. **Rejeitado com justificativa:** `UNIQUE(rota,largura)` (o papel distingue `2×50+50sobra`, que o fix da geometria torna necessário).

**Bugs pegos na bancada (não chegaram à produção):** todos os 6 acima — pegos pelo painel ANTES do SQL, corrigidos no v3, e cada um **falsificado** na prova (sabotar → vermelho no assert que o vigia → reverter).

**Lição reforçada:** a sabotagem `INVOKER→DEFINER` é exatamente o teste que o v2 dava por bom sem testar nada (o `rota_id` calculado sob RLS zerava a query de qualquer jeito). Com o id **literal**, a falsificação fica vermelha (`veio [1]`, custo vazaria) — **um teste de RLS que não passa um id fora da RLS não testa RLS**.

**Painel PR sobre o CÓDIGO real (pós-deploy) — sem BLOCK:** com o SQL já em prod, 2ª volta do painel modo `pr` (Codex 3 P1/9 P2 + Gemini 2 P2 + lente Claude). **Nenhum P1 sobreviveu à verificação empírica** — sondas PG17 **refutaram** o "DELETE trigger com `NEW=NULL` quebra" (roda e barra por invariante) e confirmaram que o `UPDATE move-saída` já é barrado (era **test-gap**, não bug). Fechados os test-gaps (ZONA 10: DELETE, move-saída, **auditoria de grants** via `has_function_privilege`) + melhorias baratas: desempate **determinístico** do resíduo do centavo, guard de `p_saidas`, `::bigint` anti-overflow. **Achado fino (fix A × fix D):** com `Σ=base` **exato**, mover uma saída quebra a geometria de AMBAS as rotas → o fix D é o guard primário e o fix A (validar a origem) é **defense-in-depth redundante** aqui (documentado, não teatro reverso).

**Verificação de deploy (psql-ro):** `fn_pcp_derivar_rotas_simples()` = **109 rotas** em **14 linhas**; **0 rotas violando invariante** (Σárea=base · Σfração boas=1 · ≥1 principal) nos dados REAIS; teto k≤8 respeitado; a linha 2909/base 600 tem **6 decomposições** coexistindo (k=2/3/4/5/6/8) — a chave de 4 colunas provada em prod.

**Custeio da SOBRA (founder, 2026-07-05):** sobra aproveitável **carrega custo** proporcional à área (é "boa" no rateio); o Gemini alertou risco de superavaliar estoque, o founder arbitrou **manter** (refilo sem liquidez real vira `perda`). Só a **perda** absorve 0.

**🏁 Fundação (Fase 1) FECHADA (2026-07-05):** 1. dados mestres ✅ · 2. parser ✅ · 3. BOM paramétrica ✅ · 4. OP+etapas ✅ (M1) · 5. apontamento offline c/ consumo-motivo ✅ (M1+M3 `src/pages/...` na rota `/producao/apontamento`) · 6. **corte múltiplo ✅ (M2)**. Próximo: **Fase 2 — Custo & Omie** (backflush fiscal + outbox incluir/concluir OP + validação cruzada de custo com o `custoProducao` que já vem na malha).

**Pendente (founder):** (1) **M1** — aplicar `db/pcp-f1b-m1-execucao.sql` no SQL Editor (destrava a tela de apontamento do M3); (2) **opcional** — re-colar a versão endurecida do `db/pcp-f1b-m2-corte-multiplo.sql` (melhorias do painel PR, idempotável; prod já está correto sem isso). Depois: realinhamento pós-squash + PR → main.

## Fase 2A — Custo-padrão de material & fila de exceções (2026-07-06)

**Plano/spec:** `docs/superpowers/plans/2026-07-06-pcp-fase2a-custo.md` (v3) + `.../specs/2026-07-06-pcp-fase2a-custo-design.md` (v2). Abre a **Fase 2 (Custo & Omie)** pelo bloco de CUSTO (read-only, não escreve no Omie); o outbox fiscal (incluir/concluir OP) é a **Fase 2B**.

**Task 0 — sonda empírica (ancorou o design no real, ANTES de qualquer schema):**
- O `custoProducao{vGGF,vMOD}` da malha Omie está **100% ZERADO** (0/2011) → o custo real vive no **`cmc_snapshot`** (CMC de estoque, grade mensal, conta única `colacor_vendas`; cobertura 94% acabados / 99% insumos). O plano original (comparar com o `custoProducao`) era inviável — a sonda pegou isso antes de o schema nascer errado.
- **Linhagem híbrida:** `nCMC(acabado)` vs `Σ(estrutura×nCMC insumo)` na mesma data — **50% batem ≤1%** (23% ao centavo), **35% divergem >5%**. O CMC do fabricado é em parte o próprio teórico, em parte média-móvel histórica. → **reposiciona** o 2A: não é "teórico×real puro" nem "gap=conversão de graça" (ambos falsos), é **custo-padrão calculado + fila de exceções CLASSIFICADA** (o valor está nos ~35%).
- **`unidProdMalha` vs unidade de estoque: 6732/6732 batem** → custo = `qtd×CMC` **sem conversão** (a tabela de unidade vira guard defensivo, não motor). Removeu um P1 de unidade inteiro.

**Decisões do founder:** conta **única** (Colacor compra e vende tudo — mata o risco multi-account) · escopo **LIXA** (cinta/disco/folha/rolo); **tingidor FORA** (o Tingimix tem custeio próprio — pot-life/mistura em batch — que não encaixa nos 4 papéis de lixa; forçá-lo poluiria a fila com falso-positivo sistemático).

**O que shipou** (`db/pcp-f2a-custo.sql`, `db/test-pcp-f2a-custo.sh` **PASS=55**):
- `pcp_custo_padrao_resultados` (buckets abrasivo/cola/catalisador/fita/**outros**; chave com `versao_regra` — regra nova não sobrescreve) + `pcp_custo_excecoes` (fila **inclusiva** — incompleto/sem-custo/unidade-divergente/ambíguo ENTRAM; `impacto_r` ordena por R$).
- `fn_pcp_cmc_vigente` (**INVOKER** — a policy staff-only do `cmc_snapshot` protege; conta de `pcp_config`), motor **set-based** `fn_pcp_recompute_custo_padrao` (ausente→**NULL** nunca 0; guard de unidade; contrato jsonb; valida data-posição e aborta), `fn_pcp_recompute_excecoes` (classe **cruza a fila da 1A** `pcp_bom_excecoes.pai_codigo` — só acusa "erro de receita" com esse oráculo; default `causa_indeterminada`). RLS enabled (não force — o writer é a RPC DEFINER) + staff-read; advisory lock nas 2 RPC.

**Painel tri-modelo — 2 voltas (Claude+Codex+Gemini):**
- **Sobre o PLANO (BLOCK, 4 P1):** classe_causa **fabricava** "erro de receita" (a comparação é semi-circular → mede drift de preço; fix: cruzar a 1A como oráculo) · Tingidor poluía a fila (fix: escopo lixa) · view de cobertura **vazava custo** (fix: `security_invoker`) · data-posição errada zerava tudo em silêncio (fix: valida+aborta). +7 P2 (a fila **escondia o pior caso** — 2 modelos; FORCE RLS travaria o writer; versão na chave; contrato jsonb; tolerância saneada; conta em config).
- **Sobre o CÓDIGO real (1 confirmado + 5 defensivos → hardening):** Gemini(P1)+Codex(P2) — a fila ainda **excluía `unidade_divergente`/`ambiguo`** (o mesmo princípio, 2 status esquecidos) → entram como classe própria. +5 money-path defensivos (0 casos nos dados hoje, mas corretos): guard furava sem `omie_products`; `qtd=0` custeava; `idProdMalha` inválido **abortava o recompute inteiro** (fix: regex + `length≤18` anti-overflow de bigint); config sem validação; advisory lock.

**Falsificação (Lei de Ferro):** 8 sabotagens, cada uma vermelha no assert que a vigia — `INVOKER→DEFINER` (custo vaza p/ não-staff); `COALESCE(cmc,0)` derruba **10** asserts de "ausente≠zero" de uma vez (o guard blinda todos os fixes de custo); reverter o FIX 1 faz os SKUs sumirem da fila (`[]`).

**Verificação em prod (deploy do founder, 2026-07-08) → FIX 7:** custeio real (2011 SKUs, só 3 incompletos) + fila **629 exceções** (34% da lixa, bate com a linhagem: 476 `causa_indeterminada` · **96 `ncmc_ausente`** [produto ativo sem custo no Omie] · 45 `possivel_erro_receita` [com exceção 1A]). A psql-ro pegou o que a prova sintética não cobriu: **38 SKUs com estrutura Omie VAZIA** (`itens=[]`) viravam `custo_total=0`/`ok` — fabricava custo onde a receita está **ausente** (viola ausente→NULL) e poluía o topo da fila (7 dos top-20, **R$1309 de impacto falso**). **FIX 7:** array vazio → `custo_status='sem_estrutura'` (custo **NULL**) + classe própria na fila (impacto=nCMC). Prova **PASS=62** (+ sabotagem nova). *Lição: a prova PG17 valida invariantes em fixtures; o **deploy real revela os shapes do Omie que a fixture não imaginou** — verificar em prod (psql-ro) é parte do ritual, não opcional.*

**Pendente (founder):** **re-colar** `db/pcp-f2a-custo.sql` (idempotável, agora com o FIX 7) no SQL Editor → re-rodar `SELECT fn_pcp_recompute_custo_padrao(fn_pcp_ultima_data_posicao());` + `SELECT fn_pcp_recompute_excecoes(fn_pcp_ultima_data_posicao());` (a fila reclassifica os 38 para `sem_estrutura`). Depois: **Fase 2B** (outbox fiscal — precisa do contador + sandbox Omie).
