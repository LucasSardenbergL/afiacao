# F4 — Termômetro de dependência de antecipação (PEGN erro 2) — design

> Status: **decisão de escopo com kill-switch DISPARADO** (grounding §0). Fonte automática inviável;
> única fonte honesta é o input humano do F1. Veredito Codex pendente (§8). Founder delegou a
> decisão ("decida você e o Codex") — money-path, então Codex adjudica antes de cravar.

## 0. Grounding (o kill-switch) — a parte que decide tudo

O kill-switch pré-acordado com o founder: **só construir F4 se o dado distinguir antecipação
bancária (desconto de duplicatas = dívida cara de curto prazo, sinal RUIM) de adiantamento de
cliente (cliente paga antes = funding saudável, sinal BOM)** — são sinais opostos; sem separá-los,
o termômetro fabricaria um número enganoso.

Rodei 3 varreduras em produção (psql read-only, `claude_ro`, últimos 12 meses):

| Fonte | Filtro | Resultado |
|---|---|---|
| `fin_movimentacoes` (24.866 linhas, `categoria_descricao` 100% preenchida) | `ILIKE antecip/desconto/factoring/duplicata/deságio` em categoria **e** descrição livre | **0 linhas** |
| `fin_movimentacoes.natureza` | distribuição completa | só códigos de tipo-movimento Omie (BAXP/BAXR/VENR/TRAP…); `AP*` = conciliação interna ("CONTA_A_RECEBER · RECEBIDO"), **não** adiantamento |
| `fin_contas_pagar` | `ILIKE antecip/desconto/banc/financ/juros/deságio/tarifa/empréstimo/duplicata` | **0 linhas** (o deságio não é lançado como conta a pagar) |
| `fin_categorias` (dicionário DRE) | todas as categorias financeiras | só **empréstimo**: `2.05.03 Pagamento de Empréstimos`, `2.05.01 Juros s/ Empréstimos`, `1.04.03 Empréstimos Bancários`, `2.05.04 Despesas/Tarifas Bancárias`. **Nenhuma** "Antecipação de Recebíveis"/"Desconto de Duplicatas"/"Factoring" |
| `fin_contas_receber` AR aberto | `sum(saldo)` por empresa | OBEN R$380k · colacor R$144k · colacor_sc R$9k (pequeno) |

**Conclusão:** o Omie **não registra antecipação de recebíveis** dessas 3 empresas de nenhuma forma
distinguível (nem categoria, nem `natureza`, nem texto livre, nem como conta a pagar). Elas se
financiam por **empréstimo** — que é visível, categorizado, e território do **F1 Endividamento**.
Inferir "dependência de antecipação" desse dado seria **fabricar sinal do nada** → viola
"ausente ≠ zero / precisão > recall". **F4 NÃO pode ser um detector automático.**

## 1. Consequência de escopo

- **Tese A** — kill-switch disparou p/ auto-detecção. Nada a derivar do Omie.
- **Tese B** — a única fonte honesta é o **input humano do F1**: as linhas `fin_dividas` com
  `tipo='antecipacao_recorrente'` (rotulado pela mão do master; adiantamento de cliente nunca é
  cadastrado como dívida). O F1 (decisão #5) já reserva isso: `antecipacao_recorrente` fica **fora
  do DSCR** e é "mostrada como exposição recorrente à parte" — **F4 é esse 'à parte'**.
- **Tese C (DECISÃO — Caminho B)** — colapsar F4 num **card fino DENTRO da view de Endividamento
  (F1)**, NÃO módulo separado, NÃO auto-detecção. Ver §3/§5.

**Decisão (2026-07-05, founder delegou "decida você e o Codex"; Codex bloqueado por outage do
classificador → Caminho B):** construir a Tese C, mas em passo baixo-arrependimento — **helper puro
+ testes primeiro** (substância money-path, robusta a qualquer veredito), **UI depois** de rodar o
Codex retroativo (a UI é onde "build vs adiar" custa superfície). `REVISÃO INDEPENDENTE PENDENTE` —
rodar o Codex assim que o classificador voltar; reconciliar antes de qualquer PR não-draft.

Nota: o fenômeno (erro #2 PEGN) parece **latente/ausente** nessas empresas hoje (rolam empréstimo,
AR minúsculo, zero categoria de antecipação). O erro #1 (endividamento, F1) é o que está VIVO aqui.
Por isso o termômetro **degrada pra empty-state educativo** (§3) — que já tem valor: ensina o
founder o que vigiar, e ACENDE no instante em que ele cadastrar a 1ª linha de antecipação.

## 2. Modelo de dados

**Nenhuma tabela nova** (na Tese C). Reusa `fin_dividas` do F1 filtrada a
`tipo='antecipacao_recorrente' AND ativo`. Denominadores confiáveis:
- **recebíveis**: `fin_contas_receber` (AR em aberto, mesmo conjunto de status do NCG/cashflow).
- **receita**: `fin_dre_snapshots` (mesmo snapshot do F3). Bruta vs líquida / período → §3, pendente Codex.

Dependência de trend (evolução mês-a-mês) exigiria snapshot histórico das linhas — **v2**, não v1
(as linhas do F1 têm `saldo_devedor_data_base` pontual, não série temporal).

## 3. Indicadores (helper puro `antecipacao-helpers.ts`, vitest)

**Métrica PRIMÁRIA = dreno de margem** (o núcleo do erro #2 PEGN; imune à base do AR):
- **custo_recorrente_aa** = Σ (`saldo_devedor_informado` × `cet_aa`) das linhas ativas — deságio
  anualizado estimado. `null` (motivo `sem_cet`) se QUALQUER linha material não tem cet — NUNCA 0
  (0 fingiria "antecipação de graça"). Estimativa modelada, rotulada como tal (não é o realizado —
  o realizado não existe no Omie, §0).
- **custo_sobre_receita_pct** = custo_recorrente_aa ÷ **receita bruta TTM** (soma dos últimos 12
  snapshots DRE — mesma base run-rate do F3, robusta a mês ruim). `null` (motivo `sem_receita`) se
  faltam snapshots. É este ratio que dá o **nível do termômetro** (baixa/média/alta).

**Métrica SECUNDÁRIA = dependência de volume** (com caveat honesto):
- **dependencia_pct** ≈ antecipado_total ÷ AR_aberto, onde antecipado_total = Σ
  `saldo_devedor_informado`. ⚠️ **Armadilha money-path resolvida:** o título antecipado CONTINUA
  em `fin_contas_receber` (F1: antecipação é "líquida nos recebíveis") → o AR já inclui o antecipado
  → o ratio = "fração dos recebíveis já penhorada ao banco" (coerente). MAS `saldo_devedor` pode ter
  sido cadastrado como valor SACADO (líquido) em vez de face → base divergente. Por isso é
  **secundária e rotulada "≈"**, com cap em 100% e sem definir o nível sozinha. A definição do input
  ("saldo = face dos títulos ainda descontados") vai no tooltip do F1.
- **concentração por credor** (share do maior) + **coobrigação_total** (Σ saldo das linhas com
  `coobrigada_por` — exposição contingente cross-CNPJ).

**Degradação (precedência):** `sem_linhas` (0 linhas ativas → empty-state EDUCATIVO, não é erro) →
senão `ok`, com cada métrica degradando isolada a `null`+motivo (`sem_cet` / `sem_receita` /
`sem_ar`). Nível `null` (motivo `sem_base`) só se custo/receita **e** dependência forem ambos
indefiníveis. **NUNCA finge número.**

## 4. Motivos de degradação — PENDENTE CODEX

`ok` · `sem_linhas` (empty educativo) · `sem_cet` (custo indefinido) · `sem_ar` (dependência
indefinida) · `sem_receita` (custo/receita indefinido). Precedência a definir com Codex.

## 5. UI — PENDENTE CODEX

Card "Termômetro de antecipação" na view de Endividamento (F1), master-only (o dado é master-only).
Mostra os ratios OU o empty-state educativo OU a degradação honesta. Disclosure de coobrigação.

## 6. Provas (plano)

- vitest do helper puro (ratios + todos os motivos + a não-fabricação).
- Sem migration nova (Tese C) → sem prove-sql. (Se um snapshot histórico entrar em v2, aí sim.)

## 7. Dependências e coordenação multi-sessão (achado do Explore 2026-07-05)

- **A UI do F1 NÃO está no main.** A página `FinanceiroEndividamento.tsx` + o hook
  `useEndividamento.ts` vivem em **outra worktree ativa** (`strange-ramanujan-e9ea43`), ainda não
  mergeada. Só o helper/types/migration do F1 estão nesta árvore. Consequências:
  1. **O card do F4 não tem onde morar** — a view de Endividamento (onde ele entraria) só existe
     naquela worktree. Construir o card aqui, mirando aquela página, **colidiria** com o trabalho
     dela (área QUENTE — CLAUDE.md §Multi-sessão: coordenar antes de tocar).
  2. **Sequenciamento correto:** o **helper + testes + spec do F4 fecham agora** (independentes); o
     **card fica 🚧 BLOQUEADO até a UI do F1 mergear** no main. Aí o card entra — ou nesta árvore
     (rebased) ou coordenado DENTRO da worktree do F1.
  3. **Prod:** mesmo depois do código, o card só ACENDE após o founder aplicar a migration
     `fin_dividas` (F1) no SQL Editor. Sem novidade nos deploys pendentes.
- **Data-layer do F4:** reusar `useEndividamento(company)` (quando existir) filtrando
  `tipo='antecipacao_recorrente'` — **não** duplicar a query de `fin_dividas` (DRY; evita divergência
  com o F1). O hook do F4 só acrescenta AR (fin_contas_receber) + receita TTM (fin_dre_snapshots).

## 8. Veredito Codex (2026-07-05, xhigh — REVISÃO INDEPENDENTE FEITA)

Veredito arquivado em `docs/superpowers/specs/.f4-codex-verdict.md` (o trace xhigh de 1MB fica no
scratchpad da sessão). Adjudicação:

1. **Tese A (kill-switch p/ auto-detecção): CONCORDO, correção de frase.** Não "o Omie nunca
   registra", e sim **"este pipeline Omie/Supabase não traz sinal distinguível/auditável de
   antecipação bancária vs adiantamento de cliente"**. Confirmou nas APIs oficiais do Omie:
   `tipo_documento`/`origem`/`desconto`/`observação` existem mas **não** são flag auditável de
   cessão; "antecipar" no Contas a Receber = antecipar VENCIMENTO, não financiar recebível. Achado
   extra: **`fin_movimentacoes.metadata` é nulificado no sync** (`omie-financeiro/index.ts:1051`) —
   nem o payload bruto sobrevive. 3 checks finais rodados (colunas text/jsonb; entradas sem título;
   tipo_documento) → **sem sinal**; entradas bancárias residuais são **saques de empréstimo**
   (categoria 1.04.03), confirmando captação por dívida, não desconto de duplicata. **Ata fechada.**
2. **Tese B (fonte = input humano F1): CONCORDO.**
3. **Tese C (card fino): RESSALVA → ADIAR.** Card fino é o destino certo, mas **não construir agora**
   como F4 ativa sem linhas manuais. **Crava: adiar F4 como frente, ir pro F5, deixar no F1 só uma
   seção condicional + empty-state barato + CTA. Sem módulo, sem detector, sem ratio visível sem base.**
4. **Ratios: RESSALVA forte (acatada no helper).** NÃO "dependência/fração antecipada" → **"exposição
   sacada ÷ AR aberto"**. Custo ÷ **receita LÍQUIDA TTM** (competência; rotular se caixa). Sem clamp;
   >100% é alerta de base misturada. Ratio verdadeiro exigiria input `valor_bruto_recebiveis_cedidos`
   + flag `ar_inclui_cedidos` (v2). Sem receita → custo absoluto + "receita insuficiente", nunca chute.
5. **Quarta via (melhor agora): guardrail, não tela.** F1 empty-state condicional; **alerta no
   Funding quando `estrutural` disparar** ("padrão de rolagem por antecipação"); **flag de data-health**
   se aparecer categoria factoring/FIDC/deságio/duplicata no futuro (não auto-classificar); F2/preço
   pode receber custo de funding como SIMULAÇÃO, não dependência real.

## 9. DECISÃO FINAL (me + Codex) — F4 adiado como frente

- **F4 como módulo/termômetro: ADIADO** (grounding + Codex: superfície especulativa p/ fenômeno
  ausente nessas empresas — elas captam por empréstimo, coberto pelo F1).
- **Entregue e parkado nesta investigação:** o **grounding/kill-switch** (§0, ata Codex-fechada), o
  **helper puro `antecipacao-helpers.ts` + 16 testes** (semântica já corrigida p/ Codex: exposição
  sacada ÷ AR, receita líquida TTM) — reference impl pronta pra quando/se a 1ª linha for cadastrada.
- **Residual mínimo (follow-up barato do F1, não uma frente):** seção condicional
  `antecipacao_recorrente` na página de Endividamento — cumpre a decisão #5 do próprio F1. Fica
  gated até haver linhas cadastradas. NÃO é um card métrico proeminente.
- **Guardrail (quando tocar o Funding):** alerta no `estrutural` + flag de data-health p/ categorias
  de cessão futuras. Deferred junto.
- **Próxima frente: F5** (painel de exposição por cliente) — o dado suporta.
