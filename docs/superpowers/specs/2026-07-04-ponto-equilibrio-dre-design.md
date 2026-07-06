# F3 — Ponto de equilíbrio operacional na DRE

> Frente 3 do pacote **"PEGN — 9 erros que estrangulam a margem"** (erro 7: não saber o ponto de equilíbrio). **Overlay analítico** sobre o snapshot de DRE existente — NÃO reescreve `montarDRE` (helper puro espelhado no edge). Decisão Claude+Codex. Read-only: exibe o PE; não muda nada.

## 0. Achados de banco (aterrados via `psql-ro`)

| # | Fato | Consequência |
|---|---|---|
| 0.1 | A DRE **não separa fixo de variável** — classifica por natureza contábil (`fin_categoria_dre_mapping`: categoria omie → linha DRE, sem flag de comportamento). Não há margem de contribuição. | Precisa de classificação fixo/variável nova (config). |
| 0.2 | `fin_dre_snapshots.detalhamento->'despesas'` é **keyed por `omie_codigo`** (`{"2.01.01":213488,...}`). | **Overlay**: lê o snapshot + classificação → split, SEM tocar `montarDRE`/edge (sem risco de dessincronizar o espelho). |
| 0.3 | Concentração alta (OBEN, mês recente): `2.01.01`="Compras de Mercadorias p/ Revenda"=62,5% (CMV, variável), `2.05.03`="Pagamento de Empréstimos"=22,4% (top 2=**85%**). Descrições vêm vazias na CP (nomes só em `fin_categorias`). | Classificar um punhado cobre quase tudo; gate de cobertura por valor. A **UI de classificação DEVE mostrar a descrição** (código sozinho é opaco). |
| 0.4 | Deduções: coluna `deducoes` da OBEN vem **ZERADA** em todos os 12 meses. Os impostos sobre venda moram **dentro** do balde `detalhamento.despesas` sob código próprio: `2.06.03`=PIS, `2.06.04`=COFINS, `2.06.96`="ICMS Dif. alíquota", `2.09.01`="Devoluções de Vendas". | Impostos/devoluções = **variável** via a classificação do balde despesas — NÃO via a coluna `deducoes` (=0). Somar os dois double-conta (mitigado: OBEN tem `deducoes`=0; gate de reconciliação §6 pega). |
| 0.5 | **Itens NÃO-operacionais no balde despesas** (OBEN): `2.05.03`="Pagamento de Empréstimos" oscila **2,5%→38,7%** dos 12 meses (amortização de PRINCIPAL, lumpy); `2.06.94`="Parcelamento Impostos Federais" (0-7,4%, quitação de dívida tributária). Combinados chegam a **~40%** das despesas. A coluna `despesas_financeiras`=0 → a regra "exclui financeiras por linha" **NÃO os pega** (o Omie os jogou em `despesas_operacionais`). | Exige um 4º tipo de classificação **`nao_operacional`** (§3): financiamento/serviço de dívida que caiu no balde operacional. Excluído do PE (numerador E denominador), como as financeiras. Sem ele: fixo→PE +40% (cria lobo); variável→MC% negativa; inconclusivo→OBEN **nunca** tem PE. Conecta com F1 (PE de caixa, backlog). |
| 0.6 | `montarDRE` é helper puro ESPELHADO no edge `omie-financeiro`. `scoreConfianca` já existe (precedente de gate). | Overlay não toca o espelho; herda o padrão de gate de confiança. |

## 1. Objetivo
Calcular, por empresa, o **ponto de equilíbrio (receita bruta mínima que zera o resultado operacional)** e a **margem de segurança**, a partir do snapshot de DRE + uma classificação fixo/variável declarada. Degradar honesto quando o dado não permite. Precisão > recall: **nunca** um PE otimista fabricado.

## 2. Fórmula (base TTM — Codex P1-D5)
Trabalha sobre os **últimos 12 meses** (run-rate), não o mês único (13º/férias/seguro anual distorcem um mês):
```
custos_variaveis = deducoes_col_TTM + Σ(despesas_TTM 'variavel')   // deducoes_col=0 p/ OBEN → impostos vêm via 'variavel' (§0.4)
custos_fixos     = Σ(despesas_TTM 'fixo')                          // EXCLUI despesas_financeiras E 'nao_operacional' (§0.5)
// EXCLUÍDOS do PE (nem num. nem den.): despesas_TTM 'nao_operacional' + coluna despesas_financeiras
MC   = receita_bruta_TTM − custos_variaveis
MC%  = MC / receita_bruta_TTM
PE_receita        = custos_fixos / MC%                    // só se MC% > 0
margem_seguranca% = (receita_bruta_TTM − PE_receita) / receita_bruta_TTM
```
- **PE em receita BRUTA** — o card rotula explícito (não confundir com meta de líquida).
- **Financeiro E não-operacional fora**: o PE operacional mede se a OPERAÇÃO se paga; juros são estrutura de capital e amortização de principal (`2.05.03`) é financiamento — nenhum é custo da operação. (Backlog: "PE de caixa" separado que inclui o serviço da dívida — conecta com o F1.)
- **`deducoes_col` vs impostos no balde**: p/ evitar double-count, `custos_variaveis` usa a coluna `deducoes` (=0 na OBEN) SOMADA aos códigos de imposto do balde despesas marcados 'variavel'. Como `deducoes_col=0`, os impostos entram uma vez só (via classificação). O gate de reconciliação (§6) trava se a soma divergir da DRE.
- Assume **mesmo mix/margem do período base**; o card diz isso.

## 3. Classificação (config auditável — Codex P2)
Nova tabela `fin_dre_custo_tipo`:
```
categoria_codigo text        -- omie_codigo (casa com as chaves do detalhamento)
tipo text CHECK IN ('fixo','variavel','misto','nao_operacional')
observacao text              -- justificativa OBRIGATÓRIA p/ 'nao_operacional' (delta-E2/E4: fonte/motivo)
company text NOT NULL DEFAULT '_default'          -- override por empresa > _default (P1-D2)
updated_by uuid, updated_at timestamptz           -- auditoria (P2)
PRIMARY KEY (company, categoria_codigo)
CHECK (tipo <> 'nao_operacional' OR (observacao IS NOT NULL AND length(trim(observacao)) > 0))
```
- RLS master-only; trigger força `updated_by = auth.uid()`.
- Resolução: `company` específico vence `_default` (permite CMV industrial do colacor divergir do OBEN).
- **'misto'** (1ª classe): custo semivariável real (ex.: frete com mínimo + excedente) — não força o humano a uma mentira binária. Se material → degrada (§4).
- **'nao_operacional'** (§0.5): financiamento/serviço de dívida/quitação que o Omie jogou no balde operacional mas NÃO é custo da operação (ex.: `2.05.03` amortização de empréstimo, `2.06.94` parcelamento de imposto). **Excluído do PE**, como as financeiras. Material NÃO degrada — é exclusão limpa e conhecida (senão OBEN nunca teria PE, §0.5). **Guard-rails anti-"balde de fuga" (delta-E2/E4)**: (a) `observacao` obrigatória (CHECK acima); (b) a UI de classificação **alerta** ao marcar `nao_operacional` num código de descrição obviamente operacional (compras/folha/aluguel/imposto corrente); (c) o helper devolve `naoOperacionalSharePct` e a UI mostra **"PE com/sem exclusões"** (transparência). **2º aprovador** quando share alto → v2 (§10).

## 4. Degradação honesta (motivo, sem número)
| motivo | quando |
|---|---|
| `sem_receita` | `receita_bruta_TTM ≤ 0` |
| `mc_negativa` | `MC% ≤ 0` (variáveis ≥ receita — perde em cada real; PE não existe) |
| `inconclusivo` | **cobertura < 95%** (cobertura = % do valor das despesas classificado em QUALQUER tipo, incl. `nao_operacional`) **OU** código não classificado material (>5% das despesas ou >2% da receita) — P1-D4 |
| `custo_misto_material` | um código `'misto'` é material (>5% despesas) — P1-D6 |
| `snapshot_inconsistente` | reconciliação overlay×DRE falha (§6) — P1-D7 |
| `mc_instavel` | MC% varia demais nos 12 meses (mix/margem não estável) — P1-D8 |
| `deducoes_coluna_inesperada` | **coluna `deducoes` TTM > tolerância** (delta-E5): o design pressupõe imposto NO BALDE despesas (`deducoes_col`=0 na OBEN). Se a coluna vier preenchida, há risco de double-count (imposto na coluna E no balde) que a reconciliação não pega → degrada até mapear a fonte |
| `valor_negativo_inesperado` | **algum valor de despesa < 0 material** (delta-E7): devolução/estorno negativo no JSON faria `custos_variaveis += (−x)` INFLAR a margem por acidente → degrada (não adivinha o sinal) |
| `ok` | tudo acima passa → publica PE + margem de segurança |

**Não classificado material NÃO vira "fixo conservador"** (Codex P1-D4: pode subestimar o PE) → vira `inconclusivo`. Para OBEN, `2.05.03` (22-38%) precisa ser marcado `nao_operacional` pelo humano; enquanto estiver não-classificado = sem PE. **`nao_operacional` conta como classificado** (não puxa `inconclusivo`) — é conhecimento explícito, não um buraco. **`mc_instavel` mede a MC% da base OPERACIONAL** (já sem `nao_operacional`), senão a volatilidade de `2.05.03` dispararia falso-instável.

## 5. Escopo v1 (Codex P1-D2)
**Só OBEN** (distribuidora — CMV 2.01.x é limpo variável). Colacor (indústria, CPV absorve overhead fixo) e colacor_sc entram quando houver classificação **por empresa** do CMV. Overlay read-only; nada reescreve DRE/edge.

## 6. Reconciliação fail-closed (Codex P1-D7) + gate de overlap de deduções (delta-E5)
Antes de calcular: `Σ(detalhamento.despesas)` tem de bater com as linhas oficiais aplicáveis da DRE (cmv + operacionais + admin + comercial [+ financeiras que serão EXCLUÍDAS do cálculo]) dentro de tolerância (ex.: 1%). Se não bater → `snapshot_inconsistente`, sem número.
**Gate de overlap de deduções (delta-E5)**: o design pressupõe que os impostos sobre venda moram no BALDE `detalhamento.despesas` (classificados 'variavel') e que a coluna `deducoes` está zerada (verdade na OBEN). A reconciliação de `Σdespesas` **não pega** o double-count se a coluna `deducoes` passar a vir preenchida E os impostos continuarem no balde (deduções ficam fora daquela soma). Então: **se `deducoes_col_TTM > tolerância` → `deducoes_coluna_inesperada`** (degrada; não subtrai imposto duas vezes). `deducoes_source_mode` explícito por empresa/período → v2 (§10).

## 7. Wiring
- **Helper puro** `pontoEquilibrio(input): PontoEquilibrioResult` (vitest). Input: séries TTM (receita_bruta, `deducoes_col`, detalhamento.despesas por categoria) + o mapa de classificação + as linhas da DRE p/ reconciliar. Sem I/O. **Output inclui** (além de `pe_receita`, `mc_pct`, `custos_fixos`, `custos_variaveis`, `margem_seguranca_pct`, `cobertura_pct`, `motivo`): **`excluido_nao_operacional_ttm`** e **`excluido_nao_operacional_recente`** (R$) + **`nao_operacional_share_pct`** — para o disclosure obrigatório (delta-E3) e o guard-rail de share (delta-E4).
- **Hook** `usePontoEquilibrio(company)` — busca os 12 snapshots (regime competência, `.select("*")` já traz `detalhamento` + linhas) + a classificação (RPC RLS-safe ou leitura master), chama o helper.
- **UI**: card de PE na DRE (`FinanceiroDashboard`/`DRETab`) — mostra PE (receita bruta/mês, run-rate TTM), MC%, custos fixos, **margem de segurança**, período base, cobertura; ou o `motivo` de degradação. **Headline OBRIGA disclosure (delta-E3)**: "PE operacional — exclui R$ X/mês (TTM) de dívida/parcelamentos [não-operacional]; ver Endividamento (F1)" quando `excluido_nao_operacional_ttm > 0`. Toggle/drilldown **"PE com/sem exclusões"** (delta-E4). + **UI de classificação** (master marca fixo/variável/misto/nao_operacional por categoria — **mostra a descrição de `fin_categorias`** (§0.3), ordenada por valor, mostra cobertura, maiores não classificados, e exige `observacao` p/ nao_operacional).

## 8. Provas
- **vitest** (helper puro): cálculo (fixos/MC% conhecidos → PE); **todos** os motivos de degradação (sem_receita, mc_negativa, inconclusivo por cobertura e por código material, custo_misto_material, snapshot_inconsistente, mc_instavel, **`deducoes_coluna_inesperada`**, **`valor_negativo_inesperado`**); reconciliação; financeiro E `nao_operacional` excluídos; `nao_operacional` NÃO puxa inconclusivo mas É reportado (`excluido_nao_operacional_ttm`/`_recente`/`share_pct`); mc_instavel sobre base operacional; label receita bruta; **sinal**: devolução negativa material → degrada, não infla margem (delta-E7); **double-count**: `deducoes_col>0` material → `deducoes_coluna_inesperada` (delta-E5).
- **prove-sql-money-path** (`fin_dre_custo_tipo`): RLS master-only (nega authenticated sem role), trigger de autor, resolução company>`_default`, CHECK do tipo, **CHECK `observacao` obrigatória p/ nao_operacional** (delta-E2); falsificação (sabotar RLS/gate/CHECK → vermelho).

## 8b. Veredito Codex — DELTA `nao_operacional` (challenge xhigh, 2ª rodada)
| Item | Sev | Veredito | Onde |
|---|---|---|---|
| E1 Excluir principal de empréstimo do PE operacional | (confirmado) | correto (EBIT-zero; principal é financiamento) | §2, §3 |
| E2 `nao_operacional` exige motivo/fonte, não só descrição | P1 | `observacao` obrigatória (CHECK) | §3 |
| E3 Headline DEVE revelar o excluído (dívida em até 38%) | **P1** | helper devolve o excluído; card obriga disclosure | §7 |
| E4 Guard-rails anti-"balde de fuga" | P1 | v1: observação + warn código operacional + "PE com/sem exclusões" + share; 2º aprovador v2 | §3, §7, §10 |
| E5 `deducoes_col=0` não é garantia → gate de overlap | **P1** | `deducoes_col_TTM>tol → inconclusivo` | §4, §6 |
| E6 Devolução é contra-receita (não reduzir receita_bruta 2×) | P2 | fórmula já correta (receita bruta inteira); rótulo UI | §2, §7 |
| E7 Normalizar SINAL (devolução negativa infla margem) | **P1** | valor despesa < 0 material → degrada | §4 |
| E7b Vigência temporal da classificação | P2→v2 | classificação global v1; `effective_from` v2 | §10 |

## 9. Veredito Codex (challenge xhigh) — 7 P1 + P2 + P3, todos endereçados
| Item | Sev | Onde |
|---|---|---|
| CMV global quebra colacor → v1 OBEN | P1 | §5 |
| Financeiras fora do PE operacional | P1 | §2 |
| Não classificado material → inconclusivo (não "fixo") | P1 | §4 |
| Base TTM, não mês único | P1 | §2 |
| Estado 'misto' 1ª classe | P1 | §3, §4 |
| Reconciliação overlay×DRE fail-closed | P1 | §6 |
| Rótulo "receita bruta" + `mc_instavel` | P1 | §2, §4 |
| Deduções variável (ressalva Valor Fixo ICMS/ISS) | P2 | §4 (nota) |
| Classificação auditável (updated_by/at, override) | P2 | §3 |
| Exibir cobertura/período/mc%/maiores não classificados | P3 | §7 |

## 10. Não-objetivos / backlog
- **Colacor/colacor_sc** (CMV industrial por empresa) — v2, exige classificação por empresa.
- **`effective_from` temporal** na classificação (mudar hoje reescreve o PE histórico; código pode mudar de uso no TTM — delta-E7b) — v1 audita por `updated_by/at` e classifica pela natureza dominante; versionamento temporal é v2.
- **"PE de caixa"** (inclui serviço da dívida do F1 — o excluído `nao_operacional`) — indicador separado, backlog. É o complemento honesto do disclosure do headline (delta-E3).
- **2º aprovador p/ `nao_operacional`** quando share alto (>5% receita TTM / >10% despesas / muda PE >15%) — workflow de aprovação dupla é v2; v1 usa observação obrigatória + transparência "com/sem exclusões" (delta-E4).
- **`deducoes_source_mode`** explícito por empresa/período (`coluna`/`detalhamento`/`mapeado_sem_overlap`/`inconclusivo`) — v1 usa o gate binário `deducoes_col_TTM>tol → inconclusivo` (delta-E5).
- **Split de semivariável** (parte fixa + parte variável de um mesmo código) — hoje 'misto' degrada; split fino é v2.
- **PE por mix marginal** (não média histórica) — o card avisa "assume o mix do período"; modelo marginal é v2.
