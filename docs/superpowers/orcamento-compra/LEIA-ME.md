# Orçamento de compra — backtest v1 (simulação)

**O que é:** simulação read-only de um orçamento de caixa sobre os ciclos do motor de reposição Sayerlack dos últimos 90 dias. Pergunta: se um corte por valor (ΔV>0 por embalagem) + guarda de caixa (reserva de 30 dias, cenário-guarda sem vendas novas) estivesse ligado, quanto do pedido do motor teria sido aceito, e o corte teria causado ruptura? **Nada mudou em produção.** v1 = só simulação; aplicar no app é a v2, atrás do portão abaixo.

- Spec: [`docs/superpowers/specs/2026-10-15-orcamento-compra-design.md`](../specs/2026-10-15-orcamento-compra-design.md)
- Página de decisão (gerada, commitada): [`index.html`](index.html) — publicada como Artifact pelo controlador da sessão.
- Código: `scripts/orcamento-compra/simular.ts` (backtest), `scripts/orcamento-compra/pagina.ts` (página), `src/lib/reposicao/orcamento-compra/*` (núcleo puro, sem I/O), `fatos.sql` (consulta read-only).

## Como rodar

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
# 1) backtest contra produção (read-only via ~/.config/afiacao/psql-ro); saida/ é ignorada pelo git
bun scripts/orcamento-compra/simular.ts --banco docs/superpowers/orcamento-compra/saida > /tmp/oc-run.log 2>&1; rc=$?
tail -c 1500 /tmp/oc-run.log; [ "$rc" -eq 0 ] && grep -c '^fim|ok$' /tmp/oc-run.log   # esperado: 1
# exit 2 = pré-voo reprovado → corrigir a FONTE, nunca afrouxar o pré-voo

# 2) página
bun scripts/orcamento-compra/pagina.ts docs/superpowers/orcamento-compra/saida/resultado.json docs/superpowers/orcamento-compra/index.html > /tmp/oc-pag.log 2>&1; rc=$?
tail -1 /tmp/oc-pag.log; [ "$rc" -eq 0 ]   # esperado: fim|ok
```

## Resultado da rodada de 2026-10-15, após R28 (fatos de hoje = 2026-10-15; janela 2026-07-18..2026-10-15)

| Medida | Valor |
|---|---|
| Ciclos / disparados | 267 / 118 (+140 expirados, 7 cancelados, 2 pendentes) |
| Motor pediu (disparados, com frete 2,5%) | R$ 376.171 |
| Orçamento aceitaria (disparados) | R$ 134.616 (35,8%) |
| Cortes nos disparados por motivo | econômico R$ 184.081 · financeiro R$ 25.902 · sem score R$ 31.571 |
| Valor cortado efetivo / expirado (dedup. por episódio) | R$ 188.772 / R$ 146.982 |
| Cortes sem preço | 60 |
| Episódios de corte (efetivos, dedup. 7d) | 261 |
| Precisão do corte | 100,0% — n = 156 cortes classificados, **863 indeterminados** (de 1.019); valor classificado R$ 42.058 |
| Classes dos cortes classificados | adiado 108 · eliminado 48 · teria_rompido 0 |
| ΔDIO / caixa liberado | 0,91 dia / R$ 4.349 — só 21 episódios medidos (106 sem horizonte de 30d, 134 indeterminados) |
| CMV diário do universo do motor | R$ 4.756 |
| Embalagens sensíveis ao modelo (sinal de ΔV muda empírico × gaussiano) | 601 |
| Estados de caixa (todos os ciclos) | viável 24 · inviável 13 · indeterminado 230 (disparados: 12 · 5 · 101) |
| Indeterminado por camada | compromisso_nao_conciliado 228 · snapshot 2 |
| Sensibilidade (disparados) | 15d: R$ 145.937, 0 inviáveis · 30d: R$ 134.616, 5 inviáveis · 45d: R$ 122.736, 22 inviáveis |

### Conferências de sanidade

- `nDisparados` = 118 (esperado ≈ 120, contagem só Sayerlack) ✅
- `valorMotorDisparados` = R$ 376.171,13 = Σ `valor_total` dos 118 ciclos disparados (R$ 366.996,23) × 1,025 → divergência **0,00%** ✅ (sem JOIN duplicando, sem split contado 2×).
- Fechamento do estoque reconstruído: **107 de 155 SKUs (69%) com erro de fechamento** em ao menos um ciclo (|reconstruído − estoque_fisico gravado| > max(passo, 10%)); por linha, 556 de 1.040 fecham. O erro é majoritariamente positivo (reconstruído > gravado; mediana +1 un, p90 +10 un). Pelo critério do brief (estoque reconstruído < 0 em algum dia de 270d), são 13/152 (8,6%, medido antes do R28). **Limitação, não escondida:** passa de 30% pelo critério de fechamento. O replay desses SKUs vira `indeterminado`, e por isso 85% dos cortes não classificam.

### R28 — pedido sem NF recente é "a faturar"

Pedido disparado **sem NF** com menos de 15 dias (p90 pedido→faturamento) entra inteiro na camada `compromisso_a_faturar` e **não** conta no limiar de 10% da reserva. Sem NF com 15 dias ou mais, ou NF sem título casado, continua `compromisso_nao_conciliado`.

**Efeito medido: quase nenhum** (indeterminados 232 → 230; a rodada nova também tem 1 ciclo a mais). Diagnóstico com os fatos da rodada: o que trava o veredito é **NF informada no pedido sem título no CP até o snapshot do ciclo**, não "pedido sem NF". Em todos os ciclos amostrados (07-20, 07-24, 08-05, 08-20, 09-10), o título dessas NFs existe hoje, só foi criado depois do snapshot. Exemplo: em 09-10, R$ 62k contra um limiar de R$ 22k. **Todos esses pedidos têm menos de 15 dias.** A lista de NFs do pedido é a de HOJE, não a do momento do ciclo. Na hora do ciclo, a NF provavelmente nem existia ou ainda não tinha chegado ao CP.

**Contrafactual (não aplicado, aguarda decisão):** estender a regra de idade a "NF sem título com menos de 15 dias" levaria a indeterminado 3, viável 203 e inviável 61 (07-18..08-23). Nos disparados ficaria 92 viável, 23 inviável e 3 indeterminado. O aceito a 30 dias seria R$ 119.273; a sensibilidade iria a 15d R$ 134.334/8, 30d R$ 119.273/23 e 45d R$ 101.714/53.

### R29 — os 13 inviáveis de 2026-07-18..07-23

A causa é **aperto real de caixa no cenário-guarda**, não um artefato de borda de janela.

- **Janelas completas:** todas as janelas de lookback estão completas nessas datas.
  - Pagos não-Sayerlack: desde 2025-12-22, e a janela da reserva começa em 2026-01-19.
  - Títulos Sayerlack: desde 2026-01-19, igual ao início da janela.
  - Disparados: desde 2026-04-30, quando o motor começou; a consulta corta em hoje−180 = 04-18.
  - Snapshots: diários desde 2026-07-13.
- **A base sozinha já fura a reserva:** sem nenhuma candidata, a base fura a reserva nos três ciclos medidos.

| Ciclo | Saldo inicial | Reserva 30d | Piso da base (data) | 1ª violação | 3 maiores camadas até o piso |
|---|---|---|---|---|---|
| 1239 (2026-07-20, disparado) | R$ 355k | R$ 291k | R$ 57k (10-18) | 09-09 | continuidade do motor −R$ 199k · saídas não-Sayerlack −R$ 190k · compromisso não conciliado −R$ 16k (títulos da base: +R$ 108k) |
| 1259 (2026-07-22, disparado) | R$ 354k | R$ 289k | R$ 57k (10-20) | 09-11 | continuidade −R$ 205k · saídas não-Sayerlack −R$ 205k · não conciliado −R$ 19k (base: +R$ 134k) |

Leitura: o saldo de ~R$ 355k está só ~R$ 65k acima de uma reserva de ~R$ 290k. Com zero venda nova em 91 dias, o ritmo de saídas e a continuidade do motor (~R$ 400k) passam das entradas já tituladas (~R$ 110–135k). Os inviáveis param em 07-23 só porque, a partir daí, a camada não conciliada **mascara** o veredito: `indeterminado` tem precedência sobre `inviavel`. No contrafactual acima, os inviáveis vão até 08-23. Nenhum ajuste de código foi feito: não é artefato, então fica registrado aqui.

### Leitura (o que NÃO concluir)

- **Precisão 100% é sobre amostra enviesada:** só classifica corte cujo SKU fecha o estoque e cuja série pós-decisão não tem dia censurado (estoque ≤ 0). SKUs que de fato romperam caem em `indeterminado` por construção. Não ler como "o corte nunca causa ruptura".
- **"Econômico" domina o corte** porque o intervalo de oportunidade é 1 dia (o motor roda diariamente): a embalagem marginal só "compra" um dia de cobertura extra e perde para o custo de carregamento. A classe `adiado` (108) > `eliminado` (48) é coerente com isso.
- **Cenário-guarda em 91 dias é estrutural:** com zero venda nova, quase todo ciclo com saldo perto da reserva fica inviável (ver R29). O veredito de caixa diz "não há folga no pior caso", não "a compra quebrou o caixa".

## Falsificação (2026-10-15, refeita após R28)

Uma camada por vez; controle verde ANTES e DEPOIS na mesma invocação; confere que o `sed` casou (`git diff` não vazio); restaura com `git checkout --`. Rodado com `LC_ALL` vazio, `LC_ALL=pt_BR.UTF-8` e `LC_ALL=C`: **6/6 vermelho nos três**, `git status` limpo ao fim.

| Sabotagem (intenção) | Arquivo / teste | Resultado (idêntico nos 3 ambientes) |
|---|---|---|
| conciliação sem descontar título (`residuo = c.valor`) | `camadas.ts` / `caixa.test.ts` | vermelho: 4 failed / 25 |
| avaliarEstado sem violação (`if (false)`) | `caixa.ts` / `caixa.test.ts` | vermelho: 2 failed / 25 |
| corte sem checar caixa (`!cabe(...)` removido) | `corte.ts` / `corte.test.ts` | vermelho: 3 failed / 22 |
| atendidas sem backlog (`Math.min(Q, backlog) +` removido) | `valor.ts` / `valor.test.ts` | vermelho: 2 failed / 10 |
| classificarCorte sem `teria_rompido` | `replay.ts` / `replay.test.ts` | vermelho: 2 failed / 21 |
| R28: nunca "a faturar" (`aFaturar = false`) | `camadas.ts` / `caixa.test.ts` | vermelho: 2 failed / 25 |

## Perguntas abertas (spec §10)

1. **Mínimo da Sayerlack**: por pedido no portal ou por NF? Qual valor? (a v1 simula com mínimo = R$ 0, i.e. não modelado).
2. Tabela Sayerlack 28/42/56d (encargo, parcela única/parcelado, desconto de 2%) — não usada na v1; registrada para a v2.
3. ~R$ 33k/mês entre CP Sayerlack liquidado (~R$ 133k) e compra disparada pelo motor (~R$ 100k): compras fora do motor? O backtest só mede o que passa pelo motor; o caixa usa o CP real.

## Portão da v2 (re-executável — não é recado)

**Aplicar no app só se:** precisão do corte ≥ 95% com n ≥ 30 episódios efetivos **e** zero ciclo inviável não explicado. Rode o passo 1 de "Como rodar" e então:

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
R=docs/superpowers/orcamento-compra/saida/resultado.json
jq -e '.resumo as $r | ($r.precisao.precisao != null and $r.precisao.precisao >= 0.95 and $r.precisao.n >= 30 and $r.episodios >= 30)' "$R" > /dev/null; rc_precisao=$?
jq -r '.ciclos[] | select(.estado.tipo=="inviavel") | [.data, .status, .estado.primeiraViolacao, (.estado.deficitMax|floor)] | @tsv' "$R" > /tmp/oc-inviaveis.tsv
wc -l < /tmp/oc-inviaveis.tsv   # cada linha precisa de explicação escrita aqui antes de abrir a v2
[ "$rc_precisao" -eq 0 ] && [ ! -s /tmp/oc-inviaveis.tsv ]   # exit 0 = portão aberto
```

**Estado em 2026-10-15 (após R28): portão FECHADO** (comando acima: `rc_precisao=0`, 13 inviáveis → exit 1).
- A parte de precisão passa: 100%, n = 156, 261 episódios.
- Há 13 ciclos inviáveis. O R29 os explica como aperto real no cenário-guarda, mas a regra pede explicação por linha antes de abrir.
- A precisão vem de uma amostra enviesada: 85% dos cortes indeterminados e 69% dos SKUs com fechamento ruim.
- O veredito de caixa segue mascarado: 228 ciclos têm NF sem título as-of (ver R28).
