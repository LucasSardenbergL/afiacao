# F3 v2 — Rateio de custo fixo compartilhado (folha CSC → operação da OBEN) no Ponto de Equilíbrio

> Extensão do F3 (`2026-07-04-ponto-equilibrio-dre-design.md`). **Fato de negócio** (confirmado pelo founder, 2026-07-08): a folha dos funcionários da OBEN **roda na Colacor SC** (empresa do Simples — os funcionários estão fichados lá). Consequência: a DRE da OBEN **não** carrega o custo de mão de obra que faz a operação da OBEN girar → o PE lido isolado subestima o custo fixo e infla a margem de segurança. **Money-path** (muda o PE): precisão > recall — o rateio é **input humano** (não fabricamos a parcela); sem rateio, o card **vela o número** com aviso, em vez de exibir a margem inflada. Decisão Claude + Lucas (velar nº; valor R$ fixo mensal). Read-only sobre o snapshot: o rateio é um **overlay aditivo**, não reescreve `montarDRE`/edge.

> **⚠️ Errata contábil — 2026-07-09** (Codex+Claude sobre dados de prod, `colacor_sc` TTM competência). A marcação de "ambíguos" da folha usada em §0.3, §6 e §10-C6 estava **errada**; o código foi corrigido (`FOLHA_AMBIGUA` em `usePontoEquilibrio.ts`, pinado em `ponto-equilibrio-folha-ambigua.test.ts`):
> - O **Adiantamento de Salário (2.03.02) NÃO é ambíguo** — os dados provam que é a **2ª parcela do MESMO salário**: co-ocorre com Salários (2.03.01) todo mês até dez/25 e **some** quando a folha consolidou numa parcela só em jan/26 (2.03.01 sozinho ≈ 2.03.01+2.03.02 dos meses anteriores). É **custo real** → contar, não excluir (excluí-lo subestimava a folha em ~R$4–5,6k/mês).
> - A retenção do empregado (já embutida no Salário **bruto**, não custo patronal extra no Simples: sem INSS patronal) é o **INSS (2.03.06)** + **IRRF (2.03.08)** — esse é o par marcado agora. FGTS (2.03.07) é custo patronal real e **não** é marcado.
> - `FOLHA_AMBIGUA = {2.03.06, 2.03.08}` (era `{2.03.02, 2.03.08}`); o rótulo do dialog virou "retenção do empregado (já no salário bruto)".
>
> O texto de §0.3/§6/§10-C6 abaixo fica **preservado como registro do entendimento da época**.

## 0. Achados de banco (aterrados via `psql-ro`, TTM abr/25–mar/26, regime competência)

| # | Fato | Consequência |
|---|---|---|
| 0.1 | **OBEN** (27 snapshots competência, jan/24–mar/26): receita bruta TTM **R$ 3.730.161** (R$ 310.847/mês); despesas classificadas: variável **R$ 204.196/mês**, não-operacional **R$ 73.178/mês** (excluído), **fixo R$ 10.369/mês**, não-classificado R$ 2.952/mês (cobertura 98,98% → passa). | Confirma o card atual: MC% **34,3%**, PE **R$ 30.222/mês**, **margem de segurança 90,3%** (verde, sem ressalva) — fiel aos livros da OBEN, mas incompleto. |
| 0.2 | A OBEN **não tem nenhum código de folha** (`2.03.*`) no `detalhamento.despesas` — o custo de mão de obra simplesmente não existe no snapshot dela. | O rateio é um custo **externo ao snapshot**: entra como aditivo ao `custos_fixos`, **fora** da reconciliação §6 (que valida a integridade do snapshot original). Injetá-lo no `detalhamento` quebraria a reconciliação. |
| 0.3 | **CSC** (27 snapshots competência): a folha vive nos códigos `2.03.*` — Salários **R$ 14.737/mês**, Adiantamento de Salário R$ 3.730 ⚠, Vale Alimentação R$ 2.838, Plano de Saúde R$ 2.541, FGTS R$ 2.108, Férias R$ 993, INSS R$ 754, Rescisões R$ 493, VT R$ 270, IRRF R$ 255 ⚠, SST R$ 230, Alimentação R$ 209, Outros Benefícios R$ 175, Seguro de Vida R$ 65. **Total `2.03.*` ≈ R$ 29,4k/mês**; excluindo Adiantamento (2.03.02, antecipação compensável) e IRRF (2.03.08, retenção do empregado) ≈ **R$ 25,4k/mês** de folha-custo. | A folha total da CSC é o **teto de referência** (~R$ 25–29k/mês) que a UI mostra ao master pra dimensionar. Mas a CSC **também tem operação própria de serviços** → a parcela atribuível à OBEN é **< folha total** e é o input humano (§3). Nunca fabricamos o split. |
| 0.4 | **Impacto** (rateio somado ao fixo): rateio R$ 20k/mês → fixo R$ 30,4k → PE R$ 88,5k/mês → **margem 71,5%**; folha inteira R$ 29k → fixo R$ 39,4k → PE R$ 114,7k → **margem 63,1%**. | A OBEN *tem* margem boa (receita R$ 310k, MC 34%), mas os 90% eram inflados. A diferença 90%→~70% é **material** para decidir puxar caixa da OBEN (caixa por-CNPJ não-fungível, `financeiro.md`). |

## 1. Objetivo
Permitir que o master lance um **custo fixo compartilhado** (a parcela mensal da folha da CSC atribuível à operação da OBEN) que entra no `custos_fixos` do helper `pontoEquilibrio`, corrigindo o PE e a margem de segurança. Enquanto não lançado, **velar** o PE/margem com aviso honesto (nunca exibir a margem que sabemos inflada). Precisão > recall — o rateio é declaração humana auditável, não estimativa automática.

## 2. Fórmula (aditivo ao fixo, pós-reconciliação)
Sobre a base já calculada do F3 (§2 da spec base), quando o rateio está lançado:
```
custo_compartilhado_ttm = valor_mensal × nº_meses          // proporcional aos meses presentes (consistente com receita_ttm)
custos_fixos            = Σ(despesas_TTM 'fixo') + custo_compartilhado_ttm   // aditivo, APÓS os gates de integridade
PE_receita              = custos_fixos / MC%
margem_seguranca%       = (receita_bruta_TTM − PE_receita) / receita_bruta_TTM
```
- **MC% NÃO muda** — a folha é custo **fixo** (não entra em `custos_variaveis`). Só o `custos_fixos` (e por consequência PE e margem) se movem.
- **`valor_mensal` é custo mensal NORMALIZADO** (base anual ÷ 12, já incluindo 13º, férias e encargos) — não o "mês corrente" (Codex-C7). `nº_meses` = **meses-calendário cobertos pelo snapshot** (`meses.length`), não "meses com receita". Assim `valor_mensal × nº_meses` não distorce o TTM com sazonalidade de folha. A UI e o comment da coluna rotulam isso.
- O rateio **não entra na reconciliação §6** (não é dado do snapshot; é overlay humano). A reconciliação continua validando `Σdespesas_snapshot × linhas DRE` da OBEN, intacta.
- `valor_mensal = 0` lançado (com justificativa) é **válido e não-degradante**: o master afirmando "sem folha atribuível" → PE = o de hoje, com disclosure "rateio confirmado R$ 0". Distinto de *não lançado* (que degrada) — a UI separa a ação "confirmar R$ 0" (linha ativa) de "remover rateio" (`ativo=false` → volta a pendente) para as duas não colapsarem na mesma semântica (Codex-C4).

## 3. Persistência — tabela `fin_custo_rateio` (migration, RLS master-only)
Molde: `fin_dre_custo_tipo` (spec base §3).
```sql
CREATE TABLE public.fin_custo_rateio (
  company          text        NOT NULL,   -- empresa DESTINO (arca no PE), ex 'oben'
  rotulo           text        NOT NULL,   -- item de custo compartilhado, ex 'folha'
  valor_mensal_brl numeric     NOT NULL CHECK (valor_mensal_brl >= 0),  -- custo mensal NORMALIZADO (anual÷12, c/ 13º+férias+encargos), NÃO mês corrente (Codex-C7)
  origem_company   text        NOT NULL,   -- onde o custo é pago hoje, ex 'colacor_sc' (disclosure)
  observacao       text        NOT NULL CHECK (length(trim(observacao)) > 0),  -- justificativa/fonte OBRIGATÓRIA (v1 texto guiado; campos estruturados = backlog, Codex-C5)
  ativo            boolean     NOT NULL DEFAULT true,   -- false = tratado como não-lançado (volta a pendente); distinto de valor=0 confirmado (Codex-C4)
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),  -- disclosure de frescor no card (vigência temporal plena = backlog, Codex-C2)
  PRIMARY KEY (company, rotulo)
);
```
- **RLS master-only** (SELECT/INSERT/UPDATE/DELETE só master), espelhando `fin_dre_custo_tipo`. Tabela nova → RLS obrigatório.
- **Trigger** força `updated_by = auth.uid()` e `updated_at = now()` (auditoria — o número move o PE).
- `observacao` **obrigatória** (CHECK): mesmo racional do `nao_operacional` (delta-E2 da base) — um input que muda o PE precisa de fonte/justificativa rastreável, não um chute sem lastro.
- `CHECK ≥ 0` (não `> 0`): permite o "R$ 0 confirmado" auditável (§2).
- `ativo = false` = tratado como **não lançado** pelo wiring (degrada) — permite desligar sem apagar o histórico.
- Via `lovable-db-operator` (handoff + validação pós-apply); **provada** por `prove-sql-money-path` antes de entregar.

## 4. Política de exigência (quem exige rateio)
O helper precisa de um **sinal positivo** de "esta empresa exige rateio" — a *ausência* de linha em `fin_custo_rateio` não distingue "não precisa" de "precisa e não lançaram".
- Constante documentada no wiring: `EMPRESAS_COM_FOLHA_EXTERNA = { oben: { origem: 'colacor_sc', rotulo: 'folha' } }`. O hook deriva `exigeCustoCompartilhado = company ∈ EMPRESAS_COM_FOLHA_EXTERNA`.
- Racional: v1 é OBEN-only; o fato "OBEN não tem folha própria" é **estável e específico** (colacor e colacor_sc têm folha própria), registrado em `docs/agent/financeiro.md` (item 1 do escopo). Escala trivial (nova chave) no v2.

## 5. Degradação honesta (dois novos motivos, precedência)
**Motivo A — `custo_compartilhado_possivel_duplicidade`** (anti-double-count, Codex-C1). O wiring passa `custoCompartilhadoNoSnapshotTtm` = Σ dos códigos de folha (`2.03.*`) que aparecerem **no snapshot da própria empresa** (hoje OBEN = R$ 0, §0.2). Se `exige === true` E esse valor > materialidade (`materialDespesaPct × despesasTTM`) → a folha já está (parcialmente) no snapshot e somar o rateio dobraria:
```
se exige && custoCompartilhadoNoSnapshotTtm > materialDespesaPct × despesasTTM:
    degradar('custo_compartilhado_possivel_duplicidade', ctx)   // NÃO soma o rateio; vela
```
**Motivo B — `custo_compartilhado_pendente`** — **último gate antes de `ok`**:
```
se exige === true E (custoCompartilhado == null OU valor_mensal não-finito):
    degradar('custo_compartilhado_pendente', ctx)   // vela pe_receita e margem_seguranca (null)
                                                     // MAS preserva mc_pct, custos_fixos (fixo conhecido, sem folha), receita, cobertura
```
- **Precedência** (após os gates da base): sinal → reconciliação → sem_receita → deduções → cobertura/inconclusivo → misto → mc_negativa → mc_instavel → **duplicidade** → **pendente** → ok. Racional do pendente por último: só peço o rateio quando o PE operacional puro **já calcularia** (senão o card manda "classifique primeiro" — a incompletude mais fundamental vence).
- **Bloqueio secundário latente** (Codex-C8): quando degrada por um motivo ANTERIOR mas `exige && rateio ausente`, o result seta `custo_compartilhado_pendente_latente = true` — o card avisa "além disto, falta ratear a folha" (o master vê o caminho completo, não descobre a pendência só depois).
- **Contrato de saída explícito** (Codex-C10): `can_show_break_even: boolean` = `(motivo === 'ok')`. Quando `false`, `pe_receita` e `margem_seguranca` são **sempre `null`** — a UI e os consumidores **não podem** recomputar o PE localmente (teste trava isso). O `custo_compartilhado_pendente` preserva o contexto verdadeiro (MC%, fixo conhecido, receita) para o card mostrar "a operação *parece* se pagar fácil, MAS…", mas o número velado não é derivável.
- `!exige` (colacor/csc) → comportamento **inalterado** (nunca degrada por isso).

**Campos novos do `PontoEquilibrioResult`** (canônico p/ o plano) — além dos existentes:
```ts
motivo: MotivoPE            // + 'custo_compartilhado_pendente' | 'custo_compartilhado_possivel_duplicidade'
custo_compartilhado_ttm: number          // valor_mensal × n (0 quando ausente/não-aplicável)
custo_compartilhado_mensal: number       // valor_mensal lançado (0 se ausente)
custo_compartilhado_origem: string | null   // ex 'colacor_sc' (disclosure)
custo_compartilhado_pendente_latente: boolean  // C8 — pendência sob outra degradação
can_show_break_even: boolean             // C10 — === (motivo === 'ok'); false ⇒ pe_receita e margem_seguranca null
```

## 6. UI
- **Card `PontoEquilibrioCard`:**
  - motivo `custo_compartilhado_pendente` → **estado próprio** (não o warning genérico): "A operação *parece* se pagar fácil (MC {mc%}, custo fixo conhecido {fixo}/mês), mas o custo de mão de obra não está aqui — a **folha roda na Colacor SC**. Lance o rateio para ver a margem real." + botão "Lançar rateio da folha".
  - motivo `custo_compartilhado_possivel_duplicidade` → aviso: "há folha (`2.03.*`) no próprio snapshot da OBEN ({valor}/mês) — somar o rateio dobraria. Revise a classificação ou zere o rateio antes."
  - motivo `ok` com `custo_compartilhado_ttm > 0` → **disclosure positivo** (simétrico ao do não-operacional): "PE **inclui** {rateio}/mês de folha rateada da CSC ({origem}, lançado em {updated_at:mês/ano}). É custo **econômico**, não saída de caixa registrada na OBEN — a folha é paga pela CSC (caixa por-CNPJ não-fungível)." (Codex-C12 + C2).
  - qualquer degradação com `custo_compartilhado_pendente_latente` → nota-rodapé "além disto, falta ratear a folha".
- **Dialog de lançamento** (`RateioFolhaDialog`, próprio, master-only): campo R$/mês (rotulado **"custo mensal normalizado — anual÷12, com 13º/férias/encargos"**) + justificativa obrigatória guiada (placeholder: "como chegou nesse valor? ex.: 70% da folha = N pessoas da operação OBEN") + duas ações distintas: **"Salvar rateio"** e **"Confirmar sem folha (R$ 0)"**, além de **"Remover"** (desativa). **Referência viva** (Codex-C6): lê a folha `2.03.*` da CSC (competência TTM) e mostra a **composição** (Salários, FGTS, INSS, férias, VA, saúde…), **marcando Adiantamento (2.03.02) e IRRF (2.03.08) como "pagamentos, não necessariamente custo econômico"** — total ≈ R$ 25–29k/mês como **teto de referência** (a parcela OBEN é fração), nunca um número pré-preenchido. Salva via `useSalvarCustoRateio` (upsert). Editável quando já lançado.

## 7. Wiring (`usePontoEquilibrio`)
- Nova query `useCustoRateio(company)` — lê `fin_custo_rateio` (`company`, `rotulo='folha'`, `ativo=true`) via cast `unknown` (padrão `useFunding`/`fin_dre_custo_tipo`, fora dos tipos gerados).
- Passa ao helper: `custoCompartilhado` (linha ou `null`) + `exigeCustoCompartilhado` (da constante §4) + **`custoCompartilhadoNoSnapshotTtm`** = Σ dos códigos com prefixo de folha (`FAMILIA_FOLHA = ['2.03']`) nas `despesas` da própria empresa no TTM (sinal anti-duplicidade C1 — o wiring conhece a família de folha; o helper fica agnóstico, só compara com a materialidade).
- Mutation `useSalvarCustoRateio` (upsert `onConflict: company,rotulo`), master-only, invalida `['custo_rateio', company]` + o recompute do PE.
- **Referência da folha CSC** (dialog): query separada `useFolhaReferencia('colacor_sc')` — lê `2.03.*` do snapshot da CSC (competência TTM) com descrições de `fin_categorias`, para a composição/teto (§6). Só no dialog (não acopla o cálculo do PE da OBEN ao snapshot da CSC).
- **Sem edge/RPC nova** — leitura master-gated com RLS, como a classificação.

## 8. Provas
- **vitest** (helper puro — `ponto-equilibrio-helpers.test.ts`):
  - rateio presente → `custos_fixos = fixo + valor_mensal×n`, PE sobe, margem cai (números conhecidos: fixo 10.369 + 20.000 = 30.369/mês → margem ≈ 71,5%); **MC% inalterada**.
  - `exige && ausente` → `custo_compartilhado_pendente`; `pe_receita`/`margem_seguranca` **null**; `mc_pct`/`custos_fixos`/`receita_bruta_ttm`/`cobertura_pct` **preservados**.
  - `exige && valor 0` → `ok`; PE idêntico ao sem-rateio; `custo_compartilhado_ttm = 0`.
  - `!exige` (colacor) → comportamento inalterado (não degrada, não soma nada).
  - **duplicidade** (Codex-C1): `exige` E folha `2.03.*` material no snapshot da própria empresa → `custo_compartilhado_possivel_duplicidade`; **não soma** o rateio; `can_show_break_even = false`.
  - **contrato** (Codex-C10): em todo motivo ≠ `ok`, `can_show_break_even === false` **e** `pe_receita === null` **e** `margem_seguranca === null` (guarda contra recomputo local).
  - **latente** (Codex-C8): degradação por `inconclusivo` com `exige && rateio ausente` → `custo_compartilhado_pendente_latente === true`.
  - **precedência**: classificação incompleta **E** rateio ausente → `inconclusivo` (não `custo_compartilhado_pendente`).
  - meses parciais (n<12): `valor_mensal×n` consistente com `receita_ttm` sobre os mesmos n meses.
- **prove-sql-money-path** (`fin_custo_rateio`): RLS master-only (nega `authenticated` sem role, sob `SET ROLE` + GUC); trigger de autor (`updated_by = auth.uid()`); CHECK `valor >= 0`; CHECK `observacao` não-vazia; **falsificação** (sabotar RLS/CHECK → exigir vermelho).

## 9. Escopo v1 / backlog
- **v1**: só **OBEN**, só **folha**, valor **R$ fixo mensal**, **velar** quando pendente.
- **Backlog** (vários levantados pelo Codex-challenge §10 e mandados a v2 por proporcionalidade / coerência com a base):
  - **% automático** da folha da CSC (lê `2.03.*` do snapshot da CSC × %) — acompanha a folha viva, mas acopla ao snapshot/classificação da OUTRA empresa (frescor vira dependência). Rejeitado no v1 por fragilidade.
  - **Vigência temporal plena** (Codex-C2): `effective_from/to`, `base_period`, `stale_after` → velar rateio fora da janela / vencido. v1 mostra só a data (`updated_at`). Coerente com a base, que pôs `effective_from` da classificação em v2.
  - **Política por-empresa em tabela** (Codex-C3): ao expandir F3 além da OBEN, trocar a constante por `fin_empresa_folha_politica (required|not_required|unknown)` — `unknown` **vela** (ausência ≠ "não exige"). Enquanto F3 é OBEN-only, a constante basta.
  - **Anti-double-count completo** (Codex-C1): varredura por fornecedor/histórico/intercompany, além do gate `2.03.*`-no-snapshot já no v1.
  - **Justificativa estruturada** (Codex-C5): `metodo_rateio`/`fonte`/`base_calculo`/`periodo_fonte`/`valor_total_referencia` — v1 usa `observacao` texto guiado (como o `nao_operacional` da base).
  - **Audit-log histórico** (Codex-C4): trilha de versões, não só `updated_by/at` sobrescrito.
  - **Widen leitura p/ gestor/staff** (Codex-C11): junto com o widen do card F3 inteiro (já v2 na base) — v1 é master-only ponta-a-ponta (card + classificação + rateio).
  - **Outros custos compartilhados** (aluguel/contador/pró-labore) — a tabela já suporta (`rotulo`); a UI generaliza no v2.
  - **2º aprovador** quando o rateio move o PE além de um limiar (ex.: margem cai >20 p.p.) — v1 usa observação obrigatória + disclosure.

## 10. Veredito Codex (challenge xhigh, gpt-5.5) — 3 P1 + 8 P2 + 1 P3
Veredito do Codex: *"a direção é correta para money-path — rateio aditivo, MC% intacta, pendente velando PE/margem. Não shiparia sem fechar os guardrails."* Os 3 bloqueadores nomeados: **reconciliação negativa contra duplicidade**, **vigência temporal**, **política explícita de exigência**. Calibração (o founder conduz o ritual e integra com julgamento de escopo):

| # | Sev | Achado | Tratamento | Onde |
|---|---|---|---|---|
| C1 | P1 | Double-count não bloqueado (folha volta ao snapshot / reembolso / fee) | **v1 leve**: gate `custo_compartilhado_possivel_duplicidade` (Σ`2.03.*` no snapshot da empresa > material → vela). Varredura fornecedor/histórico = backlog | §5, §8, §9 |
| C2 | P1→P2 | Rateio sem vigência aplica valor errado no tempo | **v2** (coerência: base pôs `effective_from` da classificação em v2) + **v1 disclosure de `updated_at`** no card | §3, §6, §9 |
| C3 | P1→P2 | Requirement hardcoded → falso OK por omissão | **constante v1** (Codex concede como trava; card é OBEN-only) + doc "ausência≠não-exige → tabela `unknown`-vela ao expandir" | §4, §9 |
| C4 | P2 | `ativo` vs "zero confirmado" colapsam | **v1**: UI separa "confirmar R$ 0" (linha ativa) de "remover" (`ativo=false`→pendente). Audit-log histórico = backlog | §2, §3, §6, §9 |
| C5 | P2 | `observacao` não-vazia é controle fraco | **v1**: texto **guiado** na UI (coerente c/ `nao_operacional` da base). Campos estruturados = backlog | §3, §6, §9 |
| C6 | P2 | Folha CSC como "teto" pode ser economicamente errada (2.03.* mistura) | **v1**: dialog mostra **composição** + marca Adiantamento/IRRF como "pagamento, não custo econômico" | §6 |
| C7 | P2 | `valor_mensal × nº_meses` precisa definição contábil | **v1**: `valor_mensal` = **custo mensal normalizado** (anual÷12, c/ 13º/férias/encargos); `nº_meses` = meses-calendário do snapshot | §2, §3 |
| C8 | P2 | Gate pendente por último esconde bloqueio secundário | **v1**: flag `custo_compartilhado_pendente_latente` no result | §5, §8 |
| C9 | P2 | Velar é certo; risco residual: deploy "apaga" o card | **v1**: velar ≠ vazio (CTA rico); + **nota de rollout** (§11) | §11 |
| C10 | P2 | Campos preservados permitem recomputo indevido do PE | **v1**: contrato `can_show_break_even=false` + pe/margem `null` garantidos; teste trava | §5, §8 |
| C11 | P2 | RLS master-only bloqueia leitura operacional | **v1 master-only** (coerente: card F3 + classificação são master-only); widen = v2 junto | §7, §9 |
| C12 | P3 | Falta disclosure de caixa por CNPJ | **v1**: disclosure "custo econômico, não saída de caixa da OBEN" | §6 |

## 11. Rollout (Codex-C9 — evitar "apagar" o card no deploy)
Como ligar `exige` para a OBEN faz o card virar `custo_compartilhado_pendente` até o master lançar, a ordem de entrega (Lovable, 3 camadas) minimiza a janela de card velado:
1. **Migration** `fin_custo_rateio` (SQL Editor) + **Publish frontend** (helper/hook/UI) — o gate já ativo, mas o card pendente é **acionável** (MC%, fixo conhecido, CTA + estimativa da folha CSC), não vazio.
2. O **master lança o rateio** imediatamente (o CTA + a referência viva da folha CSC guiam o valor) e **valida** o novo PE/margem.
3. Comunicar: o "sumiço" dos 90% é **intencional** (o número era inflado) — não é bug.
> Não há flag de rollout separada (YAGNI, OBEN-only): o próprio estado pendente-acionável é a transição segura.
