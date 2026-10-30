# Replay TSB do estoque de segurança — simulador consertado pela revisão do Codex, rodada oficial pendente (2026-10-29)

**Entrega:** o simulador walk-forward `scripts/reposicao-replay/` (projeto 3; spec `docs/superpowers/specs/2026-10-20-tsb-estoque-seguranca-design.md`, plano `docs/superpowers/plans/2026-10-21-tsb-estoque-seguranca-replay.md`). Ele compara o motor atual (F0) com F1 (gaussiana em 63 du), F2 (TSB com tamanhos empíricos) e F3 (quantil de blocos) na coorte Sayerlack/OBEN fixada em 2026-05-01 (153 SKUs, 141 intermitentes). Janelas: aquecimento até 31/01, calibração de 01/02 a 30/04 e avaliação de 01/05 a 20/10/2026. Banco só lido via `psql-ro`; dados em `$REPLAY_DADOS`, fora do repositório.

**Relatório da rodada de 28/10 (privado, anterior aos consertos e substituído pela rodada oficial pendente):** https://claude.ai/artifact/NwMRPYBcCHdcwnP5BZQ1Ts

## Veredito

**Pendente: a rodada oficial não foi refeita depois dos consertos do Codex.** Os números da rodada de 28/10, inclusive o NO-GO `INVIAVEL_NA_CALIBRACAO`, foram calculados com o código anterior e **não valem mais**. Os consertos mudam a abertura, o LT, a classe da célula, a escolha de embalagem, a valoração do capital e o gate.

A rodada oficial depende de duas coisas fora do código:
- a posição de estoque datada do Omie (`extrair-omie-posicao.ts`, com a credencial OBEN em `~/.config/afiacao/omie-oben.env`), que é a âncora da abertura (R31) e dá o CMC datado (R45);
- uma extração limpa entre o motor do dia e a passada seguinte, por volta de 19:00 a 22:15 em São Paulo (R40).

Sem a âncora, a rodada para com `ANCORA_OMIE_AUSENTE`, e o modo `--informativo-saldo-hoje` sai rotulado NÃO OFICIAL.

**Extração limpa de 29/10, às 21:49 em São Paulo** (o motor rodou às 20:39). Ela está em `$REPLAY_DADOS` (pasta `reposicao-replay-2026-10-29`) e só falta a âncora do Omie para virar a rodada oficial. O gate de paridade reprovou na primeira tentativa, com decisão 14/15, porque o motor sugeriu 8 numa linha que uma pessoa editou para 18 antes do disparo. A **leva E** passou a comparar o gate com a decisão do motor:
- linha editada à mão, sem teto e sem promoção: `qtde_sem_teto`;
- linha em promoção não editada: `qtde_sem_promocao`, porque o `forward_buying` infla `qtde_final` sem marcar ajuste;
- qualquer outro caso: a carga para, em vez de tirar a linha do denominador.

Com a leva E, o gate passa: decisão 15/15 e estado 8/8. A rodada informativa ficou INCONCLUSIVA porque, sem o Omie, falta o CMC datado (`CAPITAL_NAO_VALORADO_NA_CALIBRACAO`).

Atenção: `ajustado_humano` também marca linhas em que só o preço foi editado. Numa linha com teto, isso para a carga.

## Revisão adversarial do Codex (3 consultas de código)

1. **REPROVA, 14 P1.** O founder mandou consertar os 14. Os rulings R2, R7, R9, R10, R22 e o piso 0 da R24 foram revogados onde contrariavam a §5.9.
2. **REPROVA.** 6 dos 14 fechados, 8 parciais e 7 P1 novos introduzidos pelos consertos.
3. **REPROVA, a última consulta por decisão do founder.** Tudo fechado, exceto três P1, que ficam como **pendência**:
   - **N1:** um pedido encerrado no Omie abaixo de 95% do recebido ainda fecha, e a quantidade pedida vem do `raw_data` atual;
   - **N3:** a data do pedido (`t1`) é usada como data de existência da cópia na consolidação point-in-time;
   - **N5:** valor gravado ausente reduz o denominador do gate em vez de bloquear.

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
