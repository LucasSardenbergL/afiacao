# Histórico do DES: sem meta transportada, sem faturado inventado, sem veredito com dado parcial (plano v6, lote 3: C5)

Data: 2026-11-05. Plano: `docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md` §2, item C5
(DES-HIST). Money-path: o veredito do trimestre ("meta atingida") é o que decide o desconto por
desempenho do trimestre seguinte. Mesma classe do lote 2 (#3611): **ausente ≠ zero**.

## O defeito (medido na prod, OBEN, 2026-11-05)

`src/components/des/historico/useHistoricoData.ts` montava cada card com:

- `faturado = Number(… ?? 0)`: trimestre sem snapshot virava **R$ 0,00**;
- `meta = Number(meta_faturamento ?? live.meta_pessoal ?? 0)`: trimestre passado sem meta herdava a
  meta do trimestre **atual**, porque a posição ao vivo é filtrada pelo atual;
- só `isLoading`: leitura que falhava virava lista vazia ("Nenhum trimestre cadastrado") ou
  trimestres zerados;

e `QuarterCardItem` julgava "Meta não atingida" sempre que `meta > 0` e `faturado < meta`.

Na prod, OBEN tinha metas em T1–T4/26 e **um único snapshot** (T2/26, de 18/04). O resultado era:

| Trimestre | Antes | Depois |
| --- | --- | --- |
| T1/26, T3/26 (sem snapshot) | Faturado final R$ 0,00 · **Meta não atingida** | Faturado — · **Sem dado** |
| T2/26 (snapshot de 18/04, 18 dias dentro do trimestre) | Faturado final R$ 103 mil · **Meta não atingida** | Faturado até 18/04/2026 · **Sem fechamento** |
| T4/26 (atual) | Faturado (ao vivo) **R$ 264.175,21** · 3★ | Posição — · faixa — |

O T4/26 só foi achado na consulta de desenho: a view `v_des_posicao_trimestre_ao_vivo` calcula a
posição conservadora como `COALESCE(fat_bruto,0) + trânsito`. Sem snapshot GoodData no trimestre
(`fat_bruto_confirmado` NULL), os R$ 264 mil são só pedidos em trânsito, mas apareciam como
"faturado", e a faixa de 3★ vinha desse valor.

## O conserto

A derivação saiu para um módulo puro, `historico/derivar.ts` (`montarCards`, `julgarTrimestre`,
`rotuloFaturado`, `temHistorico`, `mediaDasMetas`). O hook ficou fino.

1. **Nulidade.** `numOuNull` aceita só `number` ou string numérica não vazia. Ausente, vazio, NaN,
   `false` e `[]` viram `null`, nunca 0. O zero real é preservado. Meta, faturado e faixa são
   `number | null`, e a UI mostra "—".
2. **Procedência temporal.** A meta vem do próprio trimestre. A da posição ao vivo só cobre o atual,
   e só se a linha declara ser do `(ano, trimestre)` pedido. `objetivo_valor` do snapshot é o
   objetivo do fornecedor e não vira meta pessoal.
3. **Posição ≠ faturado.** A posição e a faixa ao vivo só valem com `fat_bruto_confirmado`
   presente. O rótulo diz "Posição ao vivo (faturado + pedidos)".
4. **Fechamento.** Um trimestre passado só tem veredito se o último snapshot foi tirado no último
   dia do trimestre ou depois (`data_referencia >= fim`). Se não, mostra "Faturado até dd/mm" e o
   badge "Sem fechamento". Se o último snapshot não traz faturado, um snapshot anterior não é usado
   como "final".
5. **Julgamento.** `julgarTrimestre` tem 6 estados: `em_andamento`, `planejado` (trimestre futuro,
   que também sai do filtro "encerrados"), `sem_dado`, `sem_fechamento`, `atingida` e
   `nao_atingida`. A cor da barra do gráfico segue o mesmo julgamento. Antes, meta 0 pintava a barra
   de verde.
6. **Leitura.** `estadoDeLeitura` cobre as 4 queries e `<AvisoLeituraFalhou>` é o mesmo padrão do
   lote 2. Também cobre o offline na 1ª leitura (`pending+paused`, que **não** é `isLoading`) e o
   erro depois de um sucesso. O empty-state considera todas as fontes, incluindo a posição ao vivo.
   O modal guarda a chave do trimestre, não uma cópia do card.
7. **Fuso.** `quarterDates` montava a data com `toISOString()`, que converte para UTC: em fuso
   positivo, o fim do T2 saía 29/06 e um snapshot da véspera "fecharia" o trimestre. Agora usa os
   componentes locais, e há teste em 4 fusos.

## Prova

- vitest: `derivar.test.ts` (derivação pura), `QuarterCardItem.test.tsx` (badges e rótulos),
  `HistoricoTab.erro.test.tsx` (integração com QueryClient real e Supabase mockado nos dados da prod:
  cada uma das 4 queries falhando, offline, erro após sucesso, controle, empty-state e modal vigente).
- Falsificação: script com controle verde **na mesma invocação** antes e depois, uma sabotagem por
  guarda (incluindo os consumidores: card, aba, modal), nos dois locales (`C` e `pt_BR.UTF-8`). O
  script imprime qual teste ficou vermelho. Resultado no corpo do PR.
- A falsificação pegou um **teste cego**. O teste do empty-state "sem metas, com posição ao vivo"
  continuava verde com o empty-state antigo (S17), porque a fixture tinha `meta_pessoal` na view e
  `des_meta_empresa` vazio. Isso é incoerente, já que a view lê a meta dessa tabela: o card do
  atual ganhava meta e passava pelos dois. A fixture foi corrigida, e o teste só fica verde com
  `temHistorico`.

## Fora do escopo (follow-up)

- **A própria view** `v_des_posicao_trimestre_ao_vivo` fabrica `COALESCE(fat_bruto,0)` na posição,
  na faixa e no gap. Isso afeta a `PosicaoAtualTab`. Corrigir pede migration, porque o front só
  contorna nesta tela.
- Proveniência faixa×desconto do checkin (data e origem), tooltip do recharts para barra nula, e
  cobertura da "meta média" (por exemplo, "metas conhecidas: 2/4").
