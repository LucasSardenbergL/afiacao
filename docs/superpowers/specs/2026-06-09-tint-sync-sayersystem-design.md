# Tintométrico — Sync automático SayerSystem → app (conector PG + promoção staging→oficial)

**Data:** 2026-06-09 · **Status:** aprovado pelo founder (design verbal); spec p/ plano
**Frente:** roadmap-sessao.md §17 · **Decisor técnico:** delegado (eu + codex)

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
  1. Conecta PG local (timeout 10s, conexão curta, `ReadCommitted`).
  2. **Valida schema** contra o mapeamento embutido (`information_schema`): diverge → **fail-closed**: não sinca, grava `sayersystem-schema.txt`, heartbeat com `schema_mismatch` (founder me manda o txt; eu ajusto e solto update). Bate → segue.
  3. Por entidade (ordem: produto, base, embalagens, produto_base_embalagem, corantes, preco_corante, preco_baseemb, padracor+colecao+subcolecao, formula, personcor+formulaperson): `SELECT` delta `WHERE data_atualizacao > (checkpoint − 5 min)` → mapeia pro contrato → POST em lotes ≤1000 com `x-idempotency-key` (uuid v4 por lote) → retry/backoff (3×, exponencial) → **checkpoint local (`state.json`) só avança após 2xx**.
  4. Heartbeat com `agent_version, hostname, uptime, db_connected, schema_fingerprint, last_cycle_counts`.
- **1×/dia:** snapshot de **chaves** por entidade → POST `/keys-snapshot` (chunked se >5MB) → servidor desativa o que sumiu.
- **Primeira execução:** checkpoint zero = full sync (mesma mecânica, sem caso especial).
- **Auto-update:** 1×/dia baixa manifest (Supabase Storage público: versão + sha256 + URL); hash confere → troca binário + restart; crash-loop (3 falhas em 10 min) → rollback pro binário anterior (mantido como `.prev`).
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

1. Cria `tint_importacoes` `(tipo='sync_agent', arquivo_nome='sync:<run_id>', arquivo_hash=run_id)` → `importacao_id` (reusa a tela de histórico de graça).
2. **Catálogo:** upsert `tint_produtos/bases/embalagens/corantes/skus` a partir do staging do run, espelhando os `onConflict` do `tint-import` (`account,cod_produto` etc.). `tint_skus` nasce de `produto_base_embalagem` (= `/catalogs.skus`).
3. **Fórmulas:** para cada `tint_staging_formulas` do run:
   - resolve FKs (produto/base/embalagem de formulação/subcoleção);
   - **expande por embalagem vendável**: para cada embalagem do par (produto, base) em `tint_skus`: `fator = vol_emb_destino / vol_emb_formulação`; `qtd_ml_item × fator`; `volume_final_ml = vol_emb_destino`;
   - **preço reproduzido (pág 9):** `preco_final = custo_base(emb)×(1+imposto)×(1+margem) + Σ(qtd_expandida × custo_corante/volume_corante)` com insumos de `tint_staging_precos_base`/corantes; **insumo faltando → `preco_final = NULL`** (degradação honesta; nunca 0);
   - upsert por `uq_tint_formulas_chave`; itens **delete+insert** na mesma transação; `desativada_em = NULL` (reativa se voltou).
4. **Deleção (`/keys-snapshot`):** fórmula oficial cuja chave natural não está no snapshot → `desativada_em = now()` (**soft**; reversível; nunca delete físico). Catálogo: corantes/produtos sumidos → `ativo=false` se a coluna existir; senão só fórmulas na v1.
5. Contadores → `tint_sync_runs` (inserts/updates) + `tint_importacoes`.

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

## 11. Sequência de build (pra o plano)
1. **PR1 — servidor:** migration (staging precos_base + `desativada_em` + promoção + keys-snapshot apply) + helper TS espelho + testes vitest + PG17 + edits da edge (endpoint novo, fixes, gate automatic_primary) + filtros de desativada no front. ⚠️ migration manual (SQL Editor) + deploy edge (chat Lovable) + Publish.
2. **PR2 — conector:** `connector/sayersync/` (Go) + cross-compile + manifest de update + instruções de instalação (1 página pt-BR pro founder) + binário no Storage.
3. **Amanhã (máquina):** instalar → discovery/heartbeat → shadow → gabarito → comparar → flip.
