# Perguntas pro contador — Abril/2026 — Grupo Colacor

> Lista objetiva pra levar à contabilidade. Cada item: a pergunta, por que importa e o dado
> que motivou. Ordenada por impacto. **São perguntas, não conclusões fiscais.** Gerada pela
> skill `cfo-colacor` a partir do fechamento de abril/2026 (read-only).

## Lista

### 1. Como classificar os impostos no DRE?
- **Por quê**: hoje o DRE mostra **impostos = R$ 0** porque essas categorias não têm linha de
  DRE — distorce resultado e carga tributária do grupo inteiro. É a ação nº1 do mês.
- **Dado**: códigos `2.06.*` (ICMS, IRPJ, CSLL, COFINS, PIS, ICMS DIFAL, Simples DAS,
  parcelamento). Abril: **Oben ~R$ 69.289 · Colacor ~R$ 27.405 · Colacor SC ~R$ 1.613**.
- **Categoria**: classificação DRE / tributário
- **Urgência**: alta

### 2. "Pagamento de Empréstimos" — principal, juros, externo ou intercompany?
- **Por quê**: é o maior item de saída do mês. Se for amortização de principal, **não vai ao
  DRE** (reduz passivo); se tiver juros, os **juros vão pra despesas financeiras**. E precisamos
  saber se é banco externo ou mútuo entre as empresas do grupo.
- **Dado**: código `2.05.03`. Abril: **Oben R$ 81.643 · Colacor R$ 19.965 · Colacor SC R$ 20.000**.
- **Categoria**: classificação DRE / intercompany
- **Urgência**: alta

### 3. As contas Itaú negativas são cheque especial? Qual limite e taxa?
- **Por quê**: define o **runway real** e quanto de **juros** está sangrando o caixa (juros que
  hoje não aparecem no DRE).
- **Dado**: saldo Itaú em 2026-06-16 — **Colacor −R$ 395.718,97 · Colacor SC −R$ 152.377,35**.
- **Categoria**: classificação DRE / caixa
- **Urgência**: alta

### 4. Por que a receita do DRE é metade do caixa? Vendas à vista entram como receita?
- **Por quê**: se a receita está subestimada, o resultado e a margem estão errados pra baixo.
- **Dado**: Colacor — receita DRE (competência) **R$ 68.194** vs entrada de caixa do mês ~**R$ 145
  mil**. Há categoria de receita (`1.03.01` na Oben) possivelmente não mapeada.
- **Categoria**: classificação DRE
- **Urgência**: alta

### 5. O "Parcelamento de Impostos Federais" é dívida tributária antiga? Quanto falta?
- **Por quê**: infla a carga tributária aparente do mês (é passado, não imposto corrente) e é um
  passivo relevante a acompanhar.
- **Dado**: abril — **Oben R$ 14.301,53 · Colacor R$ 2.942,34**.
- **Categoria**: tributário
- **Urgência**: média

### 6. As devoluções entram como dedução da receita bruta?
- **Por quê**: classificação correta da receita líquida.
- **Dado**: Oben — "Devoluções de Vendas" R$ 5.010 + "Devolução de Clientes" R$ 750 (`2.09.01`,
  `2.01.98`).
- **Categoria**: classificação DRE
- **Urgência**: média

### 7. A alíquota observada da Oben (~23,6%) é coerente com Lucro Presumido?
- **Por quê**: a faixa esperada do Presumido é ~11–16%; 23,6% destoa. Pode ser ICMS-ST / DIFAL
  interestadual (típico de distribuidora) + parcelamento embutido — ou sinal de algo a revisar.
- **Dado**: Oben — impostos ~R$ 69.289 sobre receita ~R$ 293.149 (abril). Inclui DIFAL R$ 6.949.
- **Categoria**: tributário / regime
- **Urgência**: média

### 8. Os títulos fósseis da Colacor devem ser provisionados/baixados?
- **Por quê**: R$ 78 mil de recebíveis com até ~12 anos de atraso inflam o ativo e a inadimplência
  e não serão recuperados.
- **Dado**: Colacor — R$ 78.486 em D+90 (máx. 4.548 dias), de R$ 83.902 vencidos.
- **Categoria**: classificação DRE / conciliação
- **Urgência**: média

### 9. O que é a categoria vazia da Colacor (R$ 27.937, 5 títulos)?
- **Por quê**: valor relevante sem classificação nenhuma — não dá pra fechar o DRE sem saber o que é.
- **Dado**: Colacor — 5 títulos com `categoria_codigo` em branco, R$ 27.937,83 (abril).
- **Categoria**: classificação DRE / conciliação
- **Urgência**: média

### 10. Título da Oben com emissão futura (25/07/2026) — erro ou faturamento programado?
- **Por quê**: emissão à frente da data atual pode ser erro de lançamento que distorce competência.
- **Dado**: Oben — título mais recente com `data_emissao = 2026-07-25` (hoje é 2026-06-16).
- **Categoria**: conciliação
- **Urgência**: baixa

### 11. Vale operacionalizar fechamento formal mensal + orçamento 2026?
- **Por quê**: hoje nenhum mês foi fechado formalmente e não há orçamento — sem isso não há régua
  de orçado-vs-realizado nem trava de reabertura.
- **Dado**: `fin_fechamentos`, `fin_orcamento`, `fin_forecast` todas com 0 linhas.
- **Categoria**: processo
- **Urgência**: média
