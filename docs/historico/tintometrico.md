# Tintométrico — entregas e lições

Narrativa das entregas do módulo tintométrico (`/tintometrico/*`, account `oben`). Registre aqui ao concluir; regras vivas vão pro CLAUDE.md, lição reutilizável pra `docs/agent/`.

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
- Pós-deploy (pendente): 1 full sync inicial popula `hashes.json`; depois deltas ~0; queda de runs/hora em `tint_sync_runs`.

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
