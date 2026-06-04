# Recebimento PR2 (A1 — coreografia de escrita) — Plano de Implementação

> **For agentic workers:** execução INLINE (money-path, espelhamento helper↔edge verbatim exige controle fino). TDD em cada helper. Steps com checkbox.

**Goal:** O edge `omie-nfe-recebimento` consulta o Omie antes de escrever, reconcilia NFs já recebidas (read-only) e escreve a coreografia completa (`AlterarRecebimento`→`etapa 40`→`Concluir`→reconsulta) para NF simples, com identidade validada, gates de conversão/lote, lock e ledger fail-closed.

**Architecture:** Helper puro TDD (`src/lib/recebimento/efetivacao-helpers.ts`, estende o do PR1) é o oráculo; espelhado **verbatim** no edge Deno. Sem migration (ledger do PR1 + lock reaproveita `efetivacao_lock_at`). Frontend honesto inspeciona `res.data.modo`.

**Tech Stack:** TypeScript, vitest, Deno edge (supabase-js), React + react-query + sonner.

**Spec:** `docs/superpowers/specs/2026-06-04-recebimento-pr2-coreografia-design.md` (v2, 7 P1 do Codex incorporados).

---

### Task 1: Tipos + `extrairEstadoConsulta` (parse do ConsultarRecebimento)

**Files:** Modify `src/lib/recebimento/efetivacao-helpers.ts`; Test `src/lib/recebimento/efetivacao-helpers.test.ts`

- [ ] **Step 1** — Testes (falham): `extrairEstadoConsulta` com o body real do CALL 2 (`{cabec:{nIdReceb, cChaveNfe, cEtapa:"80"}, infoCadastro:{cRecebido:"S"}, itensRecebimento:[{itensCabec:{nSequencia:1,nIdProduto:8694686103,cCodigoProduto:"PRD03040",nQtdeNFe:229,cUnidadeNfe:"UN",cIgnorarItem:"N"},itensAjustes:{nQtdeRecebida:229}}]}`) → `{cRecebido:'S',cEtapa:'80',nIdReceb,cChaveNfe,itensOmie:[{nSequencia:1,nIdProduto:8694686103,nQtdeNFe:229,nQtdeRecebida:229,cUnidadeNfe:'UN',cIgnorarItem:false,nFatorConversao:null}]}`. Casos: body `null`/array/string → `{cRecebido:null,cEtapa:null,nIdReceb:null,cChaveNfe:null,itensOmie:[]}`; `cIgnorarItem:"S"`→true; `nFatorConversao:2` parseado; `itensRecebimento:null`→`[]`.
- [ ] **Step 2** — Tipos `ItemOmie`, `ItemApp`, `ItemEditar` exportados + `extrairEstadoConsulta`. Parse defensivo (`asRecord`, coerção `Number`/`String`, `cIgnorarItem === 'S'`).
- [ ] **Step 3** — `heavy bun run test -- efetivacao-helpers` → verde. Commit.

### Task 2: `validarIdentidade` + `decidirAcaoRecebimento` (identidade + bifurcação tríplice)

**Files:** mesmos.

- [ ] **Step 1** — Testes: `validarIdentidade({nIdReceb:1,cChaveNfe:'ABC'},{nIdReceb:1,chaveAcesso:'ABC'})`→`{ok:true}`; nIdReceb divergente→`{ok:false,erro}`; chave divergente→`{ok:false,erro}`; chave/nIdReceb null no estado→`{ok:false}`. `decidirAcaoRecebimento`: `cRecebido:'S'`→`'reconciliar'`; `cEtapa:'80',cRecebido:'N'`→`'inconsistente'`; `cEtapa:'80',cRecebido:null`→`'inconsistente'`; `cEtapa:'40'`→`'escrever'`; ambos null→`'escrever'`; `cRecebido:'s'` (minúsculo)→`'reconciliar'`.
- [ ] **Step 2** — Implementa (upper/trim; `cRecebido` é o sinal primário; `cEtapa==='80'` sem recebido = inconsistente).
- [ ] **Step 3** — Test verde. Commit.

### Task 3: `detectarConversao` + `cruzarItensParaEscrita` + `validarGatesEscrita` (gates fortes + matching)

**Files:** mesmos.

- [ ] **Step 1** — Testes:
  - `detectarConversao(itensOmie, itensApp)`: Omie `nFatorConversao:2`→`{temConversao:true,motivo}`; Omie **`nFatorConv:2`**→true; Omie com **subobjeto de conversão** (`itensConversao`/`itensNfe.nFatorConversao≠1`)→true; app `quantidade_convertida:10`→true; `unidade_nfe!==unidade_estoque`→true; tudo limpo (fator 1/null, sem convertida, unidades iguais)→`{temConversao:false}`.
  - `cruzarItensParaEscrita(itensOmie, itensApp)`: app 1 item conferido qtd 229 × Omie seq 1 nIdProduto 8694686103 → `{ok:true, itensEditar:[{itensIde:{nSequencia:1,cAcao:'EDITAR'},itensAjustes:{nQtdeRecebida:229}}], pretendidos:[{nSequencia:1,nIdProduto:8694686103,nQtdeRecebida:229}]}`; **app `produto_omie_id=111` × Omie seq 1 `nIdProduto=222` → `{ok:false}`** (Codex: casar só por sequência é furo); item app `status_item!='conferido'`→`{ok:false}`; qtd negativa/NaN→erro; `produto_omie_id` null→erro; Omie `cIgnorarItem:true`→omitido do `itensEditar`; contagem app≠Omie(não-ignorados)→erro; sequência app sem par no Omie→erro; **input fora de ordem seq 2,1 → `itensEditar`/`pretendidos` ordenados 1,2**.
  - `validarGatesEscrita(input: {statusApp; temLoteEscaneado; temConversao; motivoConversao})`: `statusApp!='conferido'`→`{ok:false,erro}`; `temLoteEscaneado:true`→`{ok:false,erro:'lote...'}`; `temConversao:true`→`{ok:false,erro:motivoConversao}`; tudo limpo→`{ok:true}`.
- [ ] **Step 2** — Implementa. `detectarConversao`: OR dos sinais (fator≠1 em `nFatorConversao`/`nFatorConv`/subobjetos `itensConversao`/`itensNfe`, `quantidade_convertida` app, unidade divergente). `cruzarItensParaEscrita`: index Omie por `nSequencia` (só não-ignorados); por item app valida `status_item==='conferido'`+qtd finita≥0+`produto_omie_id` truthy, **casa com Omie por sequência E exige `produto_omie_id===nIdProduto`**; monta `ItemEditar` + `pretendidos`(carrega `nIdProduto`); ordena ambos por sequência; contagem app(não-ignorados)≠Omie(não-ignorados)→erro. `validarGatesEscrita`: gates de status+lote+conversão como função pura (o edge calcula os booleanos via query, a decisão é pura/testável).
- [ ] **Step 3** — Test verde. Commit.

### Task 4: `confirmarEfetivacao` + `decidirStatusComConfirmacao`

**Files:** mesmos.

- [ ] **Step 1** — Testes `confirmarEfetivacao(estadoReconsulta, {chaveAcesso, pretendidos: {nSequencia,nIdProduto,nQtdeRecebida}[]})` (Codex P1.3: precisa do `nIdProduto`, que o `itensEditar` não carrega → usar `pretendidos`):
  - `cRecebido:'S'`+chave bate+cada `nSequencia`/`nIdProduto`/`nQtdeRecebida` bate→`{confirmado:true,divergencias:[]}`;
  - `nQtdeRecebida` Omie≠pretendido→`{confirmado:false,divergencias:['seq 1: qtd ...']}`;
  - **`nIdProduto` Omie≠pretendido (qtd igual)→`{confirmado:false,divergencias:['seq 1: produto ...']}`**;
  - **reconsulta SEM a sequência esperada→`{confirmado:false,divergencias:['seq 1: ausente ...']}`**;
  - `cRecebido:'N'`→`{confirmado:false}`; chave divergente→false.
  - `decidirStatusComConfirmacao({alterarOk:true,etapaOk:true,concluirOk:true,cteAplicavel:false,cteOk:false,ajustesTentados:0,ajustesOk:0}, true)`→`'efetivado'`; mesmo flags + `false`→`'efetivacao_parcial'`; `{...concluirOk:false}`+`true`→`'efetivacao_parcial'`.
- [ ] **Step 2** — Implementa (`confirmarEfetivacao` re-extrai itens da reconsulta, indexa por `nSequencia`, valida presença+produto+qtd; `decidirStatusComConfirmacao` reusa `decidirStatusEfetivacao` e rebaixa efetivado→parcial se `!recebidoConfirmado`). `cruzarItensParaEscrita` já retorna `pretendidos` (Task 3) — passar pro `confirmarEfetivacao`.
- [ ] **Step 3** — Test verde (todos os ~55 testes do arquivo). Commit.

### Task 5: Edge `omie-nfe-recebimento` — coreografia (espelha helper verbatim)

**Files:** Modify `supabase/functions/omie-nfe-recebimento/index.ts`

- [ ] **Step 1** — Espelhar verbatim no edge as 7 funções novas + tipos (bloco "ESPELHO VERBATIM"). Manter `classificarRespostaOmie`/`asRecord`/`registrarTentativa` do PR1; adicionar `erroBenigno`, `decidirStatusEfetivacao`, `selecionarPassosPendentes`, `extrairEstadoConsulta`, `validarIdentidade`, `decidirAcaoRecebimento`, `detectarConversao`, `cruzarItensParaEscrita`, `confirmarEfetivacao`, `decidirStatusComConfirmacao`.
- [ ] **Step 2** — Substituir o fluxo de efetivação atual (linhas ~291-505) pelo novo. **DETALHES CRÍTICOS (Codex risco Task 5 — não quebrar):**
  - **Manter os 2 clients** (`supabase` service role + `supabaseAuth` bearer) e o **auth staff-only ANTES de tudo**; **ramo `diagnostico:true` read-only intacto e FORA do lock**; `registrarTentativa` segue **service role** (best-effort).
  - **Shape do item:** o `select` de `nfe_recebimento_itens` precisa trazer `sequencia, produto_omie_id, quantidade_conferida, quantidade_convertida, status_item, unidade_nfe, unidade_estoque` (a interface `NfeRecebimentoItemRow` atual não tem `status_item`/`quantidade_conferida` → atualizar).
  - **Gate de lote via IDs dos itens:** `nfe_lotes_escaneados` é por **`nfe_recebimento_item_id`** (NÃO `nfe_recebimento_id`) → `count` via `.in('nfe_recebimento_item_id', itemIds)`. (Igual o edge atual lê lotes, ~linha 333.)
  - **FAIL-CLOSED em TODA query** (itens, lotes, conversão): se `error` → `falha_efetivacao` + libera lock + retorna. **NUNCA `data ?? []` em erro** antes de escrever no Omie (erro virar count 0 = entrada sem lote/sem detectar conversão).
  - **Lock:** claim `...RETURNING efetivacao_lock_at`; guarda `lockTs`; só libera no `finally` **se o claim aconteceu**, com `UPDATE ... SET efetivacao_lock_at=null WHERE id=$1 AND efetivacao_lock_at=$lockTs` (compare-and-clear).
  - Fluxo: claim (0 linhas→409); incrementa tentativas; fetch nfe; `ConsultarRecebimento({nIdReceb,cChaveNfe})`; `validarIdentidade`(!ok→falha, não toca Omie); `decidirAcaoRecebimento`:
    - **reconciliar** → flags alterar/etapa/concluir=true, status='efetivado', efetivado_at, ledger 'reconciliado', `{modo:'reconciliado',success:true}`. (NÃO chama write; NÃO seta `cte_ok`.)
    - **inconsistente** → status='falha_efetivacao'+erro, `{modo:'falha_efetivacao',success:false}`. (NÃO chama write.)
    - **escrever** → fetch itens app (fail-closed) + lote count via itemIds (fail-closed) + conversao_unidades cnpj (fail-closed); `validarGatesEscrita({statusApp, temLoteEscaneado, temConversao, motivoConversao})`→!ok falha (ANTES de qualquer write); `detectarConversao`/`cruzarItensParaEscrita`→!ok falha; passos pendentes; `AlterarRecebimento(cz.itensEditar)`/`AlterarEtapaRecebimento(40)`/`ConcluirRecebimento` (cada: classifica→erroBenigno→registrarTentativa→persiste flag; falha obrigatória→decidirStatus+persiste+`{success:false}`); reconsulta com retry curto; `confirmarEfetivacao(estado2,{chave_acesso, pretendidos: cz.pretendidos})`; `decidirStatusComConfirmacao(flags, conf.confirmado)`; persiste status (+efetivado_at se efetivado / +erro=`resumirErros`/divergências se parcial); `{modo:status,success:status==='efetivado'}`.
- [ ] **Step 3** — `deno check supabase/functions/omie-nfe-recebimento/index.ts` → erro-set net-zero vs main (typing supabase-js conhecido). Commit.

### Task 6: Frontend honesto (`Recebimento.tsx`)

**Files:** Modify `src/pages/Recebimento.tsx`

- [ ] **Step 1** — `handleEfetivar`: inspeciona `res.data` (`success`/`modo`/`erro`). `efetivado`→`toast.success('NF-e efetivada no Omie!')`; `reconciliado`→`toast.success('Reconciliada — já estava recebida no Omie.')`; `efetivacao_parcial`→`toast.warning(erro)`; `falha_efetivacao`→`toast.error(erro)`. Não declarar sucesso por ausência de `res.error`.
- [ ] **Step 2** — Botão **"Reconciliar"** em `pendente`/`divergencia` (chama `handleEfetivar`); **"Reprocessar"** em `falha_efetivacao`/`efetivacao_parcial`; **"Efetivar"** em `conferido` (existente). Reusa `handleEfetivar` (o edge decide o modo).
- [ ] **Step 3** — `heavy bun run typecheck` + `bun lint` verdes. Commit.

### Task 7: Validação final + Codex adversarial no código

- [ ] **Step 1** — `heavy bun run test` (vitest completo) + `heavy bun run typecheck` (strict) + `bun lint` + `heavy bun run build`. Todos verdes.
- [ ] **Step 2** — `deno check` net-zero confirmado.
- [ ] **Step 3** — Codex adversarial no DIFF (gpt-5.5): foco em estoque/double-count/declarar-efetivado-errado + espelhamento helper↔edge fiel. **Checklist obrigatório (Codex — orquestração não-testável localmente):** (a) reconciliação NÃO chama nenhum write do Omie; (b) inconsistente NÃO chama write; (c) lote/conversão/status falham ANTES de qualquer `AlterarRecebimento`; (d) toda query (itens/lotes/conversão) é fail-closed (erro→falha, não count 0); (e) `nfe_lotes_escaneados` contado via `nfe_recebimento_item_id`; (f) release do lock = `WHERE id AND efetivacao_lock_at=lockTs` e só se claim ocorreu; (g) as 7 funções no edge são byte-iguais ao helper. Incorporar P1/P2.
- [ ] **Step 4** — Merge `origin/main`, typecheck do tree mergeado, push, PR, auto-merge `--squash --auto`.
- [ ] **Step 5** — Deploy do edge via chat do Lovable (verbatim da main) + Publish. Registrar no CLAUDE.md. Founder testa (reconciliação + NF simples fresca).

## Notas de implementação
- **Espelho verbatim**: qualquer ajuste no helper → copiar pro edge (Deno não importa de src/).
- **Lock sem migration**: `efetivacao_lock_at` é o token (compare-and-clear pelo timestamp gravado). TTL 5min.
- **`registrarTentativa`** já existe (PR1) — usar pra cada passo (`alterar_recebimento`/`alterar_etapa`/`concluir_recebimento`/`reconciliado`/`falha`).
- **Sem migration**: confirmar que nenhuma coluna nova é necessária (ledger PR1 cobre).
