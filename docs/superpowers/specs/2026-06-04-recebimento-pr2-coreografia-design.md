# Recebimento closed-loop — PR2 (A1: coreografia de escrita) — Design v2

> Data: 2026-06-04 · Continuação da frente (PR1/A0 em prod, #576). Pós-diagnóstico read-only. Metodologia: Codex gpt-5.5 xhigh em cada etapa. **v2 incorpora os 7 furos P1 da revisão adversária do Codex no spec v1.** Founder decidiu **escrita completa já no PR2** (app ASSUME o lançamento que hoje o humano `P000209032` faz manualmente no Omie).

## 1. O que o diagnóstico revelou (muda o design)

As 2 NFs `status='pendente'` no app voltaram do `ConsultarRecebimento` **ambas `cEtapa="80"` + `infoCadastro.cRecebido="S"`** — já recebidas/concluídas no Omie (pelo humano). Confirma:

- **O caso DOMINANTE não é escrever — é reconciliar.** App importa via webservice (`cUsuarioInc="WEBSERVICE"`), humano recebe manual (`cUsuarioRec="P000209032"`), NF fica `pendente` eterno no app. A maioria das pendentes já está `cRecebido=S` no Omie.
- Campos reais (CALL 2, NF normal modelo 55): `cabec.{cEtapa, cChaveNfe, nIdReceb}`, `infoCadastro.cRecebido`, `itensRecebimento[].itensCabec.{nSequencia, nIdProduto, cCodigoProduto, nQtdeNFe, cUnidadeNfe, cIgnorarItem, nFatorConversao?}`, `itensRecebimento[].itensAjustes.{nQtdeRecebida}`.
- "2353" (`cteCfopEntrada.cCFOPEntrada="2.353"`) e `dRegistro` são do **CT-e (modelo 57, frete)** — fora do PR2.

**Design:** consultar ANTES de escrever; o estado do Omie é a fonte da verdade; ledger = auditoria/retry.

## 2. Escopo — bifurcação TRÍPLICE (Codex P1.2)

`omie-nfe-recebimento` (fluxo principal, sem `diagnostico:true`):

1. **Lock com token** (claim atômico) — 0 linhas → 409.
2. **`ConsultarRecebimento({nIdReceb, cChaveNfe})`** — consulta **com a chave** (Codex P1.1).
3. **Valida identidade** (`validarIdentidade`): `cabec.nIdReceb === omie_id_receb` **E** `cabec.cChaveNfe === nfe.chave_acesso`. Mismatch → `falha_efetivacao` motivo "identidade da NF não confere no Omie" — **não toca o Omie**.
4. **Bifurca** (`decidirAcaoRecebimento`):
   - **`cRecebido="S"`** → **RECONCILIAR**: marca `alterar/etapa/concluir_ok` + `status='efetivado'` + `efetivado_at` + ledger `operacao='reconciliado'`. **NÃO seta `cte_ok`** (CT-e fora do PR2 — Codex P2). **NÃO escreve no Omie. NÃO hidrata itens** (cortado — §5). `modo:'reconciliado'`.
   - **`cEtapa="80"` mas `cRecebido≠"S"`** → **INCONSISTENTE**: estado ambíguo (recebido-parcial/lag). NÃO escreve, NÃO reconcilia. `falha_efetivacao` motivo "etapa 80 sem cRecebido=S — requer conferência manual no Omie". (Codex P1.2: `cEtapa=80` sozinho nunca declara efetivado.)
   - **senão** (`cRecebido≠"S"` e `cEtapa≠"80"`) → **ESCREVER**.
5. **Fail-closed por passo** + **libera lock** sempre (finally, compare-and-clear pelo token).

## 3. Ramo ESCREVER — gates fortes (Codex P1.4/P1.5/P1.6)

Antes de tocar o Omie, **cruza o app com o mapa do `ConsultarRecebimento`** (não confia só no app):

1. **Status app** = `conferido` (Codex Q5: `divergencia` NÃO escreve; só reconcilia se Omie já recebeu). `pendente`/`em_conferencia` → "confira no app antes".
2. **Itens app conferidos** (`cruzarItensParaEscrita`):
   - Todo item app: `status_item='conferido'`, `quantidade_conferida` **finita e ≥ 0**, sem divergência. Algum falha → `falha_efetivacao` + motivo por item.
   - **Cruza por `nSequencia`** com os itens do Omie. Contagem/sequência/produto incompatíveis → falha. Itens Omie `cIgnorarItem="S"` são **omitidos** do `itensEditar`.
   - Item sem `produto_omie_id` (app) **ou** `nIdProduto` 0/ausente (Omie) → `falha_efetivacao` "item N sem produto associado" (item novo = Fase B).
3. **Gate de CONVERSÃO forte** (`detectarConversao` — Codex P1.5): bloqueia escrita se **qualquer** sinal: item Omie com `nFatorConversao`/`nFatorConv` ≠ 1, subobjeto de conversão, `cUnidadeNfe` ≠ unidade de estoque, app `quantidade_convertida` preenchida, **ou** `conversao_unidades` ativa por CNPJ (reforço). → `falha_efetivacao` "NF com conversão de unidade — fluxo não automatizado (follow-up)". (O `nQtdeRecebida` só é igual à `quantidade_conferida` quando NÃO há conversão.)
4. **Gate de LOTE** (Codex P1.6): se existir `nfe_lotes_escaneados` pra a NF → `falha_efetivacao` "NF com lote/validade — shape não confirmado (follow-up)". **Não dá entrada sem rastreabilidade.** Sem lote escaneado → escreve sem lote (caso dominante de SKU sem controle de lote).

Passa todos os gates → coreografia comprovada do `process-nfe`:
   1. `AlterarRecebimento` `{ide:{nIdReceb}, itensRecebimentoEditar:[{itensIde:{nSequencia, cAcao:"EDITAR"}, itensAjustes:{nQtdeRecebida}}]}` — `nQtdeRecebida = quantidade_conferida` (app). → `alterar_recebimento_ok`. (SEM departamento/lote/dRegistro — segue process-nfe.)
   2. `AlterarEtapaRecebimento` `{nIdReceb, cChaveNfe, cEtapa:"40"}` → `alterar_etapa_ok` (benigno "já na etapa").
   3. `ConcluirRecebimento` `{nIdReceb, cChaveNfe}` → `concluir_recebimento_ok` (benigno "já concluído"). **A conclusão dá entrada no estoque no Omie.**
   4. **`ConsultarRecebimento({nIdReceb, cChaveNfe})` de novo** → `confirmarEfetivacao` (Codex P1.3): valida `cRecebido="S"` **E** chave **E** cada `nSequencia`/`nIdProduto` **E** `itensAjustes.nQtdeRecebida === quantidade_conferida` pretendida. Confirmado → `efetivado`; divergiu/não-recebido → **`efetivacao_parcial`** com o detalhe das divergências (fail-closed). Com **retry/backoff curto** antes de declarar parcial (lag do Omie — Codex Q3).

## 4. Decisões de redução de escopo (cravadas)

| Item | Decisão | Por quê |
|---|---|---|
| **Departamento / `dRegistro`** | **NÃO enviar** | `process-nfe` não envia e funciona; Omie preenche `dRegistro=hoje` na conclusão. Codex: seguro p/ estoque. |
| **`2353`/CT-e** | **CORTAR** (PR3); **não setar `cte_ok`** | CT-e = recebimento separado (modelo 57). Codex P2. |
| **Lote/validade** | **GATE honesto** (não corte cego) | NF com `nfe_lotes_escaneados` → falha honesta. Cortar global daria entrada sem rastreabilidade (Codex P1.6). |
| **Conversão (Sayerlack)** | **GATE forte** (não só CNPJ) | Detecta pelo fator do Omie + app + CNPJ. Escrever com conversão = quantidade/unidade errada (Codex P1.5). |
| **`IncluirAjusteEstoque`** | **CORTAR** (segue do gate de conversão) | NÃO-idempotente, shape não confirmado. |
| **Item NOVO** | **CORTAR** (Fase B) | Gate olha `nIdProduto` real da consulta Omie (Codex). |
| **Hidratação de itens na reconciliação** | **CORTAR** (PR2) | Adiciona shape/dedup/colunas obrigatórias e risco de poluir a tabela. Reconciliar = marcar status (suficiente). Histórico de itens = follow-up. |
| **Reconciliação em massa** | **Manual 1-a-1** | Botão por NF; varredura = follow-up. |

**Cobertura efetiva do PR2:** NF "simples" (sem lote escaneado, sem conversão de unidade, itens já associados ao Omie) → `efetivado`. Todo o resto → falha/parcial **honesta** com motivo (nunca entrada de estoque errada silenciosa).

## 5. Helper puro — estende `src/lib/recebimento/efetivacao-helpers.ts` (oráculo TDD, espelhado no edge)

Reusa do PR1: `classificarRespostaOmie`, `erroBenigno`, `decidirStatusEfetivacao`, `selecionarPassosPendentes`, `podeReprocessar`, `resumirErros`. Novas funções puras:

1. **`extrairEstadoConsulta(body): { cRecebido: string|null; cEtapa: string|null; nIdReceb: number|null; cChaveNfe: string|null; itensOmie: ItemOmie[] }`** — parse robusto. `ItemOmie = { nSequencia: number; nIdProduto: number|null; cCodigoProduto: string|null; nQtdeNFe: number; nQtdeRecebida: number|null; cUnidadeNfe: string|null; cIgnorarItem: boolean; nFatorConversao: number|null }`. Tolera null/array/string/keys ausentes.
2. **`validarIdentidade(estado, esperado: { nIdReceb: number; chaveAcesso: string }): { ok: boolean; erro: string|null }`** — `cabec.nIdReceb`/`cChaveNfe` batem com o banco. (Codex P1.1.)
3. **`decidirAcaoRecebimento(estado): 'reconciliar' | 'escrever' | 'inconsistente'`** — `cRecebido` upper=='S' → reconciliar; `cEtapa` trim=='80' (e não recebido) → inconsistente; senão escrever. (Codex P1.2.)
4. **`detectarConversao(itensOmie, itensApp: ItemApp[]): { temConversao: boolean; motivo: string|null }`** — fator≠1 / subobjeto / unidade divergente / `quantidade_convertida` app. `ItemApp = { sequencia; quantidade_conferida; produto_omie_id; status_item; quantidade_convertida; unidade_nfe; unidade_estoque }`. (Codex P1.5.)
5. **`cruzarItensParaEscrita(itensOmie, itensApp): { ok: boolean; erro: string|null; itensEditar: ItemEditar[]; pretendidos: ItemPretendido[] }`** — matching por `nSequencia` **E `produto_omie_id===nIdProduto`** (Codex: só sequência é furo); omite `cIgnorarItem`; valida conferido/qtd/produto/contagem; ordena por sequência. `ItemEditar = { itensIde:{nSequencia, cAcao:'EDITAR'}, itensAjustes:{nQtdeRecebida} }`; `ItemPretendido = { nSequencia; nIdProduto; nQtdeRecebida }` (carrega o produto pra a reconsulta, que o `itensEditar` não tem). (Codex P1.4.)
6. **`confirmarEfetivacao(estadoReconsulta, esperado: { chaveAcesso; pretendidos: ItemPretendido[] }): { confirmado: boolean; divergencias: string[] }`** — `cRecebido='S'` + chave + por item `nSequencia` presente + `nIdProduto` + `nQtdeRecebida===pretendido`. (Codex P1.3 — usa `pretendidos`, não `itensEditar`.)
7. **`validarGatesEscrita(input: { statusApp: string; temLoteEscaneado: boolean; temConversao: boolean; motivoConversao: string|null }): { ok: boolean; erro: string|null }`** — gate puro testável: `statusApp!=='conferido'` / `temLoteEscaneado` / `temConversao` → `{ok:false, erro}`. O edge calcula os booleanos via query (fail-closed); a decisão é pura. (Codex: lote/conversão viram teste.)
8. **`decidirStatusComConfirmacao(flags: PassoFlags, recebidoConfirmado: boolean): EfetivacaoStatus`** — `decidirStatusEfetivacao(flags)`; se `'efetivado'` mas `!recebidoConfirmado` → rebaixa pra `'efetivacao_parcial'`.

## 6. Edge `omie-nfe-recebimento` (fluxo principal A1)

```
[mantém auth staff-only do PR1 — Codex P2]   [mantém ramo diagnostico:true do PR1]
token = uuid()
claim: UPDATE nfe_recebimentos SET efetivacao_lock_at=now(), efetivacao_lock_token=token
       WHERE id=$1 AND (efetivacao_lock_at IS NULL OR efetivacao_lock_at < now()-interval '5 min')
       RETURNING id           -> 0 linhas? 409
incrementa efetivacao_tentativas
fetch nfe (omie_id_receb, chave_acesso, status, cnpj_emitente, warehouses(code), flags ledger)
consulta1 = ConsultarRecebimento({nIdReceb, cChaveNfe: chave_acesso}) -> classifica; falha -> falha_efetivacao
estado = extrairEstadoConsulta(consulta1.body)
validarIdentidade(estado, {nIdReceb, chave_acesso}) -> !ok: falha_efetivacao (não toca Omie)
acao = decidirAcaoRecebimento(estado)
  'reconciliar': flags alterar/etapa/concluir=true; status='efetivado'; efetivado_at; ledger 'reconciliado'; {modo:'reconciliado'}
  'inconsistente': falha_efetivacao "etapa 80 sem cRecebido=S"; {modo:'falha_efetivacao'}
  'escrever':
     fetch itens app; fetch nfe_lotes_escaneados (count); fetch conversao_unidades (cnpj)
     gate status=conferido; detectarConversao -> falha; lote escaneado -> falha
     cz = cruzarItensParaEscrita(estado.itensOmie, itensApp) -> !ok: falha_efetivacao + motivo
     passos = selecionarPassosPendentes(flags ledger)
     AlterarRecebimento(cz.itensEditar) [se pendente] -> classifica/benigno -> persiste alterar_recebimento_ok
     AlterarEtapaRecebimento(40)        [se pendente] -> persiste alterar_etapa_ok
     ConcluirRecebimento                 [se pendente] -> persiste concluir_recebimento_ok
       (cada falha obrigatória: decidirStatusEfetivacao; persiste status+erro; libera lock; {success:false})
     consulta2 = ConsultarRecebimento({nIdReceb, cChaveNfe}) [retry/backoff curto]
     conf = confirmarEfetivacao(extrairEstadoConsulta(consulta2.body), {chave_acesso, itensEditar: cz.itensEditar})
     status = decidirStatusComConfirmacao(flags, conf.confirmado)
     persiste status (+ efetivado_at se efetivado) (+ erro = conf.divergencias se parcial); {success: status=='efetivado', modo: status}
finally: liberar lock (UPDATE SET efetivacao_lock_at=null, efetivacao_lock_token=null WHERE id=$1 AND efetivacao_lock_token=token)  [compare-and-clear — Codex P1.7]
```

- **Lock token sem migration:** `efetivacao_lock_token` exigiria coluna. **Decisão: reaproveitar `efetivacao_lock_at` como token** — o claim faz `RETURNING efetivacao_lock_at` (timestamp gravado), guardo o valor, e o release é `UPDATE ... SET efetivacao_lock_at=null WHERE id=$1 AND efetivacao_lock_at=$valor_gravado` (compare-and-clear: só limpo se o lock ainda é o meu). TTL **5 min** > pior caso da coreografia (~1 min com retries). Race residual (operação >5min sem crash) mitigada pelas flags por passo + `erroBenigno` + consultar-antes (o 2º request vê `cRecebido=S` e reconcilia). **Sem migration nova.** (Codex P1.7 atendido sem coluna.)
- `cChaveNfe` = `nfe.chave_acesso` (NOT NULL); **sem fallback da chave do Omie pra escrever** (Codex P1.1).
- Espelho **verbatim** das funções puras.

## 7. Frontend honesto (`Recebimento.tsx`)

- `handleEfetivar` inspeciona **`res.data.success` E `res.data.modo`** (não só `res.error` — falha honesta vem HTTP 200, Codex P2): `efetivado`/`reconciliado` → success (mensagens distintas); `efetivacao_parcial` → warning + `efetivacao_erro`; `falha_efetivacao` → error + motivo.
- Botão **"Efetivar"** em `conferido`. Botão **"Reconciliar"** em `pendente`/`divergencia` (mesmo edge → reconcilia se Omie recebeu, senão erro honesto). Botão **"Reprocessar"** em `falha_efetivacao`/`efetivacao_parcial`. (Status já no `STATUS_CONFIG` + abas, PR1.)

## 8. Testes (helper puro, vitest) — estende os 30 do PR1

- `extrairEstadoConsulta`: CALL 2 real → `{cRecebido:'S', cEtapa:'80', nIdReceb, cChaveNfe, itensOmie:[1 item]}`; body null/array/string → defaults; keys ausentes; `cIgnorarItem`/`nFatorConversao` parseados.
- `validarIdentidade`: match → ok; nIdReceb divergente → erro; chave divergente → erro.
- `decidirAcaoRecebimento`: `cRecebido='S'` → reconciliar; `cEtapa='80'`+`cRecebido='N'` → inconsistente; `cEtapa='40'` → escrever; ambos null → escrever.
- `detectarConversao`: fator 2 no Omie → true; `quantidade_convertida` app → true; unidade divergente → true; tudo limpo → false.
- `cruzarItensParaEscrita`: shape exato + ordena; `cIgnorarItem` omitido; item app não-conferido → erro; qtd negativa/NaN → erro; produto ausente → erro; contagem app×Omie divergente → erro.
- `confirmarEfetivacao`: tudo bate → confirmado; `nQtdeRecebida` divergente → não confirmado + divergência; `cRecebido='N'` → não confirmado.
- `decidirStatusComConfirmacao`: todos ok + confirmado → efetivado; todos ok + não confirmado → parcial; alterar só → parcial.

## 9. Validação + teste do founder

- Helper: vitest. Edge: `deno check` net-zero vs main. typecheck strict + lint + build.
- **Sem migration** (ledger do PR1 cobre; lock reaproveita `efetivacao_lock_at`).
- **Sem teste local contra o Omie.** O founder testa:
  - **Reconciliação:** efetivar/reconciliar uma pendente que ele sabe recebida no Omie → vira `efetivado`, **nada muda no Omie** (read-only) → seguro.
  - **Escrita:** NF **fresca** (`<80`, não recebida), **sem lote, sem conversão, itens associados**, **conferir no app** (fluxo existente → `conferido`), efetivar → acompanha ir a "Concluído" + estoque mover. Baixo valor primeiro.
- Lock + flags por passo + `erroBenigno` + consultar-antes garantem que re-testar **não duplica**.

## 10. Riscos (Codex)
1. **Double-count por retry/paralelismo** → lock token + flags por passo + `erroBenigno`.
2. **Escrever numa NF já recebida** → consultar-ANTES + `decidirAcaoRecebimento` (cRecebido=S nunca escreve).
3. **NF errada** (nIdReceb stale) → `validarIdentidade` (chave + nIdReceb).
4. **Declarar efetivado sem o Omie concluir/quantidade errada** → reconsulta valida cRecebido=S **+ quantidades por item**.
5. **Estoque errado por conversão/lote** → gates fortes (não escreve; follow-up).
6. **Quantidade fabricada** → `nQtdeRecebida` só da `quantidade_conferida`; sem itens conferidos = erro, não 0.

## 11. Cortes explícitos (follow-ups nomeados)
- **PR3 — CT-e** (modelo 57, CFOP 2.353, `dRegistro`, associação por chave).
- **Fase B — item novo** (criar produto + de-para).
- **Lote/validade** no AlterarRecebimento (precisa diagnóstico de NF com lote).
- **Conversão (Sayerlack)** + `IncluirAjusteEstoque` idempotente.
- **Hidratação de itens** na reconciliação.
- **Reconciliação em massa** (varredura).
- **Departamento/`dRegistro`** explícitos.

## 12. Veredito Codex v1 → v2 (P1 incorporados)
Os 7 P1 do Codex v1 incorporados: (1) identidade por chave; (2) bifurcação tríplice (cEtapa=80 sem cRecebido=S = inconsistente); (3) reconsulta valida quantidades; (4) cruzamento item-a-item app×Omie; (5) gate de conversão pelo fator do Omie; (6) lote vira gate honesto; (7) lock compare-and-clear. P2/P3: não setar `cte_ok` na reconciliação; hidratação cortada; guard staff-only mantido; `modo` = nome do status; frontend trata `success:false` em HTTP 200.
