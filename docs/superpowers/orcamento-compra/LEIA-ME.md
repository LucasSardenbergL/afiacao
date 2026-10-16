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

## Resultado da rodada de 2026-10-15 (fatos de hoje = 2026-10-15; janela 2026-07-18..2026-10-15)

| Medida | Valor |
|---|---|
| Ciclos / disparados | 266 / 118 (+140 expirados, 7 cancelados, 1 pendente) |
| Motor pediu (disparados, com frete 2,5%) | R$ 376.171 |
| Orçamento aceitaria (disparados) | R$ 134.616 (35,8%) |
| Cortes nos disparados por motivo | econômico R$ 184.081 · financeiro R$ 25.902 · sem score R$ 31.571 |
| Valor cortado efetivo / expirado (dedup. por episódio) | R$ 188.772 / R$ 144.455 |
| Cortes sem preço | 58 |
| Episódios de corte (efetivos, dedup. 7d) | 261 |
| Precisão do corte | 100,0% — n = 156 cortes classificados, **863 indeterminados** (de 1.019); valor classificado R$ 42.058 |
| Classes dos cortes classificados | adiado 108 · eliminado 48 · teria_rompido 0 |
| ΔDIO / caixa liberado | 0,91 dia / R$ 4.349 — só 21 episódios medidos (106 sem horizonte de 30d, 134 indeterminados) |
| CMV diário do universo do motor | R$ 4.761 |
| Embalagens sensíveis ao modelo (sinal de ΔV muda empírico × gaussiano) | 593 |
| Estados de caixa (todos os ciclos) | viável 21 · inviável 13 · indeterminado 232 |
| Indeterminado por camada | compromisso_nao_conciliado 230 · snapshot 2 |
| Sensibilidade (disparados) | 15d: R$ 145.937, 0 inviáveis · 30d: R$ 134.616, 5 inviáveis · 45d: R$ 122.736, 22 inviáveis |

### Conferências de sanidade

- `nDisparados` = 118 (esperado ≈ 120, contagem só Sayerlack) ✅
- `valorMotorDisparados` = R$ 376.171,13 = Σ `valor_total` dos 118 ciclos disparados (R$ 366.996,23) × 1,025 → divergência **0,00%** ✅ (sem JOIN duplicando, sem split contado 2×).
- Fechamento do estoque reconstruído: **107 de 152 SKUs (70%) com erro de fechamento** em ao menos um ciclo (|reconstruído − estoque_fisico gravado| > max(passo, 10%)); por linha, 539 de 1.021 fecham. Erro é majoritariamente positivo (reconstruído > gravado; mediana +1 un, p90 +10 un). Pelo critério do brief (estoque reconstruído < 0 em algum dia de 270d), são 13/152 (8,6%). **Limitação, não escondida:** > 30% pelo critério de fechamento — o replay desses SKUs vira `indeterminado`, e é por isso que 85% dos cortes não classificam.
- Indeterminado de caixa: 230 dos 232 vêm de `compromisso_nao_conciliado` (pedido disparado nos últimos 60d sem NF/título casado acima de 10% da reserva). É a camada que mais tira o veredito de caixa da v1.

### Leitura (o que NÃO concluir)

- **Precisão 100% é sobre amostra enviesada:** só classifica corte cujo SKU fecha o estoque e cuja série pós-decisão não tem dia censurado (estoque ≤ 0). SKUs que de fato romperam caem em `indeterminado` por construção. Não ler como "o corte nunca causa ruptura".
- **"Econômico" domina o corte** porque o intervalo de oportunidade é 1 dia (o motor roda diariamente): a embalagem marginal só "compra" um dia de cobertura extra e perde para o custo de carregamento. A classe `adiado` (108) > `eliminado` (48) é coerente com isso.
- **Inviáveis concentrados em 2026-07-18..07-23** (os 6 primeiros dias da janela; déficit máximo R$ 220k–280k abaixo da reserva). **Não explicado nesta rodada** — investigar antes da v2.

## Falsificação (2026-10-15)

Uma camada por vez; controle verde ANTES e DEPOIS na mesma invocação; confere que o `sed` casou (`git diff` não vazio); restaura com `git checkout --`. Rodado com `LC_ALL` vazio, `LC_ALL=pt_BR.UTF-8` e `LC_ALL=C`: **5/5 vermelho nos três**, `git status` limpo ao fim.

| Sabotagem (intenção) | Arquivo / teste | Resultado (idêntico nos 3 ambientes) |
|---|---|---|
| conciliação sem descontar título (`residuo = c.valor`) | `camadas.ts` / `caixa.test.ts` | vermelho: 4 failed / 21 |
| avaliarEstado sem violação (`if (false)`) | `caixa.ts` / `caixa.test.ts` | vermelho: 2 failed / 21 |
| corte sem checar caixa (`!cabe(...)` removido) | `corte.ts` / `corte.test.ts` | vermelho: 3 failed / 22 |
| atendidas sem backlog (`Math.min(Q, backlog) +` removido) | `valor.ts` / `valor.test.ts` | vermelho: 2 failed / 10 |
| classificarCorte sem `teria_rompido` | `replay.ts` / `replay.test.ts` | vermelho: 2 failed / 21 |

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

**Estado em 2026-10-15: portão FECHADO.** A parte de precisão passa (100%, n = 156, 261 episódios), mas há 13 ciclos inviáveis sem explicação (2026-07-18..07-23) e a precisão vem de uma amostra enviesada (85% indeterminados, 70% dos SKUs com fechamento ruim) — antes de abrir, explicar os inviáveis e reduzir os indeterminados (fechamento do estoque e conciliação pedido↔NF).
