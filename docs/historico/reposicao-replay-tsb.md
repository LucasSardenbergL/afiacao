# Replay TSB do estoque de segurança — rodada oficial: NO-GO na calibração, paridade do F0 passando (2026-11-09)

**Entrega:** o simulador walk-forward `scripts/reposicao-replay/` (projeto 3; spec `docs/superpowers/specs/2026-10-20-tsb-estoque-seguranca-design.md`, plano `docs/superpowers/plans/2026-10-21-tsb-estoque-seguranca-replay.md`). Ele compara o motor atual (F0) com F1 (gaussiana em 63 du), F2 (TSB com tamanhos empíricos) e F3 (quantil de blocos) na coorte Sayerlack/OBEN fixada em 2026-05-01 (153 SKUs, 141 intermitentes). Janelas: aquecimento até 31/01, calibração de 01/02 a 30/04 e avaliação de 01/05 a 20/10/2026. Banco só lido via `psql-ro`; dados em `$REPLAY_DADOS`, fora do repositório.

**Relatório da rodada oficial (privado, v4, com os valores em R$):** https://claude.ai/artifact/NwMRPYBcCHdcwnP5BZQ1Ts

## Veredito

**NO-GO oficial, `INVIAVEL_NA_CALIBRACAO`** (extração de 09/11/2026, motor das 07:15 SP, âncora na posição datada do Omie; gate de paridade **PASSA**).

- Na calibração, o próprio F0 atende **90,58%** das linhas de A (piso 98%). Os SKUs suaves de A, que ficam no F0 em todas as variantes (spec §5.3), atendem 90,65%; os alterados, 90,49%. Nenhum quantil alcança os suaves, então nenhuma fórmula leva a célula A ao piso: o NO-GO vem da régua, não de uma comparação TSB × F0.
- Melhor fill de A na grade: F2 β 0,02 com 93,94%, usando 49% a mais de estoque que o F0. F3 usa menos estoque (3–7%), mas fica abaixo do F0 em B.
- Estoque sem preço na calibração do F0: **0,00%** (era o que deixava as rodadas de 30/10 e 31/10 INCONCLUSIVAS).
- Paridade: ES, PP e máximo 100% contra a view (n = 118); decisão de compra com o estado gravado 24/24; com o estado do replay 17/18 (o 8689783095 da allowlist R21).

**Rodada informativa (R27, não oficial), só nos intermitentes: NO-GO.** Candidata congelada: F2 β 0,02 (quantis 0,999 / 0,999 / 0,95). Serviço sobe em todas as classes (espera: A +5,50 p.p. [LI +2,46], B +5,53 [+4,12], C +1,52 [+0,12]; pisos e não inferioridade passam), mas o estoque sobe 87% (redução −87,25% [LI −89,00%]), o estresse de LT dobra o estoque e a economia a 25% a.a. falha em 9/9 células de espera. DIO 48 → 90 dias. Critérios: 40 passam · 15 falham · 24 incertos.

**Leitura:** o gargalo de serviço em A é o F0 nos suaves e a defasagem da média de 90 dias quando a demanda sobe (fev → abr: 1,55×), não a fórmula dos intermitentes. Nos intermitentes o TSB compra serviço com capital, e a taxa de 25% a.a. não paga isso.

### Leva F (30/10 → 09/11): o que destravou a rodada oficial

- **Causa 1 (cmc_linha):** o cmc da linha passou a ser buscado pelo código original do item (`venda_items_history`).
- **R53 (founder, 31/10) — existência:** SKU sem saldo na abertura só existe a partir do 1º evento real, recebimento físico ou venda (o histórico de recebimentos começa em 28/01/26, então a venda também é evidência); antes disso não decide, não é comprado e não tem estoque. Tirou as compras simuladas antecipadas de SKU novo.
- **R54 (founder, 31/10) — preço de compra no capital:** vale pelas cópias do documento que já chegaram (t4 < d); cópia criada e ainda não chegada não anula. A paridade do motor segue com a regra da view (N3/R51). Fechou o último SKU com 14 dias de estoque sem preço.
- **R55 (founder, 09/11) — gate:** a leitura "decisão com o gravado" usa também a demanda gravada no teto de cobertura (`demanda_media_diaria`, com insumo). O motor comprou 25 de um SKU com 99% de demanda via ficha técnica; com a demanda simulada (sem insumo) o teto cortava para 20 e o gate dava 23/24.
- **Extração só em dia útil:** a de domingo (08/11) parou em `DATA_DECISAO_SEM_PARAMETRO`; a data da decisão é o dia da extração.
- **Suspensão de compra (main, 01/11):** 68 SKUs Sayerlack suspensos; a linha suspensa não entra em `sugestao_hoje`, então só sai do denominador do gate.
- **Revisão independente da R53** (4 achados): âncora tardia travando o grupo e 1ª chegada que é compra aberta no início não ocorrem nos dados; `skusSemCmc` conta dias sem estoque (cosmético); existência difere entre cenários só no modo saldo_hoje. Declarados, não corrigidos.

## Revisão adversarial do Codex (3 consultas de código)

1. **REPROVA, 14 P1.** O founder mandou consertar os 14. Os rulings R2, R7, R9, R10, R22 e o piso 0 da R24 foram revogados onde contrariavam a §5.9.
2. **REPROVA.** 6 dos 14 fechados, 8 parciais e 7 P1 novos introduzidos pelos consertos.
3. **REPROVA, a última consulta por decisão do founder.** Tudo fechado, exceto três P1, que o founder declarou como **limitação** em 09/11 ("limitação, merge"), sem conserto:
   - **N1:** um pedido encerrado no Omie abaixo de 95% do recebido ainda fecha, e a quantidade pedida vem do `raw_data` atual. Efeito: poucos documentos de LT entram na amostra como fechados, igual para o F0 e as fórmulas. Não muda o NO-GO, que vem do fill do F0 nos suaves de A (90,65% contra piso de 98%), longe de qualquer variação de LT desse tamanho;
   - **N3:** a data do pedido (`t1`) é usada como data de existência da cópia na consolidação point-in-time. Efeito medido em 28/10: diverge da leitura literal em 1 trecho de 1 SKU. Não muda o NO-GO;
   - **N5:** valor gravado ausente reduz o denominador do gate em vez de bloquear. Efeito: 13 donos sem ES/PP/máximo gravado ficam fora do denominador do estado (168 comparados). O gate não decide o veredito, que sai da calibração; não muda o NO-GO.

## O que vale levar adiante

- **Paridade do F0 com a produção depois dos consertos** (dado composto de 28/10, declarado):
  - ES 100%, PP 99,16% e máximo 99,16%;
  - decisão 14/14;
  - parâmetros conferidos para os 181 donos.

  Isso depende de dois pontos:
  - a data da extração em São Paulo, já que a extração noturna em UTC simulava uma passada que ainda não tinha rodado (R40);
  - a janela da demanda igual à da view, de hoje−90 até hoje (R41).

  O máximo contra o valor gravado ficou em 95,18%, a 1 SKU do limiar.
- **O LT do F0 replica `v_sku_leadtime_efetivo` point-in-time (R43, R51).** A amostra do replay só coincide com a de produção (949 observações) se o replay anular os documentos em que alguma cópia não tem t4, como faz a view.
- **Entradas da mesma NF:** cópias com a mesma quantidade sob `tracking_id` distintos são uma entrada física só (R52). Contá-las em separado inflava em 6,7% as unidades recebidas.
- **Correção da leitura (diagnóstico de 09/11, revisado pelo Codex; spec [F0 dos suaves](../superpowers/specs/2026-11-09-f0-suaves-atendimento-a-design.md)):** nos suaves de A, a defasagem da média de 90 dias é o MENOR componente (1,67 p.p., e só como oráculo retrospectivo). O maior é a taxa média em dia corrido multiplicada pelo LT em dia útil (3,46 p.p.; a taxa fica 28,6% abaixo). O LT acima do parâmetro dá 2,31 p.p. Mexer só nos suaves leva a célula A a no máximo 95,75%, e o pacote de +74% de estoque tem benefício líquido negativo no ponto.
- **Achado de produto:** o motor ainda sugere compra de SKU já substituído (11892839175 → 12101724100, consolidado em 05/07), com parâmetros congelados.
- **Duplicatas em `sku_leadtime_history`:** a produção já deduplica (`v_sku_leadtime_efetivo`). A nota está em [reposicao.md](../agent/reposicao.md).

## Método (rulings no ledger da sessão; os que mudam a leitura)

- **Revogados pela revisão do Codex:**
  - R2 (classe da célula fixa; passa a ser a classe do dia);
  - R7 (corte de 29 du e fechamento por qualquer t4);
  - R9 (dedup por (sku, t4, qtd));
  - R10 (âncora no saldo de hoje);
  - R22 (galão fora da simulação);
  - o piso 0 da margem na R24.
- **R31 e R45:** a abertura é a posição Omie medida, sem ajuste. O capital é valorado por dia: cmc_linha anterior, depois nCMC Omie datado, depois preco_compra_real, depois null. Sem preço, o resultado é INCONCLUSIVO.
- **R46 e R47:** linhas sem a quantidade do pedido saem do sorteio de LT, com sensibilidade, por decisão do founder. O encerramento no Omie só vale a partir da sua data.
- **R16:** os SKUs com demanda via ficha técnica saem da coorte.
- **R25:** o capital é exigido nos três cenários de falta.
- **R26:** o gate de economia usa só 25% a.a.; 20% e 30% ficam como sensibilidade.
- **R50:** capital null nunca vira INVIAVEL.

## Validação

- Suíte `scripts/reposicao-replay`, typecheck, lint, knip e lint:shell com rc=0.
- Falsificação por camada em cada task, com controle verde na mesma invocação.
- Revisão de spec e qualidade por task, com fix rounds.
- Codex adversarial do código: 3 consultas, ver acima e o corpo do PR.
