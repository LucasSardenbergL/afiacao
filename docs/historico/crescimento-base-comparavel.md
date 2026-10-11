# Crescimento na base comparável: o "same store" por cliente no Master

**2026-10-10.** Card novo no dashboard Master: separa a variação da receita dos 3 últimos meses fechados em
base comparável (cliente com pedido nos dois períodos), entraram e saíram, contra o mesmo trimestre do ano
anterior ou os 3 meses antes. Spec: `docs/superpowers/specs/2026-10-10-crescimento-base-comparavel-design.md`.

## Por que valeu construir (medido antes de codar)

O número de cima contava a história errada nos dois sentidos. Colacor set/ago: −11% no total com a base em
+0,6% (giro de avulso). Colacor jul–set vs abr–jun: −22% no total com a base em **−29%** (é a base que
encolhe). Na janela mensal a base comparável da Colacor era 24 clientes (28% da receita) — por isso a janela é
trimestral (79–93% da receita).

## O achado que mudou o desenho

O P1 do Codex ("mês fechado não é dado congelado; valide a cobertura") foi medido contra o DRE por competência:
os pedidos do app cobriam **36–67%** da receita contábil da Colacor em jul–set/25 e **90–115%** desde out/25
(Oben fica acima de 100% e oscila). Comparar essas janelas mede o sync, não o negócio: cliente que em 2025 só
comprou por pedido não sincronizado vira "entrou" em 2026. Daí a régua: coberturas das duas janelas a até
**1,2×** por empresa, senão a comparação é suprimida com o motivo. Na prod, ela bloqueia exatamente o YoY da
Colacor (0,49 vs 0,91 = 1,86×) e deixa os outros três cortes (1,08–1,12×).

## Lições

- **Decomposição antes de construção:** a query de 30 linhas que mostrou o −29% escondido justificou o card; a
  mesma query, refeita pelo helper sobre as linhas reais, foi a reconciliação final (bateu nas 4 combinações e
  nas contagens). A identidade da ponte prova a álgebra, não que o pedido certo entrou na janela certa.
- **O banner "Dados de venda parciais" do Master** afirma cobertura parcial; a medição mostra 90–155% desde
  out/25. Ele pode estar velho — candidato a virar condicional sobre a cobertura medida (fora deste PR).
- **Teste cujo nome contradiz a asserção é defeito no código, não no teste:** "cobertura 0 é sinal, não
  ausência" esperava "não verificada" — a regra tratava sync que perdeu a janela inteira como dúvida, e a
  ponte mostraria todo cliente como "saiu". Virou "incomparável".
