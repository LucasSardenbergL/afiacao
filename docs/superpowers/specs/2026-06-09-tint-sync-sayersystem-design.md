# Tintométrico — Sync automático SayerSystem → app (conector PG + promoção staging→oficial)

**Data:** 2026-06-09 · **Status:** aprovado pelo founder (design verbal); spec p/ plano
**Frente:** roadmap-sessao.md §17 · **Decisor técnico:** delegado (eu + codex)

> ⚠️ **Caminho B em vigor (codex em usage-limit até 11/06 9h24):** revisão adversária feita por mim (7 vetores, achados em §11) + **PG17 como oráculo** da promoção; **codex adversarial RETROATIVO obrigatório quando a cota voltar** (precedente: frente `aplicar_promocoes`, §10 do CLAUDE.md).

## 1. Problema

O founder exporta CSVs do **SAYERSYSTEM** (software de tintometria da Sayerlack, desenvolvido pela **Dnaxis**) e faz upload manual em `/tintometrico/importar`. Fórmulas novas/alteradas e **preços que ele edita no SayerSystem** ficam desatualizados no app até o próximo upload. Objetivo: **eliminar a tarefa manual** — o app reflete o SayerSystem sozinho.

## 2. Fatos coletados (Fase 0 — NÃO re-perguntar à Dnaxis)

Fontes: **"Manual de Integração com ERP"** (Dnaxis, 05/08/2025, PDF com o founder; pág 7-8 = tabelas, pág 9 = cálculo de custo) + **Kelly (Dnaxis, ramal 9540)** via WhatsApp, 2026-06-09.

### 2.1 Caminhos oficiais de integração
- **Arquivo texto (CSV/TXT):** export **SEMPRE MANUAL** (Menu → Integração ERP → marca produtos → gerar). NÃO existe export automático — o que atualiza a cada 10 min é o **banco local** (recebe novidades da matriz). Arquivo **por produto**, UTF-8, separador `;`, decimal `,`. Sempre traz **todas** as fórmulas (snapshot). Exclusão = **some do arquivo**. Pasta de destino é escolhível.
- **Banco PostgreSQL local (RECOMENDADO pela Dnaxis):** host `localhost` (ou IP da máquina), porta **5986**, banco **`client_industrial_sayerlack`**, usuário/senha **`integra`/`integra`** (ativos, confirmado). **Somente leitura** (rejeita DML). Aceita conexão de outro software na mesma máquina e da rede. Schema raramente muda; quando muda, avisam **no próprio sistema**.
- **API:** não existe.

### 2.2 Tabelas (manual pág 7-8 + Kelly)
| Tabela | Conteúdo | Chaves/notas |
|---|---|---|
| `PRODUTO` | id + descrição do produto comercial | `id_produto` |
| `BASE` | id + descrição das bases (3~4 por produto) | `id_base` |
| `EMBALAGENS` | descrição + conteúdo (volume) | `id_emb` |
| `PRODUTO_BASE_EMBALAGEM` | embalagens vendáveis por produto×base | `id_produto, id_base, id_emb` |
| `CORANTES` | ids + descrição dos componentes | `id_corante` |
| `PADRACOR` | cores de catálogo | `id_padraocor` |
| `FORMULA` | fórmulas; **volume = embalagem de FORMULAÇÃO do laboratório** (`id_embalagem`) → **regra de 3 obrigatória** p/ embalagem vendida | liga a `PADRACOR` por `id_padraocor`; chaves `id_produto, id_base, id_emb, id_padraocor` |
| `COLECAO` / `SUBCOLECAO` | coleções/subcoleções das cores | `id_colecao` |
| `PERSONCOR` / `FORMULAPERSON` | cores + fórmulas **personalizadas do lojista** (Dnaxis recomenda capturar) | idem |
| `VENDAS` / `VENDAS_ITEM` | cada dosagem feita na máquina (pai/filho) | **v2** |
| `PRECO_CORANTE` / `PRECO_BASEEMB` | **preço/custo da tela de Preços** (custo base, imposto, margem, custo corante + volume) | Kelly; colunas exatas a confirmar no discovery |

- **Unidade:** quantidades em **ML** no banco (onça192/shot é só exibição).
- **Delta:** TODA tabela tem **`data_atualizacao`** (muda em UPDATE; `data_inclusao` fixa; registro novo = iguais).
- **Exclusão:** o registro **some do banco** (sem soft-delete na origem).
- **Cálculo de custo (pág 9, idêntico ao `useTintPricing` do app):** `preço final = custo_base×(1+imposto)×(1+margem) + Σ(qtd_ml × custo_corante/volume_corante)`. Corantes **sem** imposto/margem — comportamento documentado do SayerSystem (a "inconsistência" apontada pelo codex no app é fidelidade by design).
- Etiqueta térmica EAN-13 (pág 10): código SKU + valor da fórmula — **v2/PDV**.
- Suporte Dnaxis: (19) 2516-9532/9546 · WhatsApp (19) 9 9440-1120 · suportesayersystem@dnaxis.com.br.

### 2.3 Ambiente
PC Windows no balcão, ligado o dia todo, com internet. 1 loja hoje (infra multi-loja por `store_code`). Founder não-técnico: instalação tem que ser "instala e esquece".

## 3. O que JÁ existe no app (não reconstruir)

- **Edge `tint-sync-agent`** (`supabase/functions/tint-sync-agent/index.ts`, 657 linhas): auth por token (`x-sync-token` + `x-store-code`, timing-safe, vs `tint_integration_settings`), idempotência por `x-idempotency-key` (índice único + resposta cacheada), endpoints `/heartbeat`, `/test`, `/catalogs`, `/formulas`, `/preparations`, `/simulate`, `/reconcile`. Grava **só em `tint_staging_*`**; reconciliação por `tint_run_reconciliation()` (SQL). Modos: `csv_only` → `shadow_mode` → `automatic_primary`.
- **Telas:** `/tintometrico/integracao` (hub), `TintIntegrations` (lojas/token/health por heartbeat), `TintSyncRuns`, `TintReconciliation`, `TintApiContract` (contrato documentado).
- **Import CSV** (`tint-import`): referência de como gravar o oficial — cadeia `ensure*` (produto→base→embalagem→sku→subcoleção→corantes), upsert fórmula pela chave única **`uq_tint_formulas_chave`** `(account, cor_id, produto_id, base_id, COALESCE(subcolecao_id, zero-uuid), embalagem_id)`, itens delete+insert.

### 3.1 Furos confirmados (codex adversarial + verificação minha no código)
1. **Não existe promoção staging→oficial em lugar nenhum** (edge/migrations/RPC/telas — grep limpo). `automatic_primary` é configurável mas **fantasma**: tudo para no staging. **⇒ é a peça central a construir.**
2. `checkIdempotency` (`index.ts:133`): replay de run `running`/sem resposta salva retorna **sucesso zerado** — esconde crash anterior.
3. Erros ao inserir **itens** de fórmula/preparação são engolidos (`index.ts:380`, só `console.error`).
4. Reconciliação nunca incrementa `only_csv` → não enxerga deleção.
5. `tint_formulas` **não tem coluna de desativação** — fórmula que some do SayerSystem ficaria viva na busca do balcão pra sempre.
6. Heartbeat = processo vivo, não extração saudável.

## 4. Arquitetura

```
PC do balcão (Windows)                         Supabase (Lovable Cloud)
┌─────────────────────────────┐               ┌──────────────────────────────────┐
│ SayerSystem                 │               │ edge tint-sync-agent             │
│  └─ PostgreSQL :5986        │   HTTPS POST  │  ├─ /catalogs /formulas (já há)  │
│     (integra/integra, RO)   │──────────────▶│  ├─ /keys-snapshot (NOVO)        │
│ sayersync.exe (Go, serviço) │  token+idem   │  └─ heartbeat+discovery          │
│  ├─ delta data_atualizacao  │               │        ▼ staging tint_staging_*  │
│  ├─ keys snapshot 1×/dia    │               │ tint_promote_sync_run() (NOVO)   │
│  ├─ heartbeat + schema fp   │               │  ├─ regra de 3 (expansão emb.)   │
│  └─ auto-update             │               │  ├─ preço reproduzido (pág 9)    │
└─────────────────────────────┘               │  └─ upsert oficial + desativação │
                                              │        ▼ tint_* oficiais → app   │
                                              └──────────────────────────────────┘
```

**Princípio:** conector **burro e fiel** (copia o banco como está; zero regra de negócio); **toda inteligência no servidor** (regra de 3, preço, promoção, deleção) — corrigível sem tocar na máquina do balcão. Staging guarda o dado **cru** (auditável contra a origem).

## 5. Conector `sayersync` (Go, novo, pasta `connector/sayersync/`)

- **Stack:** Go, binário único `windows/amd64`, sem runtime. Serviço Windows (kardianos/service): install/start/restart automático. (Codex preferia .NET por causa do SQL CE legado; com PostgreSQL o motivo sumiu — Go ganha por binário único + cross-compile do macOS.)
- **Comandos:** `install` (pede URL/store_code/token, grava config, registra serviço), `uninstall`, `run` (loop do serviço), `once` (1 ciclo, debug), `discovery` (despeja schema em `sayersystem-schema.txt`).
- **Config** `config.json` ao lado do exe: app URL, store_code, intervalo (default 10 min), conn PG local. **Token protegido com DPAPI** (CryptProtectData, escopo máquina+usuário do serviço); fallback claro se DPAPI indisponível.
- **Ciclo (a cada 10 min):**
  1. Conecta PG local (timeout 10s, conexão curta, `ReadCommitted`, **`client_encoding=UTF8`** — origem pode ser latin1/win1252; o PG converte na saída).
  2. **Valida schema** contra o mapeamento embutido (`information_schema`): diverge → **fail-closed**: não sinca, grava `sayersystem-schema.txt`, heartbeat com `schema_mismatch` (founder me manda o txt; eu ajusto e solto update). Bate → segue.
  3. Por entidade (ordem: produto, base, embalagens, produto_base_embalagem, corantes, preco_corante, preco_baseemb, padracor+colecao+subcolecao, formula, personcor+formulaperson): `SELECT` delta `WHERE data_atualizacao > (checkpoint − 5 min) OR data_atualizacao IS NULL` → mapeia pro contrato → POST em lotes ≤1000 com `x-idempotency-key` (uuid v4 por lote) → retry/backoff (3×, exponencial) → **checkpoint local (`state.json`) só avança após 2xx**. **Checkpoint = high-water mark `MAX(data_atualizacao)` observado no resultado** (relógio do PG ORIGEM, nunca `now()` do conector — §11 P1-D: clock skew do PC do balcão não perde registro).
  4. Heartbeat com `agent_version, hostname, uptime, db_connected, schema_fingerprint, last_cycle_counts`.
- **1×/dia:** snapshot de **chaves** por entidade (`snapshot_id` uuid + `generated_at` + `total_chunks`) → POST `/keys-snapshot` (chunked se >5MB) → servidor desativa o que sumiu (guardas em §6.2.5).
- **1×/semana (domingo de madrugada):** **full re-scan** (ignora checkpoint, re-envia tudo) — rede de segurança contra UPDATE na origem que não toque `data_atualizacao` (trigger ausente/bug do fabricante); upsert idempotente absorve sem efeito colateral.
- **Primeira execução:** checkpoint zero = full sync (mesma mecânica, sem caso especial).
- **Auto-update:** 1×/dia baixa manifest (Supabase Storage: **bucket público só-leitura, escrita só `service_role`**; versão + sha256 + URL); hash confere **e versão > atual** (anti-downgrade com manifest velho) → troca binário + restart; crash-loop (3 falhas em 10 min) → rollback pro binário anterior (mantido como `.prev`). Assinatura Authenticode = v2 (modelo de ameaça v1: comprometer o Storage já = comprometer o backend inteiro).
- **Serviço roda como `LocalService`** (least privilege; só precisa de localhost + HTTPS de saída); DPAPI em escopo de máquina.
- **Estrutura da FORMULA desconhecida em detalhe** (itens achatados `corante1..6` como o CSV, ou tabela filha): o discovery decide; o conector embute **os dois mapeadores** e escolhe pelo schema encontrado.
- **Logs:** arquivo local rotacionado (tamanho), nível info.

## 6. Servidor — contrato (extensões) e promoção

### 6.1 Extensões de contrato (edge `tint-sync-agent`)
- `/catalogs`: corantes ganham `custo` + `volume_ml` opcionais (de `PRECO_CORANTE`); payload novo `precos_base[]` `{cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct}` (de `PRECO_BASEEMB`; nomes a confirmar no discovery) → staging novo `tint_staging_precos_base`.
- **`POST /keys-snapshot` (novo):** `{entity, keys[], chunk_index, total_chunks}` por entidade; auth de agente; aplica desativação via SQL (abaixo).
- `/formulas`: semântica documentada — `id_embalagem` = **embalagem de formulação**; `volume_final_ml` = volume dela; itens em ML crus. (Contrato já comporta; muda a documentação em `TintApiContract`.)
- **Fixes dos furos §3.1:** (2) replay de run `running`/sem resposta → HTTP 409 `retry_later` (não sucesso falso); (3) erro de item → conta em `error_count` + `errors[]` + `tint_sync_errors`; (6) heartbeat persiste `schema_fingerprint`/mismatch no settings (tela mostra).

### 6.2 Promoção `tint_promote_sync_run(p_sync_run_id)` (SQL, SECURITY DEFINER, a peça central)
Disparada pela edge ao fim de `/catalogs`/`/formulas`/`/keys-snapshot` **quando `integration_mode = 'automatic_primary'`** (em `shadow_mode` para no staging+reconcile — comportamento atual preservado).

**Princípio (endurecido §11 P1-C): a promoção aplica o "ÚLTIMO staging por chave natural"**, restrito às chaves tocadas pelo run — nunca "os itens deste run" cegamente. Imune a duplicata entre runs, re-envio pós-crash e lotes fora de ordem; re-rodar = mesmo estado (idempotente por construção).

1. Cria `tint_importacoes` `(tipo='sync_agent', arquivo_nome='sync:<run_id>', arquivo_hash=run_id)` → `importacao_id` (reusa a tela de histórico de graça).
2. **Catálogo:** upsert `tint_produtos/bases/embalagens/corantes/skus` a partir do latest-staging das chaves do run, espelhando os `onConflict` do `tint-import` (`account,cod_produto` etc.). `tint_skus` nasce de `produto_base_embalagem` (= `/catalogs.skus`). **Skus NOVOS criados → re-expandir as fórmulas dos pares (produto,base) afetados** a partir do latest-staging de fórmula (§11 P1-C: embalagem que chega depois da fórmula ganharia fórmula nunca, pois `data_atualizacao` da FORMULA não muda).
3. **Fórmulas:** para cada chave de fórmula tocada (latest staging):
   - resolve FKs (produto/base/embalagem de formulação/subcoleção); corante referenciado e ausente → **stub** (descricao=código, comportamento herdado do CSV-import);
   - **guarda:** `vol_emb_formulação <= 0 OR NULL` → não promove + `tint_sync_errors` (nunca divide por zero/NaN);
   - **expande SÓ por embalagens vendáveis** do par (produto, base) em `tint_skus` (a linha da embalagem de formulação NÃO vira fórmula oficial se não for vendável — o CSV nunca criava; pôr emb não-vendável na busca do balcão é bug). Zero embalagens vendáveis → não promove + erro (resolve quando `/catalogs` completar);
   - `fator = vol_emb_destino / vol_emb_formulação`; `qtd_ml_item × fator`; `volume_final_ml = vol_emb_destino`;
   - **preço reproduzido (pág 9):** `preco_final = custo_base(emb)×(1+imposto)×(1+margem) + Σ(qtd_expandida × custo_corante/volume_corante)` com insumos de `tint_staging_precos_base`/corantes; **insumo faltando → `preco_final = NULL`** (degradação honesta; nunca 0); arredondamento default `round2` no total — **calibrar contra o gabarito** antes do flip;
   - upsert por `uq_tint_formulas_chave`; itens **delete+insert** na mesma transação; `desativada_em = NULL` (reativa se voltou).
4. **💰 Recálculo de preço por mudança de INSUMO (§11 P1-A — o caso de uso PRINCIPAL):** mudança de preço no SayerSystem toca `PRECO_BASEEMB`/`PRECO_CORANTE`, **não** a FORMULA → sem este passo o app continuaria com preço velho exatamente no fluxo que motivou a feature. A promoção de `precos_base` recalcula `preco_final` das fórmulas do par (produto,base,emb); a de corantes (custo/volume), das fórmulas que usam o corante (via `tint_formula_itens`). Recálculo **só do preço** (não re-expande itens).
5. **Deleção (`/keys-snapshot`, guardas §11 P1-B):** aplica **somente** com snapshot COMPLETO (`total_chunks` todos recebidos, montado por `snapshot_id`); ignora snapshot com `generated_at` ≤ último aplicado (fora de ordem); **trava de blast radius**: se for desativar >20% das fórmulas ativas OU o snapshot tiver menos chaves que 50% do oficial ativo → **ABORTA** + `tint_sync_errors` (snapshot legítimo nunca faz isso; chunk perdido não apaga a loja). Passando: fórmula oficial fora do snapshot → `desativada_em = now()` (**soft**; reversível; nunca delete físico). Catálogo: corantes/produtos sumidos → `ativo=false` se a coluna existir; senão só fórmulas na v1.
6. Contadores → `tint_sync_runs` (inserts/updates) + `tint_importacoes`; staging com mais de 30 dias → purge (na própria promoção); runs presos em `running` >30min → `error` (varredura, padrão `fin_sync_log`).

**Oráculo TDD:** helper puro `src/lib/tint/sync-promote.ts` (`expandirFormula`, `precoFinalSayer`, `aplicarKeysSnapshot` — regra de 3, arredondamento, preço) com testes vitest, **espelhado verbatim** no SQL; validação **PG17** (`db/test-tint-promote.sh`, padrão da casa: semeia staging → roda promoção → asserts de expansão/preço/deleção/reativação/idempotência — rodar 2× = mesmo estado).

### 6.3 Desativação no app
- Coluna `tint_formulas.desativada_em timestamptz NULL` + índice parcial.
- Filtro `.is('desativada_em', null)` nos consumidores de **busca/venda**: `useTintColorSelect`, `TintFormulas`, `TintCatalogo`, `TintPricing`, `useGlobalSearch`, `useTintometricoZone`. Telas de gestão podem exibir com badge "desativada".

## 7. Preço — escopo v1

O app já tem `preco_final_sayersystem` por fórmula×embalagem e a cadeia de prioridade do balcão (último praticado → sayersystem → calculado Omie). **v1 NÃO muda política**: só mantém `preco_final_sayersystem` **fresco** (promoção). O cálculo Omie continua como contraprova (alerta de divergência existente). Os 3 campos do codex (`sayer_reference/calculated/effective`) ficam **anotados pra v2** — sem necessidade enquanto o founder governa preço no SayerSystem.

## 8. Validação e rollout (gabarito)

1. **Build + deploy:** migrations (SQL Editor, founder cola) + edge `tint-sync-agent` (chat do Lovable, verbatim da main) + binário no Storage.
2. **Instalação (founder, 1 página):** baixar `sayersync.exe` → `sayersync install` (cola URL + store_code + token da tela TintIntegrations) → serviço sobe → heartbeat verde na tela. Modo: **`shadow_mode`**.
3. **Full sync → staging → reconciliação** contra o oficial (último CSV importado): `TintReconciliation` mostra divergências (esperado: o que mudou desde o último upload manual).
4. **Gabarito:** founder exporta o CSV **uma última vez** → comparo (a reconciliação + script) — em especial `PRECO_FINAL` e quantidades expandidas, que validam **regra de 3 + reprodução de preço contra o cálculo do próprio SayerSystem**. Arredondamento observado no gabarito.
5. Divergência zero (ou explicada = dado mais novo no banco) → **`automatic_primary`**. CSV aposentado.
6. **Critério de pronto:** founder altera um preço no SayerSystem → app reflete em ≤ ~15 min, sem ação humana.

## 9. Não-objetivos (v1)
- `VENDAS`/`VENDAS_ITEM` → `/preparations` (consumo de corante, analytics) — **v2**; endpoint pronto.
- Etiqueta EAN-13 / PDV (pág 10) — v2.
- Multi-loja ativa (suportada por design; testada com 1).
- Check do Sentinela (`_data_health_compute` é arquivo quente multi-sessão — follow-up isolado pós-v1; a tela de health do tint cobre o início).
- Reescrita da política de preço (3 campos) — v2.
- Mexer no fluxo CSV manual (continua funcionando como fallback).

## 10. Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Nomes de coluna reais ≠ esperados | Discovery + fail-closed no conector; mapeadores duais p/ FORMULA; 1 ida-e-volta no pior caso |
| Regra de 3/arredondamento ≠ SayerSystem | Gabarito CSV valida contra o cálculo deles antes do automatic_primary |
| PG local recusa conexão | Conector roda na MESMA máquina (localhost); Kelly confirmou acesso por software próprio |
| Máquina desligada/sem internet | Delta por checkpoint cobre o gap ao voltar; heartbeat some → tela mostra offline |
| Schema muda em update do SayerSystem | Fingerprint → fail-closed + aviso; Dnaxis avisa no sistema; raro |
| Promoção parcial (crash no meio) | Promoção transacional por entidade; idempotente (re-rodar = mesmo estado); PG17 prova |
| Replay falso pós-crash | Fix §6.1(2): 409 em run `running` |

## 11. Revisão adversária (Caminho B — codex em usage-limit; retroativo pendente)

Auto-revisão disciplinada nos 7 vetores preparados pro codex. Achados INCORPORADOS acima:

- **P1-A — Recálculo de preço por mudança de insumo (§6.2.4).** Mudar preço no SayerSystem toca `PRECO_BASEEMB`/`PRECO_CORANTE`, não a FORMULA → sem recálculo dedicado, o caso de uso PRINCIPAL do founder falharia (preço velho no app com sync "funcionando"). O critério de pronto (§8.6) só passa com este passo.
- **P1-B — Snapshot de chaves com guardas (§6.2.5).** Chunk perdido = desativação em massa indevida (loja some da busca). Fix: aplicar só completo + ordem por `generated_at` + trava de blast radius (>20% ou snapshot <50% do oficial → aborta).
- **P1-C — Promoção "latest staging por chave" + re-expansão (§6.2 princípio + §6.2.2).** Staging duplica entre runs (re-envio pós-crash com key nova) e embalagem nova chega depois da fórmula (cuja `data_atualizacao` não muda). Fix: promoção aplica sempre o estado mais recente por chave; skus novos re-expandem fórmulas do par.
- **P1-D — Checkpoint pelo relógio da ORIGEM (§5.3).** High-water mark de `MAX(data_atualizacao)` do PG do SayerSystem; nunca `now()` do conector (clock skew do PC do balcão).
- **P2:** full re-scan semanal (UPDATE sem tocar `data_atualizacao` na origem); guarda `vol_formulação ≤ 0`; expansão só por embalagens VENDÁVEIS (emb de formulação não-vendável não polui o balcão); corante ausente → stub (comportamento do CSV); `client_encoding=UTF8`; purge staging 30d + varredura de runs órfãos; bulk inserts no staging (full sync ~29k); `LocalService`.
- **P3:** anti-downgrade no auto-update (versão monotônica); assinatura Authenticode = v2.

**Pendência registrada:** rodar o **codex adversarial retroativo** (spec + código) quando a cota voltar (11/06 9h24) — mesmo rito da frente `aplicar_promocoes`.

## 12. Sequência de build (pra o plano)
1. **PR1 — servidor:** migration (staging precos_base + `desativada_em` + promoção + keys-snapshot apply) + helper TS espelho + testes vitest + PG17 + edits da edge (endpoint novo, fixes, gate automatic_primary) + filtros de desativada no front. ⚠️ migration manual (SQL Editor) + deploy edge (chat Lovable) + Publish.
2. **PR2 — conector:** `connector/sayersync/` (Go) + cross-compile + manifest de update + instruções de instalação (1 página pt-BR pro founder) + binário no Storage.
3. **Amanhã (máquina):** instalar → discovery/heartbeat → shadow → gabarito → comparar → flip.

## 13. SCHEMA REAL + MATRIZ DE IDENTIDADE (12/06, dia da máquina — NÃO re-perguntar; supersede os nomes da Kelly em §2)

> O discovery em campo provou que os nomes informados pela Kelly/Dnaxis eram FANTASIA. O fail-closed segurou (zero sync errado). Fonte: `sayersystem-schema.txt` (fingerprint `508fef46…`) + query de identidade nas tabelas tint_* de PROD.

**Schema real (13 tabelas, schema `public`, banco `client_industrial_sayerlack`):** tabelas no SINGULAR (`corante`, `embalagem`, `padraocor`); PK = `id` em todas; timestamp = `data_alteracao` (⚠️ exceto `formulaperson` = `data_atualizacao`; `personcor` NÃO TEM timestamp → full-scan por ciclo, tabela minúscula); `formula` E `formulaperson` são FLAT (`corante1..6`+`qtd1..6`; não existe `formula_item`); `formulaperson` liga por `id_personcor`; `formula.id_embalagem` = embalagem de FORMULAÇÃO; `padraocor.id_subcolecao` (a subcoleção vem da COR, não da fórmula); `embalagem.conteudo` em **LITROS** (0.810) → conector converte ×1000 (`litrosLimiar=100`); `liberado` (bool) em quase todas → fórmula `liberado=false` não sobe e sai do keys-snapshot. **⚠️ NÃO EXISTEM `preco_corante`/`preco_baseemb` neste banco** — preço mora em outro banco/schema do servidor (discovery v2 lista databases+schemas pra localizar; v0.1.4).

**Matriz de identidade (CONFIRMADA contra prod 12/06 — mudar qualquer linha DUPLICA o catálogo do app):**
| entidade | identidade enviada | exemplo de prod |
|---|---|---|
| produto | `produto.codigo` | `JO05.7796` |
| base | `base.id` (numérico! o código W vive na descrição) | `90` |
| embalagem | `embalagem.id` (numérico; descrição é display) | `1`, `38` |
| corante | `corante.id` (numérico; código WP na descrição) | `3`, `12` |
| cor padrão | `padraocor.codigo + " - BS"` — **"BS" = Base Solvente** (founder, 12/06): rótulo FIXO que a fábrica mantém mesmo a linha à base d'água não existindo mais; o export compõe assim. `nome_cor` idem (`descricao + " - BS"`). Sem codigo → id cru SEM sufixo (diverge visível, nunca chuta). v0.1.4 | `151N - BS` |
| cor personalizada | `personcor.codigo_cor` | `AZUL PURO` |
| subcolecao | `codigo` (fallback id; prod=`1`, compatível) | `1` |

**Arquitetura v0.1.3:** `Lookups` carregados 1×/ciclo (id→identidade por entidade + `EmbVolumeML` litros→ml + `CorPadrao`/`CorPerson` SEPARADOS — ids de padraocor e personcor COLIDEM num mapa único) injetados nos mapeadores; falha de lookup = FATAL. P0 consertado: `ExtractDelta` não selecionava os slots flat (`FlatColsByTable` fora do `Resolved`) → toda fórmula subia com 0 itens; `buildDeltaSelectCols` os appenda pra formula+formulaperson. Resolução de NOME DE TABELA por candidatos (`TableFor`). Snapshot reescrito com nomes resolvidos + filtro liberado + MESMA identidade dos payloads. Discovery v2: outros schemas + databases do servidor + contagens + amostra de embalagem. **199 testes Go.**

**Nota de volume:** os `volume_ml` oficiais de prod (815.3141/3261.2564/18118.0911) são PROPORCIONAIS aos nominais (×4 exato QT→GL) — vieram do `volume_final` dos CSVs (embalagem+corantes de UMA cor). Como a regra de 3 usa RAZÕES, mandar o nominal (`conteudo`×1000 = 810/3240/18000) preserva todas as razões (fator QT→QT=1). A reconciliação do gabarito valida.
