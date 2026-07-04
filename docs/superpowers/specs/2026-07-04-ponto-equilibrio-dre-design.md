# F3 — Ponto de equilíbrio operacional na DRE

> Frente 3 do pacote **"PEGN — 9 erros que estrangulam a margem"** (erro 7: não saber o ponto de equilíbrio). **Overlay analítico** sobre o snapshot de DRE existente — NÃO reescreve `montarDRE` (helper puro espelhado no edge). Decisão Claude+Codex. Read-only: exibe o PE; não muda nada.

## 0. Achados de banco (aterrados via `psql-ro`)

| # | Fato | Consequência |
|---|---|---|
| 0.1 | A DRE **não separa fixo de variável** — classifica por natureza contábil (`fin_categoria_dre_mapping`: categoria omie → linha DRE, sem flag de comportamento). Não há margem de contribuição. | Precisa de classificação fixo/variável nova (config). |
| 0.2 | `fin_dre_snapshots.detalhamento->'despesas'` é **keyed por `omie_codigo`** (`{"2.01.01":213488,...}`). | **Overlay**: lê o snapshot + classificação → split, SEM tocar `montarDRE`/edge (sem risco de dessincronizar o espelho). |
| 0.3 | Concentração alta (OBEN 365d): `2.01.01`=43,3%, `2.05.03`=35,4% (top 2=**79%**, top 6=**92%**). Descrições vêm vazias na CP (nomes só no catálogo). `2.05.03` (35%) é grande desconhecido. | Classificar um punhado cobre quase tudo; o gate de cobertura é por valor. `2.05.03` sem humano = sem PE. |
| 0.4 | A DRE já isola `deducoes` (ICMS/PIS/COFINS/DAS — escalam com receita) e `despesas_financeiras` (juros/tarifas). | Deduções = variável (com ressalva de Valor Fixo ICMS/ISS). Financeiras = fora do PE operacional. |
| 0.5 | `montarDRE` é helper puro ESPELHADO no edge `omie-financeiro`. `scoreConfianca` já existe (precedente de gate). | Overlay não toca o espelho; herda o padrão de gate de confiança. |

## 1. Objetivo
Calcular, por empresa, o **ponto de equilíbrio (receita bruta mínima que zera o resultado operacional)** e a **margem de segurança**, a partir do snapshot de DRE + uma classificação fixo/variável declarada. Degradar honesto quando o dado não permite. Precisão > recall: **nunca** um PE otimista fabricado.

## 2. Fórmula (base TTM — Codex P1-D5)
Trabalha sobre os **últimos 12 meses** (run-rate), não o mês único (13º/férias/seguro anual distorcem um mês):
```
custos_variaveis = deducoes_TTM + Σ(despesas_TTM classificadas 'variavel')   // inclui CMV 2.01.x (OBEN)
custos_fixos     = Σ(despesas_TTM classificadas 'fixo')                        // EXCLUI despesas_financeiras (P1-D3)
MC   = receita_bruta_TTM − custos_variaveis
MC%  = MC / receita_bruta_TTM
PE_receita        = custos_fixos / MC%                    // só se MC% > 0
margem_seguranca% = (receita_bruta_TTM − PE_receita) / receita_bruta_TTM
```
- **PE em receita BRUTA** — o card rotula explícito (P1-D8; não confundir com meta de líquida).
- **Financeiro fora** (P1-D3): o PE operacional mede se a OPERAÇÃO se paga; juros são estrutura de capital. (Backlog: "PE de caixa" separado que inclui o serviço da dívida — conecta com o F1.)
- Assume **mesmo mix/margem do período base**; o card diz isso (P1-D8).

## 3. Classificação (config auditável — Codex P2)
Nova tabela `fin_dre_custo_tipo`:
```
categoria_codigo text        -- omie_codigo (casa com as chaves do detalhamento)
tipo text CHECK IN ('fixo','variavel','misto')   -- 'misto' é 1ª classe (P1-D6)
company text NOT NULL DEFAULT '_default'          -- override por empresa > _default (P1-D2)
updated_by uuid, updated_at timestamptz           -- auditoria (P2)
PRIMARY KEY (company, categoria_codigo)
```
- RLS master-only; trigger força `updated_by = auth.uid()`.
- Resolução: `company` específico vence `_default` (permite CMV industrial do colacor divergir do OBEN).
- **'misto'** existe para custo semivariável real (ex.: frete com mínimo + excedente) — não força o humano a uma mentira binária.

## 4. Degradação honesta (motivo, sem número)
| motivo | quando |
|---|---|
| `sem_receita` | `receita_bruta_TTM ≤ 0` |
| `mc_negativa` | `MC% ≤ 0` (variáveis ≥ receita — perde em cada real; PE não existe) |
| `inconclusivo` | cobertura < 95% **OU** existe código não classificado material (>5% das despesas ou >2% da receita) — P1-D4 |
| `custo_misto_material` | um código `'misto'` é material (>5% despesas) — P1-D6 |
| `snapshot_inconsistente` | reconciliação overlay×DRE falha (§6) — P1-D7 |
| `mc_instavel` | MC% varia demais nos 12 meses (mix/margem não estável) — P1-D8 |
| `ok` | tudo acima passa → publica PE + margem de segurança |

**Não classificado material NÃO vira "fixo conservador"** (Codex P1-D4: pode subestimar o PE) → vira `inconclusivo`. Para OBEN, `2.05.03` (35%) sem humano = sem PE.

## 5. Escopo v1 (Codex P1-D2)
**Só OBEN** (distribuidora — CMV 2.01.x é limpo variável). Colacor (indústria, CPV absorve overhead fixo) e colacor_sc entram quando houver classificação **por empresa** do CMV. Overlay read-only; nada reescreve DRE/edge.

## 6. Reconciliação fail-closed (Codex P1-D7)
Antes de calcular: `Σ(detalhamento.despesas)` tem de bater com as linhas oficiais aplicáveis da DRE (cmv + operacionais + admin + comercial [+ financeiras que serão EXCLUÍDAS do cálculo]) dentro de tolerância (ex.: 1%). Se não bater → `snapshot_inconsistente`, sem número. **Cuidado com dupla contagem**: `despesas_financeiras` aparecem no detalhamento E na linha própria — o helper as identifica pela classificação/linha e as EXCLUI uma única vez.

## 7. Wiring
- **Helper puro** `pontoEquilibrio(input): PontoEquilibrioResult` (vitest). Input: séries TTM (receita_bruta, deducoes, detalhamento.despesas por categoria) + o mapa de classificação + as linhas da DRE p/ reconciliar. Sem I/O.
- **Hook** `usePontoEquilibrio(company)` — busca os 12 snapshots + a classificação (RPC RLS-safe ou leitura master), chama o helper.
- **UI**: card de PE na DRE (`FinanceiroDashboard`/`DRETab`) — mostra PE (receita bruta/mês, run-rate TTM), MC%, custos fixos, **margem de segurança**, período base, cobertura; ou o `motivo` de degradação. + **UI de classificação** (master marca fixo/variável/misto por categoria, ordenada por valor, mostra cobertura e maiores não classificados).

## 8. Provas
- **vitest** (helper puro): cálculo (fixos/MC% conhecidos → PE); todos os motivos de degradação (sem_receita, mc_negativa, inconclusivo por cobertura e por código material, custo_misto_material, snapshot_inconsistente, mc_instavel); reconciliação; financeiro excluído; label receita bruta.
- **prove-sql-money-path** (`fin_dre_custo_tipo`): RLS master-only (nega authenticated sem role), trigger de autor, resolução company>`_default`, CHECK do tipo; falsificação (sabotar RLS/gate → vermelho).

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
- **`effective_from` temporal** na classificação (mudar hoje reescreve o PE histórico) — v1 audita por `updated_by/at`; versionamento temporal é v2.
- **"PE de caixa"** (inclui serviço da dívida do F1) — indicador separado, backlog.
- **Split de semivariável** (parte fixa + parte variável de um mesmo código) — hoje 'misto' degrada; split fino é v2.
- **PE por mix marginal** (não média histórica) — o card avisa "assume o mix do período"; modelo marginal é v2.
