# Replay TSB no estoque de segurança (Sayerlack) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** construir um simulador de replay walk-forward que compare a fórmula atual do motor de reposição (F0) com três alternativas — F1 (média + order-up-to), F2 (TSB + tamanhos empíricos) e F3 (quantil empírico) — nos SKUs Sayerlack da OBEN, e emitir GO / NO-GO / INCONCLUSIVO pela tabela de decisão da spec (§6.1).

**Architecture:** extração read-only via `psql-ro` para CSVs locais, fora do repositório. Depois, um simulador TypeScript puro em `scripts/reposicao-replay/`. Os **parâmetros** de cada fórmula dependem só do histórico até a véspera (o LT é exógeno, spec §5.9), então são pré-computados uma vez por (fórmula, SKU, dia, parâmetro). A **decisão de compra** roda sobre o estado de cada replicação. As replicações variam o LT realizado e o desfecho da falta, com números aleatórios comuns por hash de chave. Saída: relatório markdown com veredito.

**Tech Stack:** Bun + TypeScript strict (`tsconfig.scripts.json`), vitest (`scripts/**/*.test.ts` já está no include), bash + `~/.config/afiacao/psql-ro`.

**Spec:** `docs/superpowers/specs/2026-10-20-tsb-estoque-seguranca-design.md` (aprovada em 2026-10-21 e revisada após a consulta Codex adversarial). Os § citados são da spec. **§5.9 e §6.1 prevalecem** em caso de dúvida.

## Global Constraints

- Nada em `supabase/migrations/` nem em `db/embalagem-motor-rpc.sql`. Só **leitura** via `~/.config/afiacao/psql-ro`, com `-v ON_ERROR_STOP=1` e marcador `select 'fim','ok'` conferido.
- Dados em `${REPLAY_DADOS:-$HOME/.cache/afiacao/reposicao-replay}`, **nunca no repositório**. Sem nome nem CNPJ de cliente.
- Coorte fixada no corte **2026-05-01**: Sayerlack, OBEN, `ativo`, `habilitado_reposicao_automatica`, menos os parados (≤ 1 semana com venda nas 27 semanas antes do corte), menos os SKUs sem contrato de unidade. A sensibilidade "todos os ativos" é obrigatória.
- Janelas: aquecimento até 2026-01-31; calibração 2026-02-01 a 2026-04-30; avaliação 2026-05-01 a 2026-10-20.
- Calendário de LT e de revisão = segunda a sexta, gerado em código. Dias de atendimento = esse calendário ∪ dias com venda. R = 1 du.
- A calibração só enxerga documentos de LT com `t4` (ou a extração, se aberto) ≤ 2026-04-30.
- TSB: α = 0,10; β ∈ {0,005; 0,01; 0,02}. Grade de quantis da spec §5.9. Alvo por classe: `max(piso, fillRateF0_calibração − 0,25 p.p.)`. Pisos: A 98%, B 95%, C 90%.
- Precisão congelada: F2 com 2.000 trajetórias; bootstrap com 2.000 reamostragens; 200 replicações, subindo de 100 em 100 até a meia largura ≤ 0,1 p.p. (serviço) e ≤ 1 p.p. (estoque), com teto de 1.000 (o teto sem precisão gera INCONCLUSIVO).
- Bootstrap em blocos circulares de 4 e 8 semanas: `LI = min`, `LS = max`.
- Grade de custo: taxa {20%, **25%**, 30%} a.a. × emergencial {5, 10, 20}% do valor × atraso {0; 0,5; 1}% do valor por dia.
- Cenários de falta: `espera` e `cancelamento` (serviço e economia); `misto` 60/30/10 (economia). LT: `empirico`, `estresse15`, `choque29` (semanas 9–12 da avaliação).
- Exposição mínima: 300 linhas na avaliação por célula de serviço.
- Nome obrigatório da métrica: "atendimento das linhas faturadas observadas". Ausente vira `null`, nunca 0 nem 100%.
- **Repo público:** valores absolutos em R$ (relatório, paridade, custos) ficam só em `$REPLAY_DADOS` e no **Artifact privado**. No repositório, no PR e em `docs/historico/` entram só relativos (% do F0 / do estoque Sayerlack). Mesma regra do backtest do orçamento (`docs/superpowers/orcamento-compra/LEIA-ME.md`, decisão do founder de 2026-10-15).
- **Reaproveitar, não recriar:** a aritmética de datas vem de `src/lib/reposicao/orcamento-compra/datas.ts` (`addDias`, `diffDias`, `ehDiaUtil`; `DataISO` = `Data`). Antes de escrever `reconstrucao.ts`, ler `demanda.ts#reconstruirEstoque` e `marcarCensura` e reutilizar o que servir. Ler também as lições de `docs/historico/orcamento-compra-v1.md` ("ausência de ruim ≠ bom"; "medir o mesmo corte que se aplica"; injeção esquecida em harness fail-closed).
- O simulador não entra no CI como gate; os testes unitários entram no vitest normal. Textos e commits em pt-BR, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **SKU sem linha na janela** → `null` e fora do denominador. Teste na Task 7.
2. **Linhas do mesmo SKU no mesmo dia com estoque parcial** → ordem de `linhaId`; uma falha por linha; a parte disponível é entregue e o restante vira obrigação da linha. Teste na Task 6.
3. **Unidade incoerente** → o SKU vai para `excluidos` com motivo, sem conversão no chute. Teste na Task 2.
4. **CSV ausente, vazio ou sem `fim|ok`** → erro e exit ≠ 0. Teste na Task 2.
5. **Pedido aberto** → entra com `LT = max(du decorridos, 15)`, nunca LT 0 nem descartado em silêncio. Teste na Task 2.

---

## Estrutura de arquivos (`scripts/reposicao-replay/`)

| Arquivo | Responsabilidade |
|---|---|
| `extrair.sh`, `extrair.sql` | Extração read-only → CSVs |
| `config.ts`, `tipos.ts` | Constantes da spec; tipos compartilhados |
| `dados.ts` | Carregar e validar; contrato de unidade; LT documental |
| `calendario.ts`, `reconstrucao.ts` | Calendários; estoque inicial |
| `classe.ts`, `parados.ts` | ABC versionado com histerese; SB; coorte; parados |
| `formulas.ts` | Parâmetros F0–F3 por SKU e dia |
| `aleatorio.ts`, `simulador.ts` | Números aleatórios comuns; laço diário com decisão completa |
| `metricas.ts`, `estatistica.ts` | Somas semanais, custo; bootstrap e tabela de decisão |
| `calibracao.ts`, `relatorio.ts`, `rodar.ts` | Grade de calibração; orquestração; relatório |

Testes co-localizados (`*.test.ts`), com fixtures sintéticas.

---

### Task 1: Extração read-only e gates de escopo

**Files:** Create `extrair.sql`, `extrair.sh`

**Interfaces — Produces** (em `$REPLAY_DADOS/`, separador `|`, cabeçalho, última linha `fim|ok`):
- `vendas.csv`: `linha_id|sku|data|quantidade|valor|cmc_linha|no_escopo` — **todo o universo OBEN** (o Pareto ABC precisa dele). `no_escopo` marca os Sayerlack.
- `recebimentos.csv`: `tracking_id|sku|t1|t4|quantidade_pedida|quantidade_recebida` — linhas de `sku_leadtime_history` deduplicadas por `(tracking_id, empresa, sku, t4, quantidade_recebida)`. Recebimentos parciais preservados. Pedidos sem `t4` vêm com `t4` vazio. O `extracao.log` registra a contagem contra `v_sku_leadtime_efetivo`.
- `skus.csv`: `sku|descricao|grupo_codigo|classe_abc_hoje|classe_forcada|minimo_forcado|minimo_operacional|multiplo_embalagem|unidade_nf|unidade_estoque|fator_conversao|cmc|saldo_hoje|habilitado|ativo|custo_pedido_aplicado|custo_capital_perc|es_hoje|pp_hoje|max_hoje`.
- `config_custos.csv`: `z_classe_a|z_classe_b|z_classe_c|…` de `empresa_configuracao_custos` (OBEN).
- `classificacao_hist.csv`: o estado de histerese de `atualizar_classificacao_skus` disponível (classe atual, pendente, meses consecutivos), mais os parâmetros da regra.
- `teto.csv`: `company_config` `reposicao_teto_cobertura_oben_*`.
- `equivalencias.csv`: `sku|sku_equivalente|fator` (pode vir só com cabeçalho).
- `sugestao_hoje.csv`: a última execução de `gerar_pedidos_sugeridos_ciclo` OBEN Sayerlack (`sku|posicao|qtde_final`), para a paridade de quantidade comprada.
- `outras_empresas.txt` e `grupos_embalagem.txt`: participação (linhas e valor) fora da OBEN; SKUs da coorte em grupo de embalagem e seu valor.

- [ ] **Step 1:** escrever `extrair.sql` (um `\copy` por arquivo e `select 'fim','ok';` no fim) e `extrair.sh` (roda o psql-ro, captura `rc`, confere `fim|ok`, carimba cada CSV e sai ≠ 0 se faltar algo).
- [ ] **Step 2:** rodar `bash scripts/reposicao-replay/extrair.sh` → `rc=0`.
- [ ] **Step 3: Gates.** **PARAR** e reportar ao Lucas se as outras empresas passarem de 5% das linhas ou do valor (§5.1.1). Registrar no log o valor dos grupos de embalagem; se for > 0, as Tasks 5 e 6 implementam a consolidação.
- [ ] **Step 4:** `bun run lint:shell` → exit 0.
- [ ] **Step 5: Commit** — `feat(reposicao-replay): extração read-only dos dados do replay Sayerlack`

### Task 2: Tipos, configuração, carregador, contrato de unidade e LT documental

**Files:** Create `config.ts`, `tipos.ts`, `dados.ts`, `dados.test.ts`

**Interfaces — Produces:**
- `type Data = string` (ISO); `type Classe = 'A'|'B'|'C'`
- `interface LinhaVenda { linhaId: string; sku: string; data: Data; quantidade: number /*unid. de estoque*/; valor: number; cmcLinha: number | null; noEscopo: boolean }`
- `interface ItemLT { trackingId: string; sku: string; t1: Data; t4: Data | null; ltDu: number; aberto: boolean }` — `ltDu` = du de `t1` até o recebimento que completa ≥ 95% do pedido; aberto → `max(du até a extração, 15)`.
- `interface Sku { sku; grupo: string | null; classeForcada: Classe | null; minimoForcado: number | null; minimoOperacional: number | null; multiplo: number; cmc: number; saldoHoje: number; f0: { custoPedido: number; custoCapitalPerc: number }; hoje: { es: number; pp: number; max: number } }`
- `interface Dados { vendas: LinhaVenda[]; itensLT: ItemLT[]; skus: Map<string, Sku>; zPorClasse: Record<Classe, number>; teto: TetoConfig; equivalencias: Equivalencia[] | null; sugestaoHoje: Map<string, { posicao: number; qtdeFinal: number }>; excluidos: { sku: string; motivo: string }[]; dataExtracao: Data; hashDados: string }`
- `TetoConfig`, `Equivalencia` em `tipos.ts`.
- `carregarDados(dir: string): Dados` — lança `ErroDadosReplay('CSV_INVALIDO:<arquivo>')`.

- [ ] **Step 1: testes que falham:**
  - `rejeita CSV sem marcador`
  - `rejeita vendas vazia` (equivalências vazia é aceita)
  - `exclui SKU com unidade incoerente` → motivo `UNIDADE_INCOERENTE`
  - `converte venda fracionada` (3,6 L, fator 3,6 → 1)
  - `recebimento parcial`: pedido de 10, recebe 4 no du 5 e 6 no du 9 → `ltDu = 9`
  - `pedido aberto entra com LT conservador`: aberto há 7 du → `ltDu = 15, aberto = true`
  - `dedup preserva documentos distintos`: dois `tracking_id` com mesmo (sku, t1, qtd) → 2 itens
- [ ] **Step 2:** `heavy bun run test scripts/reposicao-replay/dados.test.ts` → FAIL.
- [ ] **Step 3:** implementar `config.ts` (Global Constraints), `tipos.ts` e `carregarDados`. `hashDados` = sha256 dos CSVs.
- [ ] **Step 4:** testes PASS; `heavy bun run typecheck` → exit 0.
- [ ] **Step 5: Commit** — `feat(reposicao-replay): carregador validado, contrato de unidade e LT documental`

### Task 3: Calendários e estado inicial

**Files:** Create `calendario.ts`, `reconstrucao.ts` e os testes

**Interfaces — Produces:**
- `diasUteis(inicio: Data, fim: Data): Data[]` (seg–sex) · `diasAtendimento(dados): Data[]` · `somarDiasUteis(d: Data, n: number): Data` · `duEntre(a: Data, b: Data): number` (mesma convenção de `dias_uteis_entre`: exclui o dia inicial).
- `type CenarioInicial = 'reconstruido' | 'piso_zero'`
- `estoqueInicial(dados, cenario): Map<string, number>` — no `reconstruido`, os SKUs que não fecham recebem o ajuste mínimo que evita negativo **calculado só com eventos até `FIM_CALIBRACAO`**.
- `negativosNaAvaliacao(dados): { sku: string; data: Data; valor: number }[]` — reportados, não ajustados.

- [ ] **Step 1: testes:**
  - `sexta sem venda é dia útil`
  - `sábado com venda é dia de atendimento, mas não de LT`
  - `duEntre(sexta, segunda) = 1`
  - `reconstrução: saldo 5, venda 3 ontem, recebe 4 anteontem` → início de anteontem = 4
  - `ajuste ignora a avaliação`: um déficit criado só em setembro não muda `estoqueInicial`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** teste opcional com dado real (pula sem `REPLAY_DADOS`): entre 80% e 88% dos SKUs fecham.
- [ ] **Step 6: Commit** — `feat(reposicao-replay): calendários e estado inicial sem olhar a avaliação`

### Task 4: Classe ABC versionada, coorte e parados

**Files:** Create `classe.ts`, `parados.ts` e os testes

**Interfaces — Produces:**
- `classeProposta(dados, d): Map<string, Classe>` — reproduz o Pareto por empresa de `v_sku_classificacao_abc_xyz` (`supabase/schema-snapshot.sql:~30319`) sobre **todo o universo OBEN**, com dados `< d`.
- `classeEfetiva(dados, d): Map<string, Classe>` — aplica a histerese de `atualizar_classificacao_skus` (`schema-snapshot.sql:~5798`) na cadência de produção, partindo do estado do início do aquecimento; `classeForcada` prevalece.
- `validarClasse(dados): { porClasse: Record<Classe, number>; valorADivergente: number }` — classe efetiva recalculada hoje contra `classe_abc_hoje`.
- `padraoSB(dados, d, sku)` — semanal, com dados `< d`; ADI > 1,32; CV² > 0,49; `sem_dado` com < 2 semanas positivas.
- `coorte(dados): { populacao: Set<string>; alterados: Set<string>; parados: Parado[] }` — tudo calculado com dados `< 2026-05-01`. `alterados` = SB ≠ suave/errático no corte. `parados` = ≤ 1 semana positiva nas 27 semanas observadas antes do corte. Os campos de `Parado` ficam em `tipos.ts`. `coorteTodosAtivos(dados)` dá a sensibilidade.

- [ ] **Step 1: testes:**
  - `proposta não usa o próprio dia nem o futuro`
  - `histerese segura a promoção até N meses consecutivos` (N lido da regra)
  - `classe forçada prevalece`
  - `SB intermitente vs lumpy`
  - `coorte não muda se a avaliação mudar`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Gate com dado real:** se `valorADivergente` passar de 5% do valor A, **PARAR** e explicar antes de seguir.
- [ ] **Step 6: Commit** — `feat(reposicao-replay): ABC versionado com histerese, coorte no corte e parados`

### Task 5: Parâmetros das fórmulas F0–F3

**Files:** Create `formulas.ts`, `formulas.test.ts`

**Interfaces — Produces:**
- `type Formula = 'F0'|'F1'|'F2'|'F3'`
- `interface ParamsFormula { beta?: 0.005|0.01|0.02; janelaDias?: 60|90|180; quantil: Record<Classe, number> }`
- `type ParamsDia = { tipo: 'F0'; pp: number; max: number; coberturaTetoDias: number | null; demandaDiariaLinha: number } | { tipo: 'S'; s: number }`
- `parametrosNoDia(f, dados, sku, d, p, ctx: { calibracao: boolean }): ParamsDia` — só dados `< d`; com `ctx.calibracao`, o LT só vem de itens com `t4` ≤ `FIM_CALIBRACAO`.
- `preComputar(f, dados, p, ctx): Map<string, ParamsDia>` — cache em disco com a chave `sha256(hashDados, hashCodigo, calendário, precisão, f, p, ctx)`.
- **F0:** reproduz a fonte, não a memória:
  - σ sobre **180 dias com zeros** (`v_sku_sigma_demanda`, migration `20260930230623…` ~1316-1360);
  - `z` = `zPorClasse[classeEfetiva(d)]`;
  - `ss = max(ss_calc, minimo_operacional)`;
  - `PP = max(pp_calc, ss + 1)`;
  - EOQ e arredondamentos como `v_sku_parametros_sugeridos`;
  - parâmetros do teto de `teto.csv`.
- **F1 / F2 / F3:** as equações da spec §5.9, com histórico insuficiente → `parametrosNoDia('F0', …)`.
- `paridadeF0(dados): RelatorioParidade` — ES, PP e máximo contra `hoje`; **quantidade comprada** contra `sugestaoHoje`, via a decisão da Task 6. Lista cada divergência com o impacto em R$.

- [ ] **Step 1: testes:**
  - `F0 usa σ de 180 dias com zeros` (fixture com venda só nos dias 1–90 e zeros nos 90 seguintes)
  - `F0 respeita minimo_operacional e PP ≥ ss + 1`
  - `F2 decai sem demanda`: 60 du sem venda → `s(β=0,02) < s(β=0,005)`
  - `nenhuma fórmula vê o futuro`: duplicar vendas de `d` em diante não muda `parametrosNoDia`
  - `calibração não vê LT posterior ao corte`: alterar itens de LT com `t4` > `FIM_CALIBRACAO` não muda os parâmetros com `ctx.calibracao`
  - `cache invalida quando o código ou os dados mudam`
  - `histórico insuficiente cai em F0`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Gate de paridade com dado real** (depois da Task 6): ES, PP e máximo dentro de `max(1, 5%)` **e** quantidade comprada igual em ≥ 95% dos SKUs, **e** divergências que somem ≤ 2% do valor do máximo total. Senão, **PARAR** e corrigir: F0 infiel invalida o denominador.
- [ ] **Step 6: Commit** — `feat(reposicao-replay): parâmetros F0 (fiel à fonte) e F1–F3`

### Task 6: Aleatoriedade comum e simulador com decisão completa

**Files:** Create `aleatorio.ts`, `simulador.ts` e os testes

**Interfaces — Produces:**
- `uniforme(...chave: (string|number)[]): number` — hash estável (FNV-1a 64 → splitmix64) em [0,1). Sem `Math.random` e sem PRNG sequencial.
- `ltRealizado(rep, d, sku, cenario: 'empirico'|'estresse15'|'choque29', itens: ItemLT[]): number` — escolhe o documento com `t1` a ±10 du de `d` (ordem `(t1, trackingId)`; sem candidato, a janela dobra) por `uniforme(rep,'doc',d)`; depois escolhe o item dentro do documento por `uniforme(rep,'item',d,sku)`. `estresse15` = `max(lt,15)`; `choque29` = 29 nas semanas 9–12 da avaliação. Na calibração recebe só os itens permitidos (Task 5).
- `decidirCompra(p: ParamsDia, posicao: number, sku: Sku): number` — F0: se `posicao ≤ pp`, `max − posicao`, com o teto B/C sobre a posição realizada e os mesmos `floor/ceil`, **sem teto** se houver mínimo forçado ou grupo (`db/embalagem-motor-rpc.sql:~440-500`). S: se `posicao < s`, `s − posicao`. Depois, em ambas: se `qtd > 0`, aplica `max(qtd, minimoForcado)` e arredonda para cima até o múltiplo. Grupo de embalagem (se a Task 1 achar): a decisão é na unidade-base do grupo, convertida pela regra do motor.
- `simular(e: { formula; params: Map<string,ParamsDia>; rep; lt; falta: 'espera'|'cancelamento'|'misto'; inicial: CenarioInicial; janela: [Data, Data]; dados; substituicao?: boolean }): SomasSemanais`
- `interface SomasSemanais { semanas: Data[]; porCelula: Record<Celula, { demandadas: number[]; integrais: number[]; unidDem: number[]; unidAt: number[]; valorDem: number[]; valorAt: number[] }>; estoqueCmcDias: number[]; diasCorridos: number[]; entregue: { imediata: number[]; tardia: number[]; emergencial: number[] }; cancelada: { valor: number[]; margem: number[] }; valorDiasAtraso: number[]; terminal: { estoqueCmc: number; abertasCmc: number; backlogValor: number; backlogDiasAtraso: number } }`, com `Celula = Classe | 'A_alt' | 'B_alt' | 'C_alt' | 'total'`.
- Ordem do dia:
  1. chegadas;
  2. obrigações FIFO (saldo por linha; não reentram no denominador);
  3. linhas do dia em ordem de `linhaId` — integral = sucesso; senão **uma** falha, a parte disponível é entregue e o restante segue o desfecho (`misto`: `uniforme(rep,'falta',linhaId)` em 60/30/10);
  4. compra com `decidirCompra`, só em dia útil.
- `substituicao = true` usa as equivalências e **baixa** o estoque do equivalente; só alimenta a métrica "com substituição".

- [ ] **Step 1: testes:**
  - `uniforme independe da ordem de chamada`
  - `mesmo documento, itens diferentes`: dois SKUs no mesmo dia → mesmo `trackingId` sorteado, LTs do documento
  - `linha parcial`: estoque 3, linhas 2 e 2 → 1 integral, 1 falha, 1 unidade entregue, 1 em obrigação
  - `obrigação atendida depois não vira sucesso`
  - `cancelamento e emergencial não geram backlog`
  - `teto não se aplica com mínimo forçado`: posição 0, máximo 20, mínimo 2, teto equivalente a 5 → compra 20
  - `mínimo e múltiplo só com necessidade positiva`
  - `fechamento`: demanda = imediata + tardia + emergencial + cancelada + backlog terminal; estoque inicial + recebido − entregue = final
  - `sem compra em sábado`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** rodar o gate de paridade do F0 (Task 5, Step 5).
- [ ] **Step 6: Commit** — `feat(reposicao-replay): simulador com decisão completa e números aleatórios comuns`

### Task 7: Métricas e custo

**Files:** Create `metricas.ts`, `metricas.test.ts`

**Interfaces — Produces:**
- `fillRate(s: SomasSemanais, c: Celula, idx?: number[]): number | null` — Σ integrais ÷ Σ demandadas nas semanas `idx` (padrão: todas); `null` com denominador 0.
- `estoqueMedio(s, idx?): number` — Σ estoqueCmcDias ÷ Σ diasCorridos.
- `custoLiquido(base: SomasSemanais, alt: SomasSemanais, g: { taxa; emergencialPerc; atrasoPerc }, idx?): number` — `(estoqueMedio_base − estoqueMedio_alt) × taxa × diasJanela/365 − Δ(emergencial × emergencialPerc) − Δ(valorDiasAtraso × atrasoPerc) − Δ(margem cancelada) − Δ(custo terminal)`, onde o custo terminal = `backlogValor × emergencialPerc + backlogDiasAtraso × atrasoPerc`.
- `custoFaltaEquilibrio(base, alt, taxa): number | null`
- `dioSayerlack(s, cmvSayerlackDiario): number`

- [ ] **Step 1: testes:**
  - `fill rate é soma, não média`: 1/1 e 0/9 → 10%
  - `célula sem linha → null`
  - `valor × dias por linha`: R$ 1.000 × 1 d + R$ 10 × 10 d a 1% → R$ 11
  - `R$ 20k liberados a 25% em 365 d, sem falta → R$ 5k`
  - `políticas iguais → custo 0`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** — `feat(reposicao-replay): métricas por célula, capital ponderado e custo`

### Task 8: Bootstrap e tabela de decisão

**Files:** Create `estatistica.ts`, `estatistica.test.ts`

**Interfaces — Produces:**
- `bootstrapPareado(base: SomasSemanais[], alt: SomasSemanais[] /*por rep*/, estat: (b: SomasSemanais[], a: SomasSemanais[], idx: number[]) => number | null, bloco: 4|8, nBoot = 2000): { ponto: number|null; li: number|null; ls: number|null }` — blocos circulares de índices de semana; **os mesmos índices** para as duas políticas e todas as replicações; a estatística é **recalculada** sobre as somas reamostradas (nunca média de razões); quantis 5% e 95%.
- `clopperPearsonInferior(sucessos: number, n: number, conf = 0.95): number`
- `meiaLarguraMC(valoresPorRep: number[]): number`
- `type Estado = 'PASSA'|'FALHA'|'INCERTO'`
- `avaliarCriterios(ev: Evidencia): { criterio: string; estado: Estado; motivo: string }[]` — implementa a tabela da spec §6.1 linha por linha, com `LI = min(LI4, LI8)` e `LS = max(LS4, LS8)`. Os tipos `Evidencia` ficam em `tipos.ts`.
- `veredito(criterios): { veredito: 'GO'|'NO-GO'|'INCONCLUSIVO'; motivos: string[] }` — qualquer FALHA → NO-GO; senão qualquer INCERTO ou `null` → INCONCLUSIVO; senão GO.

- [ ] **Step 1: testes:**
  - `políticas idênticas → LI = LS = 0 na diferença`
  - `razão recalculada`: semanas 1/1 e 90/100 → ponto 90,10%, não 95%
  - `zero falhas com 100 linhas não passa piso A` (Clopper-Pearson ≈ 97,05%)
  - `capital 9% em [8%, 11%] → INCERTO`; `LS < 10% → FALHA`
  - `A-alterados com −2 p.p. e LS abaixo → NO-GO` mesmo com A total passando
  - `célula com 299 linhas → INCERTO`
  - `custo com LS < 0 numa célula da grade → NO-GO`
  - `veredito diverge entre estados iniciais → INCONCLUSIVO`
  - `teto de replicações sem precisão → INCONCLUSIVO`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Commit** — `feat(reposicao-replay): bootstrap pareado por somas e tabela de decisão`

### Task 9: Calibração, orquestração e relatório

**Files:** Create `calibracao.ts`, `calibracao.test.ts`, `relatorio.ts`, `rodar.ts`

**Interfaces — Produces:**
- `calibrar(dados, f): { params: ParamsFormula; inviavel: boolean; estoqueMedio: number }` — janela de calibração, `ctx.calibracao = true`, LT `empirico`, falta `espera`, 50 replicações. Para cada β (F2) ou `janelaDias` (F3): grade de quantis da spec §5.9, descida por coordenada (2 rodadas) e **validação conjunta** das três classes; menor estoque que atinge o alvo; desempate pelo menor quantil; nada atinge → `inviavel`.
- `escolherCandidata(resultados): Formula | 'NENHUMA'` — menor estoque; uma mais simples (F1 < F3 < F2) a ≤ 1 p.p. de capital fica com a vaga.
- `rodar.ts` — `bun scripts/reposicao-replay/rodar.ts [--dados DIR] [--saida ARQ]`:
  1. carrega e monta a coorte;
  2. calibra F0 (só para o alvo) e F1–F3;
  3. escolhe e **congela** a candidata;
  4. avalia F0 e a candidata em LT × falta × inicial, e também na coorte "todos os ativos";
  5. ajusta as replicações até a precisão;
  6. aplica a tabela de decisão e escreve o relatório.

  Sai ≠ 0 só em erro de dado; NO-GO e INCONCLUSIVO não são erro.
- Relatório (`$REPLAY_DADOS/relatorio.md`), com título que usa o nome obrigatório da métrica:
  1. veredito e tabela de critérios;
  2. células × fórmula × cenário (ponto, LI, LS);
  3. fronteira capital × fill rate de F2 e F3;
  4. grade de custo e custo de falta de equilíbrio;
  5. balanço terminal e fechamento;
  6. sensibilidades (estado inicial, todos os ativos, blocos 4/8, substituição);
  7. paridade do F0 com as divergências em R$;
  8. excluídos, parados (com `compradoUltimos90d`) e negativos na avaliação;
  9. chave de cache e precisão;
  10. limites da spec §10.

- [ ] **Step 1: testes:**
  - `alvo usa F0 quando F0 > piso`: 99,6% → 99,35%
  - `calibração invariante à avaliação de ponta a ponta`: alterar vendas, recebimentos e LT posteriores a 2026-04-30 não muda params nem candidata
  - `grade acha ótimo não monotônico`: fixture do contraexemplo do Codex (múltiplo 2, LTs [1,3,1,1]) → escolhe o quantil menor, que atende 3/3
  - `todas inviáveis → NENHUMA` e veredito NO-GO `INVIAVEL_NA_CALIBRACAO`
  - `empate favorece o simples`
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5: Rodada real:** `bun scripts/reposicao-replay/rodar.ts` com `rc` capturado → `rc=0` e relatório com veredito. A precisão **não** é reduzida por tempo; se for lento demais, paralelizar por replicação.
- [ ] **Step 6:** `heavy bun run test scripts/reposicao-replay`, `heavy bun run typecheck`, `bun lint` e `bunx knip`, cada um com exit 0 colado.
- [ ] **Step 7: Commit** — `feat(reposicao-replay): calibração por grade, orquestração e relatório`

### Task 10: Documentação, Codex adversarial do código e PR

**Files:** Modify `docs/agent/reposicao.md`; Create `docs/historico/reposicao-replay-tsb.md`

- [ ] **Step 1:** nota em `reposicao.md`: `sku_leadtime_history` tem duplicatas (4.460 linhas, 1.884 distintas em 2026-10-20); a dedup correta é documental. Conferir se a fonte de `sku_parametros.lt_*` deduplica. Se não deduplicar, é bug de produção com evidência: candidato ao **único chip** da sessão, com o título exato anunciado ao Lucas.
- [ ] **Step 2:** `docs/historico/reposicao-replay-tsb.md`: entrega, veredito, números-chave e o link do relatório publicado como artefato.
- [ ] **Step 3: Codex ADVERSARIAL** do diff de código: `scripts/codex-async.sh -r max -` em background, atacando vazamento, aleatoriedade comum, contagem de obrigações, paridade do F0 e tabela de decisão. Incorporar o parecer e citá-lo no PR.
- [ ] **Step 4:** re-conferir `git fetch`, `gh pr list` e `origin/main`; abrir o PR **DRAFT** com o veredito, os pareceres e o roadmap; ligar o Auto-fix (`set_monitor`).
- [ ] **Step 5: Commit** — `docs(reposicao): replay TSB — histórico e nota de duplicatas no LT`
