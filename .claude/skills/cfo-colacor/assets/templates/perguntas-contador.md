# Perguntas pro contador — {MÊS}/{ANO}

> Lista objetiva pro dono levar à contabilidade. Cada item: a pergunta, por que importa, e o
> dado que motivou. Ordene por impacto (R$ ou risco). NÃO traga conclusões fiscais — traga
> perguntas. Gere só itens com lastro nos dados do fechamento; corte os que não se aplicam.

## Como montar
Para cada achado do diagnóstico que toca a fronteira contábil/fiscal, crie um item no
formato abaixo. Fontes típicas de pergunta, por bloco:

- **Categorias sem mapeamento (bloco 5)** → "A categoria Omie `{código} — {nome}` (R$ {valor}
  no mês) entra como CMV, despesa operacional ou outra linha do DRE?"
- **Carga tributária (bloco 7)** → quando a alíquota efetiva observada destoa muito da faixa
  esperada do regime: "A alíquota efetiva da {empresa} foi {x}% — está coerente com {Presumido/Simples}?
  Tem ICMS-ST / IPI / monofásico afetando isso?"
- **Simples / Colacor SC** → "Com RBT12 em R$ {valor} ({pct}% do teto), e Fator R em {…}, o
  enquadramento de anexo segue o melhor pra nós? Há risco de desenquadramento no horizonte?"
- **Intercompany (bloco 8)** → "A operação {origem}→{destino} de R$ {valor} está lançada nas
  duas pontas pelo mesmo valor? A divergência de R$ {diff} é diferença de data ou erro?"
- **DRE caixa vs competência** → "O resultado por competência diverge {x}% do caixa. A
  diferença é timing de recebimento/pagamento ou tem lançamento faltando?"
- **CP sem categoria / conciliação baixa** → "Há R$ {valor} em contas a pagar sem categoria e
  {pct}% de movimentações não conciliadas — como classificar?"

## Modelo de item
```
### {nº}. {pergunta curta}
- **Por quê**: {impacto gerencial — R$, risco, decisão que depende disso}
- **Dado**: {empresa, valor, período, de onde saiu}
- **Categoria**: [classificação DRE | tributário | intercompany | conciliação | regime]
- **Urgência**: [alta | média | baixa]
```

## Lista
{Preencher com os itens reais do fechamento. Se um bloco não gerou pergunta, não invente.}
