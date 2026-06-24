# Cockpit de Valor (A3) — omissão honesta do EVP otimista (capital parcial)

> Spec money-path. Helper TS puro (`src/lib/financeiro/valor-cockpit-helpers.ts`) espelhado VERBATIM no edge Deno (`supabase/functions/fin-valor-cockpit/index.ts`). Sucede o #961 (EVP-teto marcado). Decisão tomada por Claude + `/codex consult` (2026-06-23), delegada pelo founder.

## Problema (vivo, não mais latente)

`montarCelulasComboEVP` calcula `evp = cm − encargo`, `encargo = k·(a_cs + i_cs)`. Quando o AR do cliente OU o estoque do SKU é desconhecido (`null`), a perna vira 0 → `encargo` subestimado → `evp` é um **teto** (upper bound), otimista. O #961 marcou esses combos `evp_parcial` mas **manteve o número e o somou nos rollups**. A UI ignora a flag e pinta o teto positivo de verde.

O #961 foi feito quando `k=null` (Ke vazio) → dano R$0 (latente). **Hoje o Ke da Oben está ligado: `ancora 0,25 + prêmio 0,05 → k=0,30`.** O viés está ativo em produção.

## Medição (psql-ro, TTM Oben, 2026-06-23)

- ~**9,5% da receita** (~R$451k) vem de SKU **sem estoque** → perna `i_cs` ausente → EVP-teto.
- Margem (`cm%`) dessa fatia: **~40%**. Como `cm≈40%` e `k=0,30`, o teto dessa fatia é **quase sempre POSITIVO** (otimista): para o teto ser ≤0 precisaria AR alocado ≥ `cm/k ≈ 1,33×` a receita do combo (DSO>485d), implausível.

## Invariante-chave

`encargo_real ≥ encargo_parcial` (perna ausente=0 subestima) ⟹ `evp_real ≤ evp_teto`. Logo:
- `evp_teto ≤ 0` ⟹ `evp_real ≤ 0` — **não-positivo garantido** (sinal robusto, acionável).
- `evp_teto > 0` ⟹ `evp_real` indeterminado — **otimista** (não afirma valor).

⚠️ A invariante **só vale com alocação não-negativa**: se `receita_liquida < 0` ou `quantidade < 0` (devolução/ajuste), a perna presente aloca capital negativo, `encargo_parcial` fica < `encargo_real` e a monotonicidade quebra (achado Codex). Daí o guard de alocação abaixo.

## Decisão — Opção C (assimétrica) + agregado decomposto

Escolhida sobre B (null-total: joga fora o teto≤0, que é sinal preciso) e A (só UI: mantém número otimista no money-path). Refinada pelo `/codex consult`: **o maior risco não é a célula, é o rollup** — somar `{reais + tetos≤0}` excluindo os teto>0 omitidos não é nem teto nem piso, é **incompleto** ("mentira contábil"; sem o capital faltante não há lower bound). Logo o agregado é **decomposto**, não um número único.

### Por célula (`CelulaEVP`)

Campos novos/alterados (mantém `cm`, `a_cs`, `i_cs`, `encargo`, `ar_indisponivel`, `estoque_indisponivel`):
- `evp_teto: number | null` — `cm − encargo` (upper bound bruto; `null` se `cm`/`encargo` null ou não-finito). **Renomeia o "evp" antigo.**
- `capital_parcial: boolean` — `ar_indisponivel || estoque_indisponivel` (substitui o conceito de `evp_parcial`, agora desacoplado do sinal do evp).
- `evp: number | null` — o número **afirmável** (ver status).
- `evp_status: 'real' | 'teto_nao_positivo' | 'omitido_teto_positivo' | 'indisponivel_cm' | 'indisponivel_hurdle'`.

Regra (precedência):
```
alocacao_valida = receita_liquida≥0 finito && quantidade≥0 finito   (a_cs/i_cs já ≥0 pelos guards de capital)
if cm == null                                  → status='indisponivel_cm',        evp=null
else if encargo == null                        → status='indisponivel_hurdle',    evp=null  (k null)
else if !Number.isFinite(evp_teto)             → status='indisponivel_cm',         evp=null  (defesa)
else if !capital_parcial                       → status='real',                    evp=evp_teto
else if alocacao_valida && evp_teto <= 0       → status='teto_nao_positivo',       evp=evp_teto   (mantém: real ≤ teto ≤ 0)
else                                           → status='omitido_teto_positivo',   evp=null  (teto>0 OU alocação inválida)
```

### Por rollup (cliente/SKU)

- `evp: number | null` — Σ `cel.evp` afirmável (reais + teto≤0 mantidos); `null` se nenhuma afirmável. **NÃO inclui os omitidos.**
- `evp_teto: number | null` — Σ `cel.evp_teto` (upper bound do grupo; preserva o #961).
- `evp_incompleto: boolean` — ∃ célula `omitido_teto_positivo` (o `evp` do grupo exclui essa fatia → pode ser maior).
- `cm_incompleto: boolean` — ∃ célula sem custo (mantido).
- `encargo`, `encargo_total` — mantidos.

### Empresa (decomposta — não um número único)

- `evp_conhecido: number | null` — Σ células `real` (só capital completo).
- `evp_teto_total: number | null` — Σ `cel.evp_teto` (upper bound legado #961).
- `evp_perda_garantida: number | null` — Σ células `teto_nao_positivo` (piso de perda da fatia parcial-negativa).
- `evp: number | null` — `null` se há **qualquer** fatia não-afirmável (omitido OU cm ausente OU hurdle ausente); senão `evp_conhecido`. **Não finge ser total.**
- `evp_incompleto`, `cm_incompleto` — flags.

### Pcts de transparência (payload top-level, por RECEITA; denominador = receita total elegível)

Substitui `evp_teto_receita_pct` (cujo denominador "receita-com-evp" esconderia o problema quando `evp` vira null):
- `evp_conhecido_receita_pct`, `evp_omitido_otimista_receita_pct`, `evp_perda_garantida_receita_pct`, `sem_cm_receita_pct`.

### `scoreConfiancaCockpit`

Troca `evp_teto_receita_pct` por `evp_omitido_otimista_receita_pct`:
- `> 0,05` → rebaixa para **média** + motivo "X% da receita com EVP omitido (capital ausente; otimista, não medido)".
- `> 0` → motivo informativo.

### `recomendarAcaoComercial` (corrige a mentira do motivo)

Recebe `evp_incompleto` (omitido otimista no grupo) além de `cm_incompleto`/`hurdle_indisponivel`. `evpNegConhecido = evp != null && evp < 0` (agora inclui perdas garantidas — coerente). Motivos do "Cortar desconto" passam a distinguir:
- hurdle ausente → "lucro econômico indisponível (configure o hurdle)".
- `evp_incompleto` (sem evp<0 claro) → "valor econômico **não medido** em parte (capital ausente) — não confirmável" (NÃO "não gera valor").
- `cm` ausente → "margem indisponível em parte".
- `evp ≤ 0` conhecido → "o combo não gera valor".

"Crescer / proteger" só com `evp>0` afirmável **e** `!evp_incompleto && !cm_incompleto`; senão qualifica "provável, a confirmar". Alertas negativos (prazo/estoque) com `evpNegConhecido`.

## UI (`FinanceiroValorCockpit.tsx`) + tipo (`financeiroService.ts`)

Tipo passa a expor os campos novos. Tabela por cliente/SKU: coluna "Lucro econ." mostra `evp` afirmável; `evp_incompleto` → badge "parcial" + `evp_teto` como "(teto ≤ R$X)" secundário + tooltip "capital não medido em parte"; `evp==null` (tudo omitido) → "—" + badge. Sort por `evp` afirmável com desempate estável (receita) para os null. Cabeçalho: resumo conhecido / teto / perda-garantida / % omitido.

## Paridade

Helper TS puro (vitest) é a fonte; o edge replica VERBATIM a mesma lógica (Deno não importa de `src/`). TDD com **falsificação** (sabotar a regra → exigir vermelho). Conferir `montarCelulasComboEVP`/`recomendarAcaoComercial`/`scoreConfiancaCockpit` idênticos nos dois arquivos.

## Plano de teste (TDD, antes do código)

Asserts positivos E negativos, incluindo falsificação:
1. **Célula parcial teto>0 → evp null, status `omitido_teto_positivo`, evp_teto preservado** (o caso da Oben).
2. **Célula parcial teto≤0 → evp mantido, status `teto_nao_positivo`** (perda garantida).
3. **Célula completa → evp=evp_teto, status `real`** (inalterado).
4. **Guard alocação:** parcial + `receita_liquida<0` OU `quantidade<0` → evp null (`omitido_teto_positivo`), NÃO teto≤0 mantido (senão monotonicidade quebra).
5. **Rollup:** `evp` exclui omitidos; `evp_teto` inclui todos; `evp_incompleto` true; identidade `evp_teto` = Σ tetos.
6. **Empresa:** `evp=null` quando há omissão; `evp_conhecido`/`evp_teto_total`/`evp_perda_garantida` corretos; pcts por receita.
7. **Confiança:** `evp_omitido_otimista_receita_pct > 0,05` → média.
8. **Recomendação:** desconto alto + `evp_incompleto` → "Cortar desconto" com motivo "não medido" (NÃO "não gera valor"); "Crescer" não dispara com `evp_incompleto`; alerta negativo com perda garantida (evp<0).
9. **Falsificação:** sabotar (a) o sinal do teto (`<=0`→`>=0`), (b) o guard de alocação, (c) o limiar 5% → exigir vermelhos exatos; reverter → verde.
10. **k=null:** tudo `indisponivel_hurdle`, evp null, sem omissão/teto.

## Achados do `/codex challenge` no diff (incorporados, 2026-06-23)

3 achados, todos procedentes:
1. **[P1] Guard de DENOMINADOR.** O guard de alocação checava só o numerador (`receita/qtd ≥0`); faltava o **denominador** `rc > 0`/`qs > 0`. Com devolução/offset no mesmo cliente/SKU (`rc ≤ 0`), a perna vira "ausente" mas a fração de alocação `receita/rc` inverte de sinal → o teto≤0 mantido seria uma **perda fabricada**. Fix: exigir `rc>0`/`qs>0` no guard (helper+edge).
2. **[P1] Motivo combinado.** Em "Cortar desconto", `evpNegConhecido` tinha precedência sobre `evp_incompleto` → dizia "não gera valor" mesmo com fatia omitida (que pode ser positiva). Fix: motivo combinado "parte não medida (capital ausente); a parte medida não gera valor" quando ambos.
3. **[P2] `perda_garantida` no rollup.** A UI só sinalizava `evp_incompleto`; uma linha só com `teto_nao_positivo` aparecia como número exato (esconde que é teto, prejuízo real pode ser maior). Fix: flag `perda_garantida` no rollup + sufixo na UI.

## Escopo & deploy

MOTOR + recomendações + confiança + tipo front + UI. **Bônus 3-hurdles (25/30/35%): DEFERIDO** (Codex: "antes de mostrar três hurdles, conserte a semântica de um"). Deploy Lovable: **edge verbatim pelo chat** + **Publish** (mexe na UI). A4 não quebra (só lê `recomendacoesCliente`).
