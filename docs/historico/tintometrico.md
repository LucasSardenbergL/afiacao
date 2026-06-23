# Tintométrico — entregas e lições

Narrativa das entregas do módulo tintométrico (`/tintometrico/*`, account `oben`). Registre aqui ao concluir; regras vivas vão pro CLAUDE.md, lição reutilizável pra `docs/agent/`.

---

## Re-envio residual de fórmulas — promoção aborta por corante repetido (duplicate key) → re-loop (2026-06-22, migration `20260622210000`, prova PG17 + Codex)

### Sintoma
Pós-#914 (loop de 485k morto), re-envios residuais em batches CHEIOS (`total_records=1000`) em dias esparsos (06-18=113k, 06-22=75k); `tint_staging_formulas` 121k→406k. ~1000× menor que o loop original, sem dano visível — mas ATIVO (~10 runs `error`/h, 5-10k regs/h re-staged à toa).

### Diagnóstico (read-only psql-ro + código)
- O conector (`syncFormulas`) só cacheia o lote se a edge confirma `ok:true`. Em `automatic_primary` a edge (`tint-sync-agent`) promove **por batch** e devolve **500 se a promoção falha** → o conector **não cacheia o lote** → **re-envia o batch CHEIO no ciclo seguinte** (re-loop). Confirmado: 22/06 = 116 runs `formulas` status=`error` (75.082 regs) vs 16 `complete`; **1000 chaves re-staged 41×** (1 batch refém).
- Erros (`tint_sync_errors` entity_type='promotion'): `nome_cor NULL` (80 — **resolvido pelo #992**, parou 20:22, fix 20:45), `duplicate key tint_formula_itens_formula_id_corante_id_key` (15), `lock timeout` 55P03 (34, **colateral** da contention do re-loop).
- **Causa do duplicate key:** 4 cores PADRÃO ATIVAS (`344M/629N/638S/997M - BS`) têm fórmula com o **mesmo corante em 2 slots/ordens** (dosagem em 2 etapas; ex. 997M corante 3 = 0.385[ord2] + 14.09[ord5]). `aggregateFlatFormulaItems` (pg.go) envia 2 itens; o INSERT de `tint_formula_itens` **não deduplica** → viola o unique `(formula_id, corante_id)` → **rollback do batch**. A promoção monta `_formulas_latest` por **latest-per-key restrito aos PARES tocados** → essas 4 cores envenenam TODO batch que toca seus pares (18 produtos/51 bases ≈ 1000 fórmulas reféns).
- Por que "erros baixos" enganava: a coluna `errors` do run conta erro de ITEM no staging (=0, o staging aceita tudo); o abort é na PROMOÇÃO (marca status='error', não toca `errors`).

### Respostas (perguntas da investigação)
1. Mesmas chaves a cada evento? **SIM** (re-loop do mesmo batch). 2. Personalizadas? **NÃO** (99,86% padrão; nome_cor era problema separado, resolvido #992). 3. Re-scan de domingo? **NÃO** (qui/sex/seg; é promoção falhando). 4. Hash não-determinístico? **NÃO** — o hash está correto; o bug é na promoção SQL.

### Decisão de semântica (founder delegou "você e codex decidirem")
O oficial (CSV-import histórico) grava **1 item por corante = o de MAIOR ORDEM** — validado em prod no caso que distingue: 344M corante 1 = ordem3=**1.54** (NÃO maior-valor 40.05, NÃO soma 41.59); 997M = ordem5=14.09; 638S idênticos. Fix replica isso: `DISTINCT ON (formula_id, corante_id) ORDER BY ordem DESC` → **idempotente, ZERO mudança de dosagem de cor ativa** (precisão > recall). **NÃO somar** (mudaria preço/dosagem de cor ativa + erra os casos de duplicação 629N/638S idênticos).

### Fix
Migration `20260622210000_tint_promote_dedup_itens_corante.sql` (CREATE OR REPLACE, 6ª da cadeia — herda nome_cor + E4 + reexpand + preço VERBATIM). Muda só o INSERT de `tint_formula_itens`. Resolve o duplicate key → o batch promove → cessa o re-loop → some o lock timeout colateral. **NÃO toca o conector** (sem redeploy no balcão).

### Verificação
PG17 `db/test-tint-promote-dedup-itens.sh` — **11/11 verde**: promove sem abortar · dedup 1 item/corante · maior-ordem (1.5, não soma/maior-valor) · idênticos→0.77 · corante normal intacto · idempotente · preço usa max-ordem (A8). **Falsificação com dente:** sem o `DISTINCT ON`, o INSERT estoura **23505** (= o re-loop real). **Idempotência catalog-wide provada** (read-only vs prod): as **4 cores/192 fórmulas** têm fração-normalizada staging-max-ordem == oficial (15/15 corantes batem) → no-op de dosagem. **Codex consult (medium):** validou max-ordem como o hotfix certo (não somar, não corrigir a 344M agora) e levantou 3 achados, **todos incorporados** — [P1] dedup do `_preco` p/ alinhar item↔preço (era 2 BOMs: item=max-ordem, preço=Σ-todos; dead-code hoje pois `precos_base` vazio, mas bomba latente); [P1] a prova de idempotência catalog-wide acima; [P2] tie-break determinístico (`ordem DESC, qtd_ml DESC, id DESC`) no DISTINCT ON.

### Achado lateral (decisão de domínio, fora do escopo do fix)
"Maior ordem" faz a **344M usar 1.54 ml de corante 1** em vez de 40.05 (ordem 1) ou 41.59 (soma) — provável **subdosagem** se as 2 dosagens forem reais. O oficial já é assim (não-regressão; ninguém reclamou). Avaliar com o balcão/SayerSystem se aquelas 2 dosagens distintas (344M, 997M) deveriam **somar** — se sim, é OUTRA mudança money-path (mudaria a cor ativa).

### Lições (reutilizáveis)
1. **Edge promove por-batch e devolve 500 → conector não cacheia → re-loop de batch CHEIO.** "batches cheios re-enviando" ⇒ olhar `tint_sync_runs.status='error'` + `tint_sync_errors entity_type='promotion'`, NÃO a coluna `errors` (conta só erro de item no staging; a promoção falha DEPOIS).
2. **`INSERT...SELECT` em tabela com unique deve deduplicar a chave.** Corante repetido na fórmula é dado REAL do SayerSystem (2 dosagens do mesmo pigmento); via latest-per-key, 1 fórmula venenosa derruba o BATCH inteiro de 1000.
3. **Identidade > "correto teórico" no money-path:** o oficial usa maior-ordem (talvez subdosando); o fix replica (idempotente) em vez de "consertar" somando — corrigir dosagem de cor ativa é decisão de domínio, não efeito colateral de um fix de re-loop.
4. **`data_atualizacao` sempre-NULL ⇒ hash-filter sempre ativo** (formula E formulaperson) → re-envio nunca é delta-timestamp. **Staging append + latest-per-key + purge-30d** → crescimento da staging (121k→406k) é re-staging acumulado, **auto-limitado** (sintoma, não dano).
5. **SQL Editor "failed" ≠ rollback.** Função pesada (aqui **129k expansões** re-processadas — o batch de 17 fórmulas tocava 16 pares compartilhados com centenas de cores) estoura o timeout de DISPLAY do editor (cliente desiste da resposta HTTP), mas o backend termina e **COMMITA**. Verificar o efeito no banco (`tint_importacoes.status='concluido'` + `updated_at` do dado, via psql-ro), nunca confiar no veredito do editor. Corolário: forçar `tint_promote_sync_run` de um batch que toca pares "populares" re-expande MUITO — idempotente/seguro, mas pesado; não re-rodar achando que falhou.
6. **"Zero erro" pode ser ausência do gatilho, não a cura.** O re-loop ficou quieto porque o conector parou de mandar o batch venenoso — não porque o fix o absorveu. Provar exige ver o batch REAL ser processado com sucesso (forçar a promoção do `sync_run_id` arquivado), não só observar silêncio.

### Resolução confirmada em prod (2026-06-23)
Migration aplicada no SQL Editor (`pg_get_functiondef` confirmou os 5 marcadores em prod, sem drift). **Causa raiz refinada:** o gatilho do re-loop residual de hoje eram **cores NOVAS** (`058W`, `941Y - PEARL`, `personalizada=false`, ainda fora do catálogo) que o conector reenviava a cada ~12 min; elas **tocam os mesmos pares (produto,base) das 4 cores antigas** (058W↔629N/638S em 16/16 pares), e a promoção por-PAR (latest-per-key) **re-processa as 4 cores** (staging com corante dup) → 23505 → rollback do batch → 058W/941Y nunca entram → edge 500 → re-loop. As 4 cores são a RAIZ; 058W/941Y o GATILHO (o conector parou de mandá-las 12:38, por isso o re-loop ficou quieto antes mesmo do apply — não confundir com prova do fix).
**Prova end-to-end (dados reais):** forçada a promoção do batch real que dava 23505 (`SELECT tint_promote_sync_run('e0c0d022…')`) → **importação `concluido`, 129.576 regs, 0 erros, ZERO 23505**; 058W (64 fórmulas) e 941Y (4) entraram, itens dedupados (1/corante); integridade preservada (**252 cores descontinuadas intactas, 0 duplicatas pela chave oficial, preço preservado via COALESCE**). Re-loop morto. PR #995 liberado.

### Decisão de domínio (FECHADA — Claude + Codex, unânime: A = manter max-ordem)
A 344M usa **1.54ml de corante 1** (ordem 3) em vez de 40.05 (ordem 1) ou 41.59 (soma) — possível subdosagem se as 2 dosagens forem reais. **Decisão: MANTER max-ordem** (= o que o fix já faz; NÃO somar). Razão: está em 1.54 desde o CSV-import **sem reclamação**, `tint_staging_preparacoes` está **vazia** (zero sinal de uso), e mudar **27×** uma cor ativa sem falha observada é pior governança que manter o status quo suspeito-mas-não-contestado (Codex: *"a bigger governance error"*). Auditoria confirma a **344M como ÚNICO caso** no catálogo (descartada/mantida ≥ 5 → razão 26×; 629N/638S = duplicação idêntica, 997M descartou a menor). Se o balcão um dia contestar a cor, é `UPDATE` pontual de 1 linha. Safeguard periódico (sugestão do Codex):
```sql
WITH r AS (SELECT si.staging_formula_id, si.id_corante, si.qtd_ml,
  row_number() OVER (PARTITION BY si.staging_formula_id, si.id_corante ORDER BY si.ordem DESC, si.qtd_ml DESC, si.id DESC) rn
  FROM tint_staging_formula_itens si JOIN tint_staging_formulas s ON s.id=si.staging_formula_id
  WHERE s.account='oben' AND s.store_code='M01' AND s.personalizada=false),
agg AS (SELECT staging_formula_id, id_corante, max(qtd_ml) FILTER (WHERE rn=1) kept,
  max(qtd_ml) FILTER (WHERE rn>1) maior_descartada FROM r GROUP BY 1,2 HAVING count(*)>1)
SELECT s.cor_id, a.id_corante, a.kept, a.maior_descartada, round((a.maior_descartada/nullif(a.kept,0))::numeric,1) razao
FROM agg a JOIN tint_staging_formulas s ON s.id=a.staging_formula_id
WHERE a.maior_descartada/nullif(a.kept,0) >= 5 ORDER BY razao DESC;  -- hoje: só 344M (26x)
```

---

## Catálogo automático (tint) — fase de reconciliação: dry-run global + auditoria das 252 cores fantasma (2026-06-17, análise; flip pendente)

Preparação para flipar `integration_mode` `shadow_mode`→`automatic_primary` (store `M01`, account `oben`). Análise 100% read-only (psql-ro) + 2ª opinião do Codex (consult); a execução (escrita) é via SQL Editor.

### Estado medido
- Oficial `tint_formulas`: 481.721 linhas, todas ativas, 4 embalagens → ~120.529 fórmulas-FONTE (CSV-import histórico). Staging (full sync do v0.2.0): 121.467 linhas = 121.130 fontes (~1 embalagem/fonte). **A diferença 481k vs 121k é a EXPANSÃO fonte→embalagem (4×), não fórmulas faltando.** `tint_staging_precos_base`=0 (preço vem do Omie, NÃO do sync — promover fórmula com preço NULL é inofensivo).
- Staging gravado como ~141 runs de fórmulas + 20 de catálogo (1 `sync_run_id` por batch de 1000).

### Mecanismos (lidos no código)
- `tint_promote_sync_run(run_id)`: **SEM gate de auth** (roda no SQL Editor). Aditivo — upsert latest-por-chave restrito às chaves do run; EXPANDE fonte→embalagem via `tint_skus`+`tint_embalagens` do CATÁLOGO (NÃO a embalagem do staging — por isso 121k fontes recriam as 481k linhas, não colapsam); reativa (`desativada_em=NULL`); **não desativa**. Roda por-batch automático só em `automatic_primary`.
- `tint_apply_keys_snapshot(snapshot_id)`: ÚNICA via de desativação. Só dispara pela edge em `automatic_primary` com snapshot completo. Compara por chave-FONTE (4 partes, sem embalagem). Guards: aborta se snapshot <50% do oficial OU desativaria >20%.
- `tint_run_reconciliation(run_id)`: por-run (1000 linhas), gate de staff; `only_csv` é **código MORTO** (nunca incrementado) → NÃO serve como gate global de desativação. A tela carrega só 500 itens/run.

### Dry-run global (read-only, espelhando as funções)
- Identidade conector↔oficial **CASA: 96,8%** (116.699 das 120.529 fontes batem). Identidade quebrada desativaria ~120k.
- Desativaria: **3.830 fontes = 252 cores distintas**, todas `personalizada=false`, **0 ainda existem no SayerSystem** (sumiram de vez, não erro de grafia) → remoções LEGÍTIMAS (cores descontinuadas tipo `TABACO NEUART`; 401 são lixo `DUPLICADA`/`TESTE`). 3,2% < guard de 20%.
- Novas a promover: 4.431.

### Decisão (Claude + Codex consult)
Recall-first ("sumir cor real é pior que cor a mais") → **promover ANTES de desativar**; o guard de 20% é rede de último recurso (~24k cores), não controle de qualidade. Sequência segura:
1. Promoção manual em `shadow_mode` (SQL Editor; **catalogs antes de fórmulas** — a expansão depende de `tint_skus` já populado).
2. Spot-check do oficial.
3. Desativação controlada (`tint_apply_keys_snapshot` manual) das 252 auditadas.
4. Flip → `automatic_primary` (steady-state).

### Lições (reutilizáveis)
1. **Divergência "linhas oficiais vs staging" pode ser só a EXPANSÃO** (1 fonte → N embalagens via `tint_skus`); compare por FONTE, não por linha, antes de entrar em pânico.
2. **`only_csv` da reconciliação é código morto** — a função NÃO detecta o que seria desativado; auditar candidatos a desativação exige SQL espelhando `tint_apply_keys_snapshot` (`_oficial_ativas` vs `_snap_keys`), não a tela.
3. **Blast-radius guard ≠ controle de qualidade**: <20% ainda deixa ~24k cores sumirem; defina lista auditada+aprovada antes de aplicar.
4. **Promoção é aditiva e disparável manual** (sem gate de auth) → atualiza o oficial em shadow sem ligar a desativação automática (que só roda em `automatic_primary`).

---

## Conector `sayersync` — auto-update Windows-safe + crash-loop guard que expira (2026-06-17, [PR #921](https://github.com/LucasSardenbergL/afiacao/pull/921))

### Problema
O #919 ligou o auto-update do conector (`CheckAndApplyUpdate` cedo em `RunCycle`), mas **dormente** (liga só com `update_manifest_url` + bucket `releases`). Review do Codex achou 2 defeitos reais em `update.go` que os testes existentes não cobriam e que o tornariam quebrado/perigoso ao ativar.

### Diagnóstico
**P1:** `installBinary` fazia `os.Rename(.new, exe)` por cima do `.exe` em EXECUÇÃO → no Windows a imagem em uso não pode ser sobrescrita (sharing violation) → **todo update válido falhava** e só incrementava `UpdateFailCount`. **P2:** o crash-loop guard media a janela de 24h por `LastUpdateAttempt`, renovado pelo throttle diário a CADA passagem (inclusive nos dias em que o guard pula) e persistido pelo save gated `sync.go:552` (o amplificador que o Codex apontou) → `time.Since(last)` resetava pra ~0 todo dia → a janela **nunca envelhecia** → 3 falhas transitórias = updates desligados PARA SEMPRE até editar `state.json` à mão.

### Fix (TDD + Codex)
**P1:** move-aside-then-place — grava `.new`, **RENOMEIA** o exe em uso → `.prev` (Windows permite mover/renomear a imagem em uso, só não sobrescrever/apagar), move `.new` → exe; + **rollback** se o place falhar (nunca deixa o serviço sem binário no caminho). Pós-install **reinicia** (`os.Exit(90)` → SCM `OnFailure=restart`) pra ativar o novo binário — sem isso o serviço seguiria na imagem antiga e a PRÓXIMA atualização falharia ao tentar substituir o `.prev` em uso. **P2:** campo dedicado `State.LastUpdateFailure` (gravado só na falha real) ancora a janela; `LastUpdateAttempt` segue renovando só pro throttle (sem log spam). Seams `executablePath`/`renameFile`/`restartService`/`stateDir` pra testar de verdade num tmpdir.
Hardening do **Codex challenge** (9 findings): **F1** persiste state antes do `os.Exit` (release mal-versionado — ex.: build sem ldflag → `"dev"` — não loopa mais que 1×/dia); **F8** fail-open em timestamp futuro (clock skew não pausa updates indefinido); **F6/F7** `autoUpdateEnabled` desliga update no subcomando `once` (debug não troca binário de produção nem `os.Exit` fora do SCM).

### Verificação
20 testes de update (TDD RED→GREEN), **cada invariante novo falsificado por sabotagem cirúrgica** (re-ancorar o guard em `LastUpdateAttempt` derruba o P2 unit **e** e2e; remover só o rollback derruba **só** o teste de rollback). Suíte completa `ok`, `go vet`/`gofmt` limpos, **cross-compile Windows OK** — antes e depois do rebase sobre #914. Codex challenge + consult → decisão conjunta **Path B**.

### Lições (reutilizáveis)
1. **Windows não deixa SOBRESCREVER/APAGAR a imagem do `.exe` em execução, mas deixa RENOMEAR/mover.** Self-replace de binário é sempre move-aside-then-place, nunca rename-por-cima. No teste, `os.SameFile` distingue MOVE de cópia (o estado final no disco é igual no Unix — só a identidade do arquivo prova a sequência).
2. **Sinal de "janela de tempo" não pode ancorar num timestamp que outro mecanismo renova** (aqui o throttle diário) — senão a janela nunca envelhece. Campo dedicado, 1 writer, ancorado no EVENTO real (a falha), não na tentativa.
3. **Serviço que se auto-atualiza:** `os.Exit(non-zero)` + recovery `OnFailure=restart` do SCM é o caminho pro relançamento — mas o crash-loop guard do *updater* NÃO pega binário que instala (sha ok) e quebra no BOOT. Rollback de boot-crash exige ator EXTERNO ao binário (recovery do SCM com ação de rollback, ou launcher). **Handshake in-binary é falsa confiança** (o código de rollback não roda se o crash for antes dele — init/main/LoadConfig).
4. **`os.Exit` pula `defer`/SaveState** → persistir o state ANTES de sair (senão o throttle volta pra ontem e um mis-version vira loop install→restart).
5. **Debug (`once`) não deve auto-atualizar produção** (troca de binário + `os.Exit` fora do SCM + corrida de arquivos com o serviço).

### Limite conhecido / pendência (gate de ativação)
**F2** (binário sha-válido que quebra no boot → loop do SCM sem rollback) documentado no `connector/README.md` como gate. Fix robusto deferido p/ esforço dedicado de Windows: recovery do SCM com rollback **ou** launcher externo + `restorePrev` rename-based (F3) + verificar `OnFailure=restart` antes de atualizar (F5). F4 (power-loss entre os 2 renames) e F9 (assinar releases) anotados como limites menores. **Ativação (só founder, em Windows):** bucket `releases` + `update_manifest_url` + **testar um release deliberadamente quebrado** antes de confiar.

### Coordenação
Rebaseado sobre #914 (hashcache) — arquivos disjuntos, zero conflito; **não toca** `hashcache.go` nem `sync.go`. Fecha a dívida que a Lição #4 do #914 apontou (auto-update sem call-site): o call-site entrou no #919, este PR conserta o install/guard.

---

## Conector `sayersync` em loop — re-envio de 485k fórmulas/ciclo → detecção por hash de conteúdo (2026-06-16, [PR #914](https://github.com/LucasSardenbergL/afiacao/pull/914))

### Problema
O conector Go (`connector/sayersync/`, binário no balcão, FORA do Lovable) re-enviava TODAS as ~485k fórmulas a cada ciclo: 398+ runs/hora, `tint_staging_formulas` com 3,3M+ linhas, escalando 1.227→6.195 runs/dia.

### Diagnóstico (código + dados de prod via psql-ro)
A tabela FORMULA do SayerSystem tem `data_atualizacao` SEMPRE NULL. A query delta (`pg.go ExtractDelta`) é `WHERE da > $1 OR da IS NULL` → o `OR IS NULL` traz tudo; `advanceHWM` (`sync.go`) faz `if maxDA.IsZero() { return }` → HWM nunca avança → full-scan + full-resend a cada ciclo. Confirmado nos dados: runs `formulas` a cada ~7s sempre com 1000 inserts; `catalogs` (entidades pequenas) com `total_records=0` → **as pequenas têm data preenchida e seguem com delta por timestamp; só FORMULA precisa de outro mecanismo.** A fórmula só tem campos de conteúdo (sem timestamp/versão), então a detecção tem de ser por CONTEÚDO.

### Fix (TDD + Codex)
`connector/sayersync/hashcache.go` (novo): hash estável do payload canônico que `mapFormula` produz (cor/base/embalagem/produto/volume + itens ORDENADOS), encoding **length-prefixed (injetivo)**, floats **quantizados a 4 casas** (absorve ruído float32 — `qtd_ml 5.159999847412109` visto no staging), presença ≠ ausência de campo opcional. Cache em `hashes.json` ao lado do exe (atômico, no-op quando nada muda, backup `.corrupt`). `syncFormulas` envia só hash novo/alterado; cacheia o lote **só se a edge aceitou TODOS os itens** (lote com erro não cacheia e **não avança o HWM** — re-tenta); poda chaves removidas no full-scan (inclusive extração vazia), namespaced por `personalizada`. Deleção inalterada (keys-snapshot diário). Cross-compila `GOOS=windows` sem CGO (v0.2.0).

### Verificação
- 28 testes Go novos cobrindo: hash estável/ordem-invariante/quantização/injetividade; persistência + corrupção; integração (não-reenvia/só-mudada/lote-com-erro-não-cacheia-nem-avança-HWM-e-falha/poda inclusive vazia/delta-com-HWM-não-filtra/sem-ok:true-não-cacheia). Falsificação (sabotar → exigir vermelho) confirmou que pegam os bugs-alvo.
- Codex review do diff (1 consult no design + 6 passadas no diff): **6 P1 + 4 P2** achados e corrigidos, cada um com teste TDD — `Index` ausente=0 mal-interpretado, `Errors` sem `ErrorCount`, erro de item silencioso (agora falha o ciclo), delete+recreate em fonte com HWM (hash-filter só em full-scan), durabilidade poda↔snapshot (persiste o cache antes de deletar no servidor), cachear sem `ok:true`; injetividade (hash e chave via length-prefix), poda em extração vazia, HWM avançando após erro.
- **Pós-deploy CONFIRMADO em produção (2026-06-17, psql-ro):** deploy do `0.2.0` no balcão (`agent_version=0.2.0`, hostname `DESKTOP-BCTR6K6`). Full sync inicial 12:44–12:49 enviou **121.464** fórmulas (popula o `hashes.json`); os ciclos seguintes (13:00 e 13:10, interval 10min) enviaram **1 registro cada** — queda de **~121k→1 por ciclo (~99,999%)**, conector vivo, runs `complete` sem erro, `shadow_mode`. **Loop morto.** _Cuidado de monitoramento aprendido:_ armar o monitor APÓS o full sync já em curso cega a janela de 12min (o pico nunca entra) — a confirmação veio da query do padrão por minuto, não da heurística de "viu o pico → caiu". (Obs.: o full sync enviou ~121k, não os ~485k do diagnóstico — provável catálogo real após filtro `liberado`/dedup por embalagem; a **reconciliação** da fase seguinte cruza isso contra a produção.)

### Lições (reutilizáveis)
1. **Delta por timestamp morre quando a fonte não preenche a data** — `advanceHWM` com `maxDA` zero nunca progride → full-resend silencioso. Fonte sem timestamp/versão ⇒ detecção por HASH DE CONTEÚDO.
2. **Hash money-path-adjacent: precisão > recall = zero falso-negativo.** Encoding length-prefixed (separador é forjável: bytes de controle no texto), quantização de float documentada como invariante de domínio, presença ≠ ausência, e **nunca cachear o que a edge não confirmou** (Index pode vir ausente=0 → falhar fechado no lote inteiro + não avançar o HWM).
3. **2xx da edge = "staged", não "promovido".** O cache espelha o staging → **purgar o staging exige apagar o `hashes.json` no balcão** (senão o re-scan acha que já enviou tudo).
4. **Conector é binário Go fora do Lovable** — recompila/redeploya à parte (reinstalação manual no balcão). Achado: o auto-update (`update.go`) está sem call-site em `RunCycle` e o bucket de releases retorna 404 (dívida separada).

### Coordenação
Nenhum outro worktree/PR tocava `connector/sayersync/`. Promoção `tint_promote_sync_run` e reconciliação intocadas (fase seguinte: purge do staging → re-scan limpo → reconciliação → flip `shadow_mode`→`automatic_primary`).

---

## Vínculo `tint_skus` ↔ Omie — resgate de 62 cores que somem do seletor (2026-06-15, [PR #870](https://github.com/LucasSardenbergL/afiacao/pull/870))

### Problema
Cores fabricáveis (fórmula ativa) somiam do seletor de venda (`src/components/tintColorSelect/useTintColorSelect.ts`): a busca descarta SKU sem produto Omie (`.not('omie_product_id','is',null)` + `if (!sku?.omie_product_id) continue`). Havia **139 `tint_skus` (`oben`) com `omie_product_id NULL`**. O founder suspeitava que os produtos Omie existiam e só faltava o vínculo (`UPDATE tint_skus SET omie_product_id`), e pediu **certeza de que o produto não existe antes de tratar como ausência** — nunca remover SKU nem fabricar vínculo.

### Diagnóstico
Auditoria read-only iterativa (founder colava no SQL Editor; cada query validada antes em PG17 local). Achados que reorientaram a tarefa:
- **Medir por COR, não por SKU.** Uma cor só some se **todos** os seus SKUs forem órfãos. Dos 8.489 cores: **102 somem**, 8.360 parciais (vendem em alguma embalagem), 27 completas. Os "139 SKUs órfãos" superestimavam — 40% eram balde **BH (18 L)** de cores que já vendiam em GL/QT.
- **O SKU é compartilhado por muitas cores.** `tint_skus` = (base × embalagem × acabamento), **sem cor**; a cor vive em `tint_formulas.sku_id`. Logo **vincular 1 SKU resgata todas as cores que o usam** (ex.: `WJOB.7658 QT` → 54 cores ACR MAX de uma vez).
- **Chave de matching real:** código-base Sayer + sigla de embalagem na **descrição** do Omie (`...WJOI.7796GL`). `codigo_etiqueta` era 100% NULL e `omie_products.codigo` é PRD interno — inúteis. Sigla colada (GL/QT/BH) ou volume com espaço (`405ML`/`810ML`). Não confiar em "FOSCA/BRILHO" textual (`BRIL 05` = fosca). Prefixos alternativos pro mesmo número (`WJAB.7585` vs `WJOB.7585`) são linhas antigas, quase sempre inativas.
- **Resultado:** das 102, **62 resgatáveis** (produto Omie existe e ativo, só faltava vínculo — concentradas em `WJOB.7658`=54 e `WFOB.6564`=8) e **40 legítimas** — produtos que o negócio não vende/compra (corretas sumindo; decisão do founder de não cadastrar/reativar). O caso âncora 346J estava OK (vende em GL/QT/405; só o balde BH órfão).

### Fix
Migration `20260615182814_vincular_tint_skus_omie_orfaos.sql`: 4 `UPDATE tint_skus` **idempotentes** (só toca `omie_product_id IS NULL`) com **guard falha-fechada** — `EXISTS` produto `oben` ativo: ID errado ou produto inativo ⇒ não grava (nunca seta lixo nem NULL). 2 dos 4 resgatam as 62 cores; 2 completam cobertura.

### Verificação (camadas)
- PG17 local: idempotência (UPDATE 1 → UPDATE 0), guard barrando produto inativo, query de resgate exato.
- Banco (founder rodou): 4 vínculos ✅ ativos, resgate = **62** confirmado.
- App: founder confirmou **"preto metálico apareceu na hora"** no seletor (sem Publish — é dado; cache React Query/PWA).
- Saúde de Dados: query de ambiguidade (mesmo critério do vigia `tint_vinculo_omie`: produto em >1 SKU ativa) veio **vazia** → não criou par ambíguo, vigia verde.

### Lições (reutilizáveis)
1. **Impacto de catálogo mede-se na entidade que o usuário vê (cor), não na tabela técnica (SKU).** Contar SKUs órfãos exagera; contar cores com 0 SKU vendável é a verdade.
2. **`tint_skus` não tem cor** — é base×embalagem×acabamento, compartilhado por N fórmulas. 1 vínculo resgata N cores; ao consertar, pense em cores impactadas, não SKUs.
3. **Matching tint↔Omie:** código-base Sayer + sigla de embalagem na **descrição** do Omie. Ignore `codigo_etiqueta` (NULL) e `codigo` (PRD interno). Cuidado com prefixo alternativo (linha antiga inativa) e com "FOSCA/BRILHO" textual.
4. **Money-path "ausente ≠ ausência":** comprovar contra o catálogo **completo** + prefixos alternativos antes de declarar que não há produto. Aqui separou 62 reais de 40 descontinuadas sem remover nem inventar nada.
5. **Cross-join `ILIKE '%x%'` estoura o `statement_timeout` do SQL Editor** (wildcard nas 2 pontas = não-sargável). Pivotar pra extrair o token com regex e **JOIN por igualdade** (`=`/`IN`).
6. **Vínculo de catálogo = UPDATE idempotente + guard falha-fechada** (`WHERE ... IS NULL AND EXISTS produto ativo`). Depois, conferir o vigia `tint_vinculo_omie` (produto em >1 SKU ativa = par ambíguo que suja a Saúde de Dados).
7. **Validar cada SQL no PG17 local antes de mandar pro founder colar** — ele não tem terminal; query errada queima a vez dele (padrão `db/test-*.sh`).

### Coordenação
Sessão paralela entregou `20260615133000_tint_remapeia_skus_omie_desalinhadas.sql` (conserta 4 SKUs com vínculo **errado** — disjunto dos 4 NULL desta). Sem colisão de SKU/produto; conflito de merge foi só nos audits gerados (resolvido por `bun run audit:migrations`).
