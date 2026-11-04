# Plano de melhoria v5 — velocidade, dinheiro honesto, CI e banco (2026-11-03)

> Levantamento em 3 eixos por varreduras Fable (app no navegador · banco/edges em prod · dev/CI), uma **busca independente do Codex** (sem ver a lista do Fable) e uma **contestação do Codex** sobre a lista consolidada, com conferência minha no código.
> Codex: busca=gpt-6-astra·high·153.502 tokens · contestação=gpt-6-astra·high·151.218 tokens. Pareceres crus: [anexos/codex-busca-independente.md](anexos/codex-busca-independente.md) · [anexos/codex-contestacao.md](anexos/codex-contestacao.md).

## 0. Fecho do v4

Os 28 candidatos do [v4](../2026-11-01-plano-melhoria-v4/README.md) estão resolvidos: 32 PRs mergeados (conferido 2026-11-03 12:57 UTC). O **A3** (`test:rapido`) foi medido e **descartado** no #3508 (sem ganho: 130–206 s contra 139–200 s). Restam só verificações datadas:

| Item | Quando |
|---|---|
| B3: 1º run **incremental** do contas a receber (o full de bootstrap fechou 08:20–08:42 UTC, `fullOkPublicado` nas 3 empresas) | 2026-11-03 14:20 UTC |
| B1: DROP dos 4 índices sem uso dos scores | ≥ 2026-11-07 10:33 UTC |
| B1: conferir o 1º expurgo semanal | 2026-11-08 |
| Lotes de tela (3, 4, 5, 8, 10, 16): ganho pelos web-vitals | ~2026-11-09 (1 semana de amostra) |

## 1. Como ler

- **Medido** = `psql-ro` em prod (contadores de **74,5 h** desde o restart de 2026-10-31 10:33 UTC; `n_live_tup` não confiável em tabela não analisada), `gh run` (300 runs do CI de 31/10→03/11), `telemetria_vitals` (desde 02/11 — **1 usuário só**: pista, não prova).
- **Estimado** = ganho em ms no app; hipótese até medir.
- Veredito final = meu, depois do Codex. ✔ = conferi no código.

## 2. Itens, um a um

### C. Correção e dinheiro honesto

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| UTI | Recebíveis da tela UTI casados por documento | `useUtiContas.ts:134` descarta título sem `cnpj_cpf`; `:164` sem correspondência vira saldo 0. Histórico registra 45.386 CR com `cnpj_cpf` vazio (21/10). Reprodução: trocar só o documento por `''` muda `uti/true/750` → `observacao/false/0` | AJUSTAR: casar por empresa+código Omie com identidade fresca e unívoca; mapa incompleto/ambíguo → **desconhecido** | **MANTER** — money-path: prova + Codex |
| HST | Último preço da ficha de recompra depende da ordem dos itens | `historico.ts:67` só reconsidera preço quando a data supera `ultimaData`, que avança também em compra sem preço; consulta sem `order`. Codex reproduziu **10, 20 ou null** para os mesmos itens | AJUSTAR: separar data da última compra da data do último preço; definir empate; `order` sozinho não corrige | **MANTER** (P) |
| E5 | Zero fabricado no Financeiro Gestão (+ formatadores de moeda) | `FinanceiroGestao.tsx:69-81` descarta `error` e devolve 0 → KPI "0,0%" em falha; cards `:91/:98/:105` idem. ✔ `formatBRL(value: number)` em `cashflow-format.ts:13` formata `null` como **R$ 0,00** (8 cópias de `formatBRL`) | AJUSTAR: distinguir erro, carregando e zero observado; corrigir só consumidores comprovados; `formatPrecoOuAusente` já existe em `lib/format:149` | **MANTER** — E7 entra aqui, restrito aos consumidores que recebem nulo. Sem ESLint novo |

### F. Velocidade do app

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| BND | Laço de trios que ninguém lê no motor de cestas | `useBundleEngine.ts:628-639` preenche `tripleFreq`; nenhuma regra consome. C(k,3) por cesta (1.140 combinações com k=20) | MANTER (ganho no recálculo, não no boot) | **MANTER** (P) |
| VAL-IO | 4 leituras em série na edge `fin-valor-cockpit` | `index.ts:575/579/591/614`, filtros independentes | MANTER: preservar paginação e falha integral; não esconder erro com lista vazia | **MANTER** (P–M, deploy de edge) |
| F4 | Polling do shell staff ≈ 11 req/min por aba ociosa | `AppShell.tsx:458,477,494,515,531` + 5 hooks de alerta (60 s–5 min), 10 queryKeys | AJUSTAR: já pausa aba oculta; começar pela **duplicação exata** `AppShell:447` × `useAlertasCriticos:20`; RPC única só depois, com prova | **MANTER fatia 1** (dedup); RPC = fase 2 com medição |
| F1 | Chunk da rota só baixa depois do auth | ✔ `ProtectedRoute.tsx:18-19` + `App.tsx:234`; `AuthContext` faz 3 queries (já paralelas) antes de liberar. LCP de `/` p50 4,2 s (n=5) | AJUSTAR: compartilhar o loader com o `lazy` (sem duplicar 156 caminhos); autorização intacta | **MANTER** (P); medir LCP antes/depois |
| F5 | Prefetch do chunk ao apontar/focar item da sidebar | 0 `preload` em `src`; 156 `lazy()` | AJUSTAR: **risco** — import especulativo com chunk ausente pode acionar o reload global de `main.tsx:65`; tratar antes | **MANTER** depois de F1 |
| F3 | `vendor-ui` com 20 pacotes Radix no boot | `vite.config.ts:380/385` agrupa sem olhar alcance; build antigo (24/08): `vendor-ui` 47,4 KB gz | AJUSTAR: "shell usa 4" e −35–45 KB não demonstrados; exigir build antes/depois e checar ciclos | **MANTER condicionado** ao build comparativo |
| F2 | TTFB de navegação 1,5 s (n=18) vs 5 ms servido pelo SW | `sw.ts:264-273` | AJUSTAR: SW **já** é cache-first com release promovida (`:208` exige assets completos); "sem promoção" perde essa garantia. Diagnosticar com o que já existe, sem sensor novo | **DIAGNÓSTICO apenas** — reabrir com amostra de >1 usuário |

### E. Dev e CI

Base (✔ `gh run`): PR p50 **24,4 min** de parede; caminho crítico = `provas-sql` (6 shards, p50 ~16 min cada, ≈96 runner-min/run); fila p90 **17,5 min**. 0 testes flaky; 10 falhas de `typecheck` = 2 episódios de main vermelha herdada.

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| E1 | `provas-sql` com escopo por job | 33/60 PRs mergeados não tocam `db/` nem `supabase/` (13 só `docs/`); padrão já existe em `mutcheck-escopo` (`ci.yml:1637`) | AJUSTAR: há prova que lê `src/` (`db/test-projecao-13s-saldo-fresco.sh:290`); escopo **conservador** — incerteza roda tudo; adaptar união/recibos (`ci.yml:1365`) e `validate` (`:1425`) | **MANTER** (M) + 2ª opinião |
| E3 | Merge queue (`merge_group`) | **Incidente**: main vermelha ~2h50 (01/11 e 02/11, #3498/#3539); 5 PRs falharam typecheck em arquivo que não tocaram (≈670 runner-min). `ci.yml:78-81` já aponta a solução | AJUSTAR: reutilizar `validate`, adaptar o auto-merge; nenhum gate próprio novo | 🚧 **BLOQUEADO** (2026-11-04): merge queue só existe em repo de organização, e este é de conta pessoal. Founder fechou (opção D). Ver `docs/historico/ci-merge-queue-bloqueada-repo-pessoal.md` |
| CI-GIT | Checkout raso no job `typecheck` | `ci.yml:189` `fetch-depth: 0`; o job só instala e roda os 2 `tsc` | MANTER (ganho pequeno) | **MANTER** (P) |

### D. Banco e edges

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| D3 | Recomputes que reescrevem 100% sem diff | `cliente_classificacao` 69.243 upd/17.459 linhas em 74 h (reescreve tudo, `20261001014100…:365`); `farmer_client_scores` 91.662/16.993 (0,3% HOT) | AJUSTAR: começar por **classificação**; carteira tem frescor (`last_synced_at`) e o mapa de contas expira em 7 d; farmer tem frescor em `calculated_at` (armadilha do B2) | **MANTER fatia 1** (classificação) — prova PG17 + Codex |
| D1 | CR/CP com 0% HOT | `n_tup_hot_upd = 0` nos dois; `idx_*_updated_at` muda a cada upsert; CP 108.501 upd/16.284 linhas em 74 h | AJUSTAR: dropar índice não garante HOT (B2/B9 precisou de `fillfactor`); separar CP de CR; **reestimar CR depois do B3** | **ESPERA** o incremental do B3; CP pode ir antes, com prova |
| D4 | RLS com `auth.uid()` cru (436 policies) e 26 `has_role` residuais | Residuais em tabelas com `seq_tup_read = 0` | AJUSTAR: só investigação focal, EXPLAIN por persona; nada em massa | **DIAGNÓSTICO apenas** |
| D5 | Índices com 0 scans (`radar_empresas` 300 MB; scores 209 MB) | 74 h de contador (< 7 d) | MANTER **releitura**, não DROP; uso mensal do Radar não aparece em 7 d | **RELER em 2026-11-07 10:33 UTC** |

## 3. Cortes

| # | Item | Por quê |
|---|---|---|
| E6 | Recalcular valor/funding com `useMutationComRegistro` | Premissa falsa: ✔ `useValor.ts:7` e `useFunding.ts:11/25` disparam as engines por **useQuery**; a mutation só salva configuração |
| D2 | Scores: inserir só quando mudou | A edge grava componentes além do total; com retenção de 60 d, cliente estável perderia **todo** o histórico. Muda o contrato da série sem consumidor mapeado |
| E2 | Tirar `provas-sql` do dispatch pós-merge | 0 vermelhos em 300 runs não prova redundância na **combinação** de PRs; reavaliar só depois de E1/E3 |
| E8 | Escapes de tipo em edges | Não indicam lentidão nem defeito; saneamento quando o trecho for tocado |
| F6 | Índices para `omie_products`/`sales_orders`/`addresses` | Já decidido no lote 9 do v4 (B8) |
| E4 | `test:rapido` | Já medido e descartado no #3508 |

## 4. Roadmap em lotes

| Lote | Conteúdo | Depende de | Quem aplica |
|---|---|---|---|
| 1 | UTI (casamento por código, desconhecido honesto) | — | sessão + prova + Codex + **Publish** |
| 2 | HST (último preço independente da ordem) | — | sessão + **Publish** |
| 3 | E5 (+E7 restrito) — zero fabricado no Financeiro Gestão | — | sessão + Codex + **Publish** |
| 4 | BND + F4 fatia 1 (dedup do polling) | — | sessão + **Publish** |
| 5 | VAL-IO — leituras em paralelo na `fin-valor-cockpit` | — | sessão + **deploy de edge** |
| 6 | F1 → F5 — chunk em paralelo ao auth e prefetch na sidebar | — | sessão + **Publish** |
| 7 | F3 — `vendor-ui` por alcance | build antes/depois | sessão + **Publish** |
| 8 | CI-GIT + E1 — checkout raso e `provas-sql` com escopo | 2ª opinião (E1) | sessão |
| 9 | E3 — merge queue · 🚧 **bloqueado pela plataforma** (repo pessoal; `docs/historico/ci-merge-queue-bloqueada-repo-pessoal.md`) | lote 8; Codex | — |
| 10 | D3 fatia 1 — `cliente_classificacao` com diff | prova PG17 + Codex | sessão escreve migration; aplicação no envelope ou pelo founder |
| 11 | D1 — HOT em CP (e CR depois do B3) | B3 observado; prova PG17 | idem |
| — | D4, D5, F2 | datas/amostra (§2) | diagnóstico, sem PR |

Lotes 1–8 e 10 são independentes entre si (arquivos distintos); 6 e 7 tocam o boot — rodar em sequência para não confundir a medição.
