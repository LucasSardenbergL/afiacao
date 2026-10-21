# Replay TSB do estoque de segurança — NO-GO pela régua, e o que ele ensinou (2026-10-21)

**Entrega:** o simulador walk-forward `scripts/reposicao-replay/` (projeto 3; spec `docs/superpowers/specs/2026-10-20-tsb-estoque-seguranca-design.md`, plano `docs/superpowers/plans/2026-10-21-tsb-estoque-seguranca-replay.md`). Ele compara o motor atual (F0) com F1 (gaussiana em 63 du), F2 (TSB com tamanhos empíricos) e F3 (quantil de blocos) na coorte Sayerlack/OBEN fixada em 2026-05-01 (153 SKUs, 141 intermitentes). Janelas: aquecimento até 31/01, calibração de 01/02 a 30/04 e avaliação de 01/05 a 20/10/2026. Banco só lido via `psql-ro`; dados em `$REPLAY_DADOS`, fora do repositório.

**Relatório completo (privado, com valores absolutos):** https://claude.ai/artifact/NwMRPYBcCHdcwnP5BZQ1Ts

## Veredito

- **Oficial: NO-GO `INVIAVEL_NA_CALIBRACAO`.** O próprio F0 atende 93,49% das linhas de A na calibração, abaixo do piso de 98%. Os 13 SKUs suaves de A ficam no F0 em todas as variantes (§5.3) e atendem 92,49%. Como o piso e o alvo são medidos na célula da classe inteira, nenhum quantil chega lá: com quantil 0,999, a F1 vai a 95,36% e a F2 a 95,5%. A régua não foi afrouxada.
- **Informativo, não oficial (R27, decisão do Lucas): NO-GO.** Calibrando e avaliando só nos intermitentes, a candidata é a F1 (quantis 0,995 / 0,97 / 0,925):
  - A sobe +3,01 p.p. (LI +1,94) e B +1,43 p.p.; C fica em −0,81 p.p., INCERTO.
  - O capital piora 15,2% (LI −17,4%, LS −12,9%), FALHA nos três cenários de falta.
  - A economia a 25% a.a. é negativa em espera, positiva em cancelamento e incerta no misto.
  - Leitura: nos intermitentes, a F1 compra serviço com capital, e a taxa não paga a troca.

## O que vale levar adiante

- **O gargalo de serviço em A é o F0 nos suaves e a defasagem da média de 90 dias.** O fill semanal de A no F0 cai de cerca de 97% para 79–93% em abril, quando a demanda de A sobe 1,27× em março e 1,56× em abril sobre fevereiro. O LT sorteado médio nos pedidos de A, 11,1 du, também fica acima dos 9,2 du do parâmetro.
- **A operação real compra acima do motor:** estoque médio real ≈ 1,80× o do F0 simulado, e unidades recebidas ≈ 1,72×. Como a paridade de ES/PP/máximo passa, o F0 simulado é o motor ao pé da letra; a diferença está em quem compra.
- **Paridade do F0 com a produção (R19 e R21):** ES 100%, PP 97,5%, máximo 96,7% (0,76% do valor) contra a view. A decisão de compra bate em 8/8 com o PP e o máximo gravados. O único 7/8 de estado é uma edição humana fora da fórmula.
- **Duplicatas em `sku_leadtime_history`:** a produção já deduplica (`v_sku_leadtime_efetivo`), então não houve chip. A nota está em [reposicao.md](../agent/reposicao.md).

## Método (rulings no ledger da sessão; os que mudam a leitura)

- **R7, R9, R17:** LT por documento único (sku, t4, qtd), sem o t1 "fabricado" (t1 = t2), que a produção anula.
- **R16:** os SKUs com demanda via ficha técnica saem da coorte.
- **R24:** numa cancelada sem CMC, a margem entra no pior caso para a alternativa (0% das linhas nesta rodada).
- **R25:** o capital é exigido nos três cenários de falta.
- **R26:** o gate de economia usa só 25% a.a.; 20% e 30% são sensibilidade.
- **R23:** o LT sai levemente otimista no fim da calibração (censura à direita), igual nos dois braços.

## Validação

- Suíte `scripts/reposicao-replay`, typecheck, lint, knip e lint:shell com rc=0.
- Falsificação por camada em cada task, com controle verde na mesma invocação.
- Revisão de spec e qualidade por task, com fix rounds.
- O Codex adversarial do código não rodou: a cota estava em 99% (exit 79). O PR fica DRAFT até a janela reabrir (`money-path.md`).
