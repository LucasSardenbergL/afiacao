# Regimes tributários — o que a skill pode e o que vai pro contador

⚠️ **Releia o guardrail 1 do SKILL.md.** Esta skill **não apura imposto**. Tudo aqui serve
pra (a) ler a *carga tributária observada* do DRE, (b) comparar com a faixa *esperada* do
regime e sinalizar quando algo destoa, e (c) rodar *simulações conservadoras* claramente
rotuladas. Número de imposto a pagar = contador.

## O que está no banco vs no front
- **Não há tabela de regime por empresa.** O regime vive em `COMPANIES[co].regime`
  (`src/contexts/CompanyContext.tsx`): `colacor` e `oben` = `presumido`, `colacor_sc` = `simples`.
- `useFinanceiroRegime.ts` / `RegimeToggle.tsx` **não têm a ver com tributos** — alternam só o
  regime *contábil do DRE* (`'caixa'|'competencia'`). Não confunda.
- `FinanceiroTributario.tsx` calcula tudo **no front, hardcoded** (faixas SN, alíquotas LP).
  `fin_kpi_tributario` provavelmente está vazia. Logo: a fonte confiável de carga é o DRE
  (`fin_dre_snapshots.impostos` / `receita_bruta`), não a tabela tributária.

## Carga tributária observada (o que a skill calcula)
```
alíquota efetiva observada = impostos do DRE ÷ receita_bruta do DRE   (por empresa, por período)
```
Isso é um **termômetro gerencial**, não apuração. Use pra responder "a mordida do imposto
está dentro do esperado pro meu regime?". Divergência grande entre o observado e a faixa
esperada (abaixo) = **pergunta pro contador**, nunca uma conclusão de que "está errado".

## Lucro Presumido — Colacor (indústria) e Oben (distribuidora)
Parâmetros de referência (LP, regra geral — **confirme com o contador**, há exceções por
produto, ST, monofásico, benefícios estaduais):
- **Presunção de base** (sobre receita): comércio/indústria ~**8%** pra IRPJ e ~**12%** pra CSLL;
  serviços ~**32%**. Como Colacor é indústria e Oben é distribuidora, a presunção típica é a de
  comércio/indústria — mas produtos/serviços mistos mudam isso.
- **IRPJ** 15% sobre a base presumida + adicional 10% sobre o que exceder R$ 20.000/mês de base.
- **CSLL** 9% sobre a base presumida.
- **PIS** 0,65% e **COFINS** 3,0% sobre o faturamento (regime cumulativo do LP).
- **ICMS** (estadual) e eventuais **IPI** (indústria): variam muito por NCM, ST, origem/destino.
  A skill **não** estima ICMS/IPI item a item — isso é do contador/fiscal.
- Carga efetiva total típica de LP costuma cair numa faixa ampla (≈ 11% a 16%+ da receita,
  muito dependente de ICMS). Use como ordem de grandeza, não como meta.

> Para Colacor (indústria) atenção ao **IPI** e ao **ICMS-ST**; para Oben (distribuidora)
> atenção a **ST** e **monofásico** (PIS/COFINS podem estar zerados em revenda de certos itens).
> Ambos são motivo de pergunta pro contador, não de cálculo automático.

## Simples Nacional — Colacor SC (serviços)
- Tributação por **faixa do RBT12** (receita bruta dos últimos 12 meses) e por **Anexo**.
  Serviços podem cair no Anexo III ou V dependendo do **Fator R** (folha ÷ receita 12m ≥ 28%
  → Anexo III, mais barato). **Enquadramento de anexo e Fator R: sempre confirmar com contador.**
- A skill calcula o **RBT12** (Σ `receita_bruta` dos últimos 12 meses no DRE) pra situar a
  faixa, e sinaliza **proximidade do teto de R$ 4,8 milhões/ano** (desenquadramento).
- **Não** declare a alíquota nominal da faixa como "o imposto" — a alíquota *efetiva* do SN
  desconta a parcela a deduzir da tabela. Use a efetiva observada do DRE e deixe a apuração
  (DAS) pro contador.

## Simulações conservadoras — o que é permitido
Permitido (sempre rotular **"simulação conservadora — confirmar com contador"**):
- "Se o faturamento da Colacor SC crescer X%, ela se aproxima do teto do Simples / muda de faixa?"
- "Mantida a alíquota efetiva observada, quanto de imposto sai sobre a receita projetada?"
- "Sensibilidade: +10% de receita ⇒ +R$ Y de carga, mantida a proporção atual."

**Proibido** (guardrail 3 — não faça, redirecione pra pergunta ao contador):
- Recomendar troca de regime pra pagar menos.
- Sugerir abrir/fechar CNPJ, segregar atividades, ou distribuir receita entre as empresas pra
  reduzir tributo.
- Otimização de Fator R "forçando" folha, ou qualquer estrutura cujo único objetivo é fiscal.
- Tratamento de ST/monofásico/benefício fiscal sem confirmação contábil.

## Como sinalizar no relatório
Para cada empresa, no bloco tributário:
1. Alíquota efetiva observada (DRE) — com a ressalva de que é observada, não apurada.
2. Faixa esperada do regime (acima) — ordem de grandeza.
3. Se observado ≪ ou ≫ esperado: **bandeira amarela + pergunta pro contador**.
4. Colacor SC: faixa do RBT12 + distância do teto de R$ 4,8 mi.
5. Lembrete de itens não cobertos (ICMS/IPI/ST/monofásico) que só o contador fecha.
