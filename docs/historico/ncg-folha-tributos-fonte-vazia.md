# NCG: folha e tributos 0 afirmados — fonte vazia (engine v2.6)

**Incidente (25/11/2026):** o 1º snapshot medido da `fin-cashflow-engine` v2.5 (10:00–10:10 UTC, 3 empresas × 3 cenários) gravou `ncg_folha_30d = 0` e `ncg_tributos_a_pagar = 0` em `fin_projecao_snapshots`. Não era NULL: era um zero afirmado. O card "Como a NCG se forma" (PR #4170) mostrou isso fielmente.

## Causa raiz (psql-ro, só contagens)

| Fonte que `calcularNCG` lê | Estado nas 3 empresas |
|---|---|
| tributos = CP aberto com `categoria_codigo LIKE '3.99%'` | **0 linhas** (o prefixo não existe no plano Omie do grupo) |
| folha = `fin_eventos_recorrentes` (`is_folha`) | **0 linhas** |
| folha = CP de `fin_config_cashflow.folha_categorias_codigos` na janela de 30 d | **config vazia** |

O plano real (`fin_categorias`, igual nas 3) tem **2.03 Despesas com Pessoal** e **2.06 Impostos e Taxas**, com títulos abertos: 2.06 nas 3 empresas e 2.03 sobretudo na colacor_sc, onde vive a folha do grupo. Esses títulos caíam em `cp_fornecedor`. O **total** da NCG estava certo; a **composição** é que estava errada, com o 0 nascendo de um filtro que nunca casa. É o `Number(null) === 0` em forma de filtro.

## O que a v2.6 faz (só medida)

`NCG.fontes = { folha, tributos }`: a parcela só é medida se a regra achar obrigação **aberta** (ou, na folha, um recorrente). Histórico pago não atesta a janela (achado Codex). Fonte vazia → `colunasComposicaoNcg` grava as **6** `ncg_*` NULL, porque o CHECK `fin_projecao_snapshots_ncg_composicao_coerencia_ck` não aceita só a parcela NULL. `ncg`, PCO, semanas, saldos e `saldo_tesouraria` ficam **idênticos** à v2.5. Efeito esperado em prod: a composição das 3 empresas passa a "não medida" até a fonte ser trocada.

## Desenho descartado: reclassificar por família 2.03/2.06

A v1 deste PR lia tributos de `2.06*` e folha de `2.03*`. O Codex reprovou (5 achados P1):

1. **Dupla contagem:** uma categoria configurada como folha e também em 2.06 entrava duas vezes no PCO.
2. **Histórico como atestado:** um único 2.03 pago "media" folha 0.
3. **Exceções nas famílias:** na colacor, 2.03.76 é distribuição de lucros. 2.06.94 é ICMS-ST de fornecedor e 2.06.98 é licença ambiental. ISS, IPTU e IPVA ficam em 2.04.
4. **Janela sem limite inferior:** folha vencida havia 120 d entrava em `folha_30d`, e o recorrente ignora a vigência (`fim`).
5. **A4:** `saldo_tesouraria` alimenta `financiar_ja` × `financiar_condicional`, e a resposta ao vivo segue com `folha_30d = 0` mesmo quando o snapshot diz "não medido".

## v2.7 — a fonte passa a ser o mapa por empresa + código (26/11)

A pendência abaixo foi resolvida com o founder em 26/11 e com evidência de prod (psql-ro, só contagens). Lógica em `supabase/functions/fin-cashflow-engine/ncg-folha-tributos.ts`. A edge lê `fin_categoria_fluxo_mapping` (linhas `op_pessoal`, `op_impostos`, `op_impostos_lucro`) por `exigirLeitura`, e falha de leitura **lança**.

| Parcela | Regra v2.7 | Por quê |
|---|---|---|
| tributos a pagar | CP aberto de `op_impostos` + `op_impostos_lucro`, sem janela | decisão 1. Parcelamento fica em `cp_fornecedor`, então o total não muda |
| folha 30d | CP aberto de `op_pessoal` com vencimento em [hoje − 30, hoje + 30], mais o recorrente **vigente** (max) | decisão 2. Limite inferior abaixo |
| fonte da folha | colacor_sc: ≥ 1 título na janela ou recorrente. colacor e oben: zero **medido** se o mapa tem código de pessoal | decisão 3: a folha é centralizada |
| fonte dos tributos | ≥ 1 título aberto classificado | regra da v2.6 (histórico pago não atesta) |
| não atesta | título aberto com código de 2.03 (folha) ou 2.04/2.06 (tributos) **ausente** do mapa da empresa, ou folha sem vencimento → parcela não medida + motivo | achados Codex v2.7: o mapa foi semeado com códigos que já tiveram caixa, e o plano tem 22–28 códigos por empresa nessas famílias fora dele (0 com título aberto em 26/11) |

**Limite inferior de 30 dias.** Na colacor_sc foram pagos 393 títulos de folha em 18 meses. O p99 de atraso é 11 d e o máximo 19 d: nenhum foi pago com mais de 30 dias. Título de folha vencido há mais de 30 dias não tem precedente de pagamento. Ele **fica em `cp_fornecedor`** (o total da NCG não muda) e entra como motivo em `confianca_dados.motivos`, com a contagem.

**Os 5 P1 do desenho por família:**

1. Dupla contagem: cada título cai em um balde só (adiantamento > tributo > folha na janela > fornecedor), e o mapa é UNIQUE(company, código). Teste "nada conta duas vezes": PCO = Σ CP aberto não-adiantamento.
2. Histórico pago: tributo continua exigindo título aberto. Na folha, o zero só é afirmado onde ela não é paga (decisão 3).
3. Exceções nas famílias: o mapa é curado (2.03.76, 2.06.94 e 2.06.98 não estão em pessoal/impostos; ISS, IPTU e IPVA 2.04.* estão em `op_impostos`).
4. Janela sem limite inferior: agora há [−30, +30], e o recorrente só conta com **ocorrência** em [hoje, hoje + 30], pela mesma expansão da projeção semanal (`recorrente.ts`).
5. A4: veja os achados abaixo.

**INSS/IRRF retidos não duplicam o salário.** Cada título de CP é um desembolso distinto: a guia é paga à parte do líquido. Em 26/11, na colacor_sc, havia 0 títulos abertos de INSS/IRRF. Na oben havia 2, vencidos há mais de 60 d, que ficam em `cp_fornecedor`.

**Achado para o founder (contagens):** desde 2026-07, os títulos de folha da colacor_sc deixaram de ser baixados no Omie. Antes de 2026-04 havia 0 abertos por mês. Depois foram 10, 13, 16, 20 e 26 abertos por mês (jul–nov), e nenhum dos abertos vencidos tem movimento financeiro (os pagos têm 100%). Duas leituras são possíveis, atraso real ou baixa não lançada, e só o financeiro sabe qual vale. Isso decide se os títulos vencidos há mais de 30 d são dívida ou lixo de cadastro.

**Efeito esperado em prod:** a composição volta a ser medida nas 3 empresas, e o total `ncg` fica idêntico, porque não há recorrente de folha em prod. `saldo_tesouraria` (saldo − folha_30d) passa a descontar a folha medida da colacor_sc, e a A4 (`financiar_ja` × `financiar_condicional`) lê esse número. A resposta ao vivo leva `ncg.fontes` e o motivo "Folha … sem fonte" em `confianca_dados.motivos` quando a fonte está vazia. O `NcgDecomposicao.tsx` ainda mostra 0 nesse caso, e isso continua fora (front).

**Codex (v2.7, `codex-async.sh` high):** sem P0. Estes achados foram corrigidos no mesmo PR:

- **P1** mapa incompleto atestava (folha/tributos medidos com código fora do mapa);
- **P1** folha sem vencimento virava zero medido na oben;
- **P2** recorrente vigente sem ocorrência na janela;
- **P2** corpo nulo e página cheia aceitos como mapa;
- **P2** o PostgREST falso ignorava a empresa.

O **P1 residual da A4** ficou fora. A A4 não lê `ncg.fontes` e, com folha sem fonte, ainda decide `financiar_ja` com confiança alta. É outra edge (`fin-next-best-action`), e a v2.7 deixa a fonte vazia rara.

**Falsificação** (26/11, `ncg-folha-tributos_test.ts` + `ncg-composicao_test.ts`). O controle ficou verde antes e depois, na mesma invocação, e cada sabotagem foi obrigada a casar exatamente 1 vez. Foram **17 sabotagens, 17 vermelhas**:

- sem limite inferior
- fronteira superior exclusiva
- sem centralização
- centralização sem exigir pessoal no mapa
- parcelamento como tributo
- recorrente sem ocorrência
- tributo contado duas vezes
- tributo medido por histórico pago
- motivo da folha velha omitido
- mapa incompleto não acusa folha
- mapa incompleto não acusa tributos
- 2.04 fora das famílias
- folha sem vencimento medida
- mapa sem filtro de empresa
- corpo malformado aceito
- truncamento aceito
- mapa lido sem `exigirLeitura`

A última ficou **verde** na 1ª rodada: a checagem "não é lista" também lançava, então a camada era inalcançada. O teste do timeout passou a exigir a SQLSTATE, que só `exigirLeitura` propaga.

## Pendência original (resolvida na v2.7)


A fonte certa é o mapa curado por empresa e código `fin_categoria_fluxo_mapping`: `op_pessoal`, `op_impostos`, `op_impostos_lucro`, `op_impostos_parcelamento`. Antes de ligá-lo, é preciso decidir:

- se parcelamento e IRPJ/CSLL entram em "tributos a pagar";
- se a reserva de folha da tesouraria inclui atrasados;
- se INSS/IRRF retidos duplicam o salário bruto em CP aberto;
- se colacor e oben têm folha própria ou centralizada na colacor_sc.

Também está fora deste PR a resposta ao vivo, que ainda devolve `folha_30d = 0` quando a fonte está vazia (consumida por `NcgDecomposicao.tsx` e pela A4).

## Fora de escopo da v2.7, fechado (27/11)

- **A4 v1.2** (`fin-next-best-action`): `caixaDaA1` passou a ler `ncg.fontes.folha`, porque o `saldo_tesouraria` da A1 é `saldo_cc − folha_30d`.
  - Com `false` (folha sem fonte), o saldo está superestimado. O caixa da empresa fica com confiança **baixa**, leva o haircut de 50% e ganha um motivo. Pela regra de `montarFilaAcoes`, só o caixa de confiança alta decide, então `crescer` cai em `falta_dado` e não vai para `financiar_ja`.
  - Com o campo ausente ou inválido (A1 anterior à v2.6), o desconto não é atestado: confiança **média**, sem haircut. É o mesmo padrão do `saldo_inicial`.
  - Os tributos não entram no `saldo_tesouraria`, então não mexem no caixa da A4.
  - Fonte em `src/lib/financeiro/next-best-action-helpers.ts`, com espelho verbatim em `fila.ts`.
  - Falsificação: 5 sabotagens, uma camada por vez, com controle verde antes e depois nos dois locales (`C` e `pt_BR.UTF-8`). Resultado: 5/5 vermelhas.
- **`NcgDecomposicao.tsx`:** com `fontes.x === false`, a barra da parcela some (`null`, não R$ 0), o rótulo passa a dizer "(sem fonte)" e o card de PCO vira "⚠ Parcial — sem fonte: …". O motivo já chegava em `confianca_dados.motivos`.
- **`src/lib/financeiro/ncg-helpers.ts` removido** (ainda com a regra `3.99`). Só o próprio teste o importava.
- **Ficam com o founder, não com código:** tirar o parcelamento da NCG, que muda o total, e saber por que os títulos de folha da colacor_sc não são baixados no Omie desde julho.
