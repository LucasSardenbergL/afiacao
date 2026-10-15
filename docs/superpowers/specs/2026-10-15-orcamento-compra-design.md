# Orçamento de compra — gate econômico + guarda de caixa (v1 = simulação/backtest)

> Projeto 2 do programa "ciclo financeiro de compras" (projeto 1 = Raio-X do estoque parado, #3080).
> **Money-path.** Desenho aprovado pelo founder por seções em 2026-10-15; 1ª consulta Codex (desenho, com `RÉGUA:`) em 2026-10-14 — parecer citado em §9.
> **v1 não muda nada em produção**: não dispara pedido, não altera o motor, não tem migration/edge/Publish.

## 1. Objetivo e definição de pronto

Responder, para cada ciclo do motor de reposição, **"quanto do que o motor pede deveria ser comprado agora?"** — e provar, sobre o histórico, se o corte teria sido seguro.

Pronto (v1) =
1. lógica pura testada em `src/lib/reposicao/orcamento-compra/` (embalagens, valor, caixa, corte, replay);
2. SQL de fatos read-only + script que produz o backtest dos últimos 90 dias de ciclos do motor;
3. relatório (página Artifact) com: R$ que o motor pediu × R$ que o orçamento aceitaria, cortes por motivo (econômico × financeiro), adiado × eliminado × teria rompido, precisão do corte, ΔDIO, estado de caixa por ciclo e sensibilidades;
4. decisão registrada sobre a v2 (aplicar no app) — **só com sinal da v1 com denominador** (regra "Fase N+1 exige sinal da fase N").

Onde mais o comportamento aparece: em nada na v1 (offline). Na v2 apareceria na tela de pedidos do ciclo (Reposição/Oben) e no `CaixaCompraCard` — fora deste escopo.

## 2. Fatos medidos (psql-ro, `ON_ERROR_STOP=1`, marcador `fim|ok`, 2026-10-14)

Consultas reproduzíveis em `docs/superpowers/orcamento-compra/medicoes-2026-10-14.sql`.

| Fato | Valor | Nota |
|---|---|---|
| Fornecedor que passa pelo motor | só **Sayerlack** | 117 disparados/90d, R$349k, todos "À Vista" |
| Expirados sem aprovação (90d) | 263 pedidos, R$778k | não é "desperdício evitado" automaticamente (repetição de ciclo) |
| Taxa de aprovação (90d, pedidos-pai) | ~30% contagem, ~29% valor | o handoff dizia 17% (outra janela/definição); vale o medido |
| Compra disparada/mês | R$78k–138k | set/26 = R$138k |
| Valor dos disparados que só repõe até o PP | **37,6%** (R$131k de R$349k) | definição: `min(qtde, max(PP − estoque_atual, 0)) × preço`; os 62,4% restantes = enchimento acima do PP (handoff citava 93% com outra definição) |
| Estoque Oben (saldo×CMC, saldo>0) | R$517k, 794 SKUs, 6 sem CMC | |
| Saldo bancário Oben | R$656k (`fin_contas_correntes`, 15 contas) | snapshot da engine usou R$646k → reconciliar |
| CP liquidado (v_titulo_baixas), média 6m | ~R$224k/mês | |
| CR liquidado, média 6m | ~R$303k/mês | |
| Sayerlack no CP | fornecedor Omie **8689681266**, ~R$133k/mês liquidado | `nome_fornecedor`/`categoria` vêm **nulos** no CP → atribuir por código |
| Emissão NF → vencimento (Sayerlack) | p10/p50/p90 = 1/4/11 dias | boleto vence pelo **faturamento**, não pela chegada |
| Emissão NF → baixa | p10/p50/p90 = −1/7/12 dias | |
| Pedido → faturamento (`purchase_orders_tracking`) | p10/p50/p90 = 2/7/15 dias | 291 pedidos/180d, 223 faturados |
| Vínculo motor→tracking→NF→CP | 117 → 104 com NF → **97 com CP**; 38 NFs distintas | consolidação muitos-para-muitos real |
| Projeção 13 sem (engine A1, `fin_projecao_snapshots`) | 3 cenários/dia, desde ~jun/26 | só títulos (`cr_omie`, `cp_omie`); `fin_eventos_recorrentes`/`eventuais` **vazias**; pessimista "sobe" de R$646k → R$950k |
| `fin_contas_pagar.saldo` | **não confiável**: R$9,1M de "vencidos" com status PAGO | filtrar por `status_titulo`; atrasado real ≈ R$598k |
| Histórico diário de estoque | **não existe** | replay reconstrói a trajetória (§7) |
| `claude_ro` em `fin_projecao_13_semanas` | permissão negada | ler o snapshot da engine, não a RPC |

## 3. Decisões (não re-litigar)

- **Arquitetura B** (camada sobre o motor, aprovação humana). Descartados: só refinar o motor (A), reescrever probabilístico (C), foundation models, DDMRP, programação estocástica.
- **Teto = duas condições independentes** (decisão Claude + Codex, delegada pelo founder):
  1. **reserva mínima**: saldo projetado (cenário-guarda) ≥ **R$X em todos os dias** do horizonte;
  2. **gate econômico**: embalagem não protegida só entra com **ΔV > 0**.
  Sem orçamento mensal na v1 (só reportado como gasto implícito). Motivo: com ~R$432k acima da reserva, o caixa hoje não morde — quem corta o enchimento é o gate econômico; a reserva é a guarda para quando apertar.
- **R$X** = 30 dias × saída média diária liquidada (≈ R$224k), configuração única versionada no script; sensibilidade 15/30/45 dias. Conta garantida não reduz X enquanto limite/prazo/condição não forem conhecidos. Regra futura (fora da v1): mínimo operacional + P95 do erro acumulado da projeção congelada vs realizado.
- **Escopo v1 = "economia + guarda"**, offline, com backtest histórico (escolha do founder).
- Frete = 2,5% proporcional da NF: **entra no desembolso**, **não** entra como custo fixo de pedido.
- Sigma gaussiano inflado em intermitentes **não** é corrigido aqui (TSB = projeto 3); a v1 usa demanda empírica e sinaliza instabilidade.

## 4. Arquitetura

```
SQL de fatos (psql-ro, as-of por data de decisão) ──► fatos/<data>.json
          │
          ▼
src/lib/reposicao/orcamento-compra/          (puro, sem I/O, testado)
   tipos.ts       contratos (Linha, Embalagem, Fluxo, Trajetoria, Estado)
   embalagens.ts  linha do motor → embalagens incrementais (prefixo por SKU)
   demanda.ts     janelas empíricas de demanda; marca dias censurados; detecta histórico insuficiente
   valor.ts       ΔV por embalagem (§5)
   caixa.ts       trajetória diária + estado viável/inviável/indeterminado (§6)
   corte.ts       protegidos, guloso, mínimo por pedido, split (§5.4)
   replay.ts      estoque contrafactual sem as embalagens cortadas (§7)
          │
          ▼
scripts/orcamento-compra-simular.ts  → resultado.json → página Artifact
```

- Dono no manifesto: módulo `reposicao` (`moneyPath: true`). Testes co-localizados; **nada importa de `src/lib/financeiro/`** (fronteira de módulo) — o caixa chega como fato SQL.
- Leitura PostgREST não é usada (script via psql-ro), mas toda consulta tem `ORDER BY` estável e nenhum `LIMIT` silencioso.
- Ausente ≠ zero em todo contrato: preço/margem/lead time ausente → `null` → embalagem **sem score** (vai para "revisão humana"), nunca 0.

## 5. Gate econômico

### 5.1 Unidade
**Embalagem incremental** de um SKU numa linha do motor: a quantidade `qtde_final` é quebrada em passos de `1/fator_embalagem_portal` (ou da unidade de compra quando sem portal). Embalagem k de um SKU só é elegível se k−1 foi aceita (prefixo).

### 5.2 Valor
\[
\Delta V_k = m_i\,E[\Delta\text{unidades atendidas}_k] \;-\; c_i\,h\sum_t E[\Delta\text{estoque}_{k,t}] \;-\; E[\Delta\text{perdas}_k] \;+\; E[\Delta\text{benefício de preço}_k]
\]
- **Contrafactual**: comprar k **agora** vs **adiar para a próxima oportunidade viável** (o motor roda a cada 2h; Sayerlack recebe ~1,3 pedido/dia útil). "Não comprar agora" ≠ "nunca repor".
- Unidades atendidas só contam se a demanda cairia **depois da chegada desta compra e antes da chegada da próxima oportunidade**; demanda perdida antes da chegada não é venda salva.
- `m_i` = `preco_venda_medio` (180d) − custo de aquisição atual (preço do item na linha; **não** CMC); `c_i` = custo de aquisição; `h` = `cm_anual/365` de `empresa_configuracao_custos`; Σ estoque em **unidades×dia** até o fim da janela; sobra no fim da janela valorada a custo (não é perda nem ganho), exceto se o SKU estiver no Raio-X como parado (perda esperada = obsolescência — parâmetro, default 0 com flag).
- Benefício de preço: só quando a linha tem `modo_promocao` ativo — `(preço_cheio − preço_promo) × unidades consumidas que seriam compradas a preço cheio depois`.
- **Demanda**: distribuição empírica das somas de janelas de demanda diária (180d, zeros reais preservados, dias com estoque ≤ 0 reconstruído marcados como censurados e excluídos). Ranking também calculado com a gaussiana do motor → reportar **estabilidade** (embalagens que mudam de lado do corte entre os dois modelos = "sensível ao modelo").
- **Histórico insuficiente** (< N ocorrências de venda em 180d, N parâmetro, default 3): sem score, sem proteção automática → "revisão humana".

### 5.3 Desembolso (denominador e caixa)
`qtd × preço × (1 + 2,5% frete)`, datado em **data do pedido + Δ(pedido→faturamento) + Δ(faturamento→vencimento)**. Para o caixa usa-se o **p10** de cada Δ (pagamento mais cedo = risco); atraso logístico nunca adia pagamento. Hierarquia: vencimento conhecido > regra contratual documentada > distribuição medida (§2).

### 5.4 Protegidos, corte, mínimo e split
- **Compromissos** (pedidos já disparados/aprovados) são **base fixa** do caixa, nunca protegidos a debitar.
- **Protegido** = quantidade mínima da linha que cobre a ruptura prevista **entre a chegada desta compra e a chegada da próxima oportunidade**, só se a compra ainda chega a tempo; cada proteção carrega motivo, quantidade e janela. Nunca protege enchimento.
- Corte: protegidos primeiro; depois guloso por score `ΔV / desembolso` decrescente, só ΔV > 0, prefixo por SKU, aceitando enquanto a trajetória diária fica ≥ R$X.
- **Mínimo por pedido**: se o conjunto aceito ficar abaixo do mínimo, comparar (a) acrescentar a(s) melhor(es) embalagem(ns) factível(is) até o mínimo vs (b) zerar o pedido — pelo ΔV total. Regra da Sayerlack (mínimo por pedido ou por NF; valor) = **pergunta aberta §10**; até a resposta, parâmetro com default R$0 e flag no relatório.
- **Split** administrativo: pai e filhos avaliados como um conjunto (linhagem por `split_parent_id`); resultado idêntico ao do pedido não-splitado.
- Saída chama-se **"score marginal da heurística"** (não λ*): o guloso não é ótimo com embalagens indivisíveis e restrições em datas diferentes. Sensibilidade do caixa = reexecutar com reserva 15/30/45 dias e mostrar Δ compras e Δ valor. Se tudo elegível cabe com folga, escassez de caixa = 0.

## 6. Guarda de caixa (diária, 91 dias, cenário-guarda)

Trajetória diária como-de cada data de decisão:
1. **Base** = snapshot **pessimista** da engine daquele dia (estresse da engine já aplicado; não reaplicar). Saldo inicial reconciliado com `fin_contas_correntes` — diferença vira linha "reconciliação", não é absorvida. Detalhe diário pelos títulos (`saidas`/`entradas` do snapshot têm data); onde só houver agregado, limite inferior conservador (saídas no 1º dia, entradas no último).
2. **Compromissos não titulados** = pedido disparado − parte já titulada, por **pedido → `purchase_orders_tracking.omie_codigo_pedido` → `nfe_numero` → `fin_contas_pagar.numero_documento_fiscal` (fornecedor 8689681266)**. Faturamento parcial = título + resíduo (conserva o total). Sem NF conciliável → entra **inteiro**, marcado "não conciliado".
3. **Saídas não-Sayerlack não tituladas** = ritmo medido no CP liquidado (total − fornecedor 8689681266, 6m) **por dia do mês**, menos o já titulado no mesmo período (evita dupla contagem).
4. **Entradas de vendas novas = 0** no cenário-guarda. Sensibilidades (reportadas, nunca decidem): vendas novas −30% com +15d e −50%, partindo de vendas por data com as curvas de recebimento da engine; nunca reaplicar estresse ao CR existente.
5. **Continuidade do motor** = provisão diária = mediana da compra Sayerlack por dia útil (90d); a compra simulada **substitui** a parte da provisão que ela já cobre.

**Estados**:
- `viavel` — saldo ≥ R$X em todos os dias;
- `inviavel` — base + compromissos + protegidos furam R$X: reporta 1ª data de violação e déficit máximo (nunca "aprovar protegidos e seguir");
- `indeterminado` — camada material ausente/não conciliada (default: não conciliado > 10% de R$X), com a camada nomeada.

Desembolso posterior ao dia 91 estende a verificação até ele.

## 7. Medição — backtest e replay contrafactual

- Universo: ciclos do motor dos últimos 90 dias (pedidos-pai + linhagem de split), com fatos **as-of** a data de decisão.
- Replay por SKU: estoque inicial = `estoque_fisico` da linha no ciclo; + recebimentos reais (tracking `t4_data_recebimento` × quantidades) **menos** as embalagens cortadas; − demanda diária real. Ruptura no replay = estoque ≤ 0 com demanda; demanda em dia de ruptura **real** é censurada (marcada, não estimada como zero). O replay carrega as próprias decisões: um corte pode reaparecer no ciclo seguinte do replay e ser comprado (= **adiado**).
- **Erro de fechamento**: trajetória reconstruída vs estoque atual real por SKU; SKU com |erro| > max(1 embalagem, 10% do estoque real) sai da medição como `indeterminado` (não entra no denominador).
- Classificação de cada corte: `adiado` · `eliminado` · `teria_rompido` · `indeterminado`.
- Episódios deduplicados (mesma necessidade reapresentada em ciclos seguidos conta 1). Separar cortes de pedidos que o humano já deixou expirar vs cortes que mudariam uma compra efetiva.
- Indicadores: **precisão do corte** = R$ cortado sem ruptura ÷ R$ cortado (com N e indeterminados; zero corte → "não aplicável"); **ΔDIO** = Δ estoque médio a custo ÷ CMV diário comparável; caixa liberado (Δ estoque médio a custo).

## 8. Testes (provas que falsificam)

Unitários (vitest, co-localizados) — cada um com a marca do ramo, não só "deu algo":
1. **Paridade**: todas as embalagens com ΔV > 0 e caixa folgado → aceita exatamente o que o motor pede.
2. **Enchimento**: SKU com próxima oportunidade em 1 dia e LT 14 → embalagens acima da cobertura até a próxima chegada têm ΔV < 0.
3. **Conservação pedido→CP**: pedido R$100k com R$40k titulados → base = título 40 + resíduo 60 (nunca 140 nem 40).
4. **Split equivalente**: pai splitado em 2 filhos → mesmo resultado do pedido inteiro.
5. **Vencimento antecipado**: atraso de chegada não move o pagamento.
6. **Proteção inviável**: base R$240k, reserva R$224k, protegidos R$30k → `inviavel`, déficit R$14k, 1ª data.
7. **Intrassemana**: R$230k seg, −R$40k qua, +R$80k sex com reserva R$224k → violação detectada (o fechamento semanal R$270k não mascara).
8. **Pagamento fora do horizonte**: desembolso no dia 95 estende a verificação.
9. **Trajetória**: com decisões congeladas, remover uma camada muda o saldo exatamente pelo fluxo removido.
10. **Ausente ≠ zero**: preço/margem `null` → embalagem sem score, nunca ΔV calculado com 0.
11. **Contrafactual**: compra que evitou ruptura (saldo mínimo 4 un., embalagem cortada 12) → replay classifica `teria_rompido`, não "seguro".
12. **Guloso não-ótimo documentado**: caso A/B/C do Codex — o teste fixa o comportamento heurístico (aceita A) e o relatório o rotula como heurística.

Falsificação: commitar antes; sabotar uma camada por vez (ex.: remover a dedução do já-titulado) e exigir vermelho no teste correspondente, com controle verde na mesma invocação.

## 9. Parecer Codex (desenho, 2026-10-14 — gpt-6-astra, reasoning max, 449s)

Veredito: **reprovou o desenho inicial**; concordou com arquitetura B e reserva mínima. Incorporado:
- P0 projeção: reconciliar representado × não representado desde o dia 1 (não "quando os títulos acabam"); CP liquidado − compra disparada mistura bases → resolvido atribuindo CP pelo código do fornecedor (§6.3); faltava continuidade das reposições do motor (§6.5); ausência material → `indeterminado`, não "confiança baixa".
- P0 protegidos podem tornar o problema inviável → estado `inviavel` (§6); compromissos não são protegidos.
- P0 conciliação pedido→NF→títulos muitos-para-muitos → §6.2 (medido: 97/117 casam; 38 NFs).
- P0 datação (vencimento pelo faturamento, não chegada; diário em todo o horizonte) → §5.3 e §6 (medido: emissão→vencimento p50 4d).
- P1 carregamento dimensional (unidades×dia), contrafactual "adiar", frete no desembolso, CMC ≠ preço de aquisição → §5.2–5.3.
- P1 λ* não é preço-sombra válido → "score marginal da heurística" + sensibilidade de reserva (§5.4).
- P1 intermitentes: demanda empírica + estabilidade de ranking; histórico insuficiente → revisão humana (§5.2).
- P0 régua de validação: replay contrafactual em vez de "humano comprou e não rompeu"; episódios deduplicados; ΔDIO por estoque médio/CMV (§7).
- Q5: R$224k defensável como default provisório; não reduzir por conta garantida sem limite conhecido (§3).

Consulta 2 (adversarial do diff final) fica para a sessão de implementação.

## 10. Perguntas abertas (não bloqueiam a v1 — viram parâmetro com flag)
1. **Mínimo da Sayerlack**: por pedido no portal ou por NF? Qual valor? (hoje só o alerta de R$3k).
2. Tabela Sayerlack 28/42/56d (encargo, parcela única/parcelado, desconto de 2% vale para tudo) — não usada na v1 (DPO não é alavanca), registrada para a v2.
3. Os ~R$33k/mês de diferença entre CP Sayerlack liquidado (~R$133k) e compra disparada pelo motor (~R$100k): compras fora do motor? O backtest só mede o que passa pelo motor; o caixa usa o CP real.

## 11. Fora de escopo
Aplicar o corte no app (v2), mudar o motor, corrigir "À Vista" fixo, TSB/intermitentes (projeto 3), outros fornecedores, conta garantida como fonte de caixa, orçamento mensal.
