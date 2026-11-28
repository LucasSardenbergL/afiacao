# Pendências técnicas da DRE/DFC (mapa próprio) — 2026-11-26/27

Origem: §Pendências de [dfc-realizado-mapa-proprio.md](dfc-realizado-mapa-proprio.md). Uma fatia por PR, money-path:
Codex em 2 consultas (desenho + código), prova PG17 com falsificação em `C` e `pt_BR.UTF-8`, camadas por fora.

| # | Item | PR | Camadas | Estado |
|---|---|---|---|---|
| 1 | Ingestão colapsava baixas iguais | #4247 | migration `20261127000000` (recibo #1512) · edge `omie-financeiro` v1.16 · backfill `db/2026-11-27-backfill-movimentos-chave-ncodbaixa.sql` | ✅ no ar; backfill das 3 empresas concluído; os 3 títulos fecham |
| 2 | Baixa cancelada contava como caixa no DFC | #4252 | migration `20261127003000` (recibo #1513) · Publish | ✅ no ar (bytes do Publish conferidos) |
| 3 | Projeção A1 rotular pelo mapa de fluxo | #4289 | edge `fin-cashflow-engine` v2.8 (deploy 2026-11-28, 21/21 hashes) | ✅ no ar; sonda por cron atesta |
| 4 | Locale da prova da DRE | #4238 | só teste | ✅ |
| 5 | CMV nov/2026 baixo | — | — | ✅ investigado: não é defeito |

## 1 — chave da baixa = -nCodBaixa
- **Defeito:** `omie_ncodmov` era o hash FNV de ~22 campos SEM `nCodBaixa`. Duas baixas legítimas (mesmo título/conta/dia/valor) viravam uma.
- **Medido (psql-ro):** `nCodBaixa` só existe na ótica CC (63.202 linhas) e é único por (company, id), exceto 4 pares de versões na oben. Na assinatura do colapso (soma CC < líquido vigente) estão 3 títulos, R$ 18.562,47: colacor `4239145638` (2×62,47), colacor `4265682768` (10×2.000) e oben `12073968089` (falta 500). Os outros 58k títulos fecham exatamente.
- **Desenho:**
  - chave `-nCodBaixa` (espaço negativo, disjunto do hash ≥ 0);
  - `nCodBaixa` presente e inválido LANÇA;
  - chave e sensor só sobre o que será gravado (depois da janela);
  - linha legada (hash, sem id) da mesma baixa é re-chaveada no lugar.
- **Migration:** nada apagado. Renomeia uma linha por baixa; as 4 versões ficam congeladas, e removê-las é decisão do founder. O CHECK `NOT VALID` com os dois estados é também a guarda da janela de deploy (a edge velha é recusada, não duplica).
- **Validado por fora** (psql-ro após o recibo): 63.198 negativas + 4 congeladas; 0 baixa sem exatamente 1 negativa; CHECK presente.
- **Backfill (2026-11-27):**
  - colacor_sc: 5.075 relidos, 0 colapsos.
  - oben: o sensor achou 1 colapso na 1ª execução. Medido depois: o título `12073968089` **fecha** (500 + 500 + 260,90 = 1.260,90 = líquido).
  - colacor: foi pulada no 1º disparo (cursor pendente) e re-disparada pela variante re-rodável `db/2026-11-27-backfill-movimentos-chave-ncodbaixa-colacor.sql` (recibo #1540). Concluído em 2026-11-27 ~23h UTC.
  - **Medição final (psql-ro):**
    - `4239145638`: 2 × 62,47 = 124,94.
    - `4265682768`: 10 × 2.000 = 20.000.
    - `12073968089`: 1.260,90.
    - Todos fecham com o líquido: **R$ 18.562,47 recuperados**.
  - No universo inteiro, **0 título com soma CC < líquido** (antes eram 3).
  - Excesso CR: 12 → 15 títulos (+R$ 2,1k), o caso que o `pendente_conciliacao` do item 2 segrega quando há ≥ 2 baixas. Excesso CP: 13, sem mudança.
  - 63.277 chaves negativas + 4 versões congeladas.
- **Lições:** psql em pt_BR escreve `ERRO:` (captura SQLSTATE com `VERBOSITY=sqlstate`; o 2º locale pegou). `LOCK TABLE` exige a transação do `db:aplicar`.

## 2 — `pendente_conciliacao` no DFC
- **Regra** (o Codex barrou um balde "cancelada": a evidência não prova cancelamento). Cada baixa BAXR/BAXP/APBR é conciliada com a última RELEITURA do título (mesmo sentido); a soma é do título no histórico inteiro, depois da dedup e dos `pendente_*`:
  - pago 0 → pendente;
  - ≥ 2 baixas com soma > líquido + 0,01 → todas pendentes;
  - sem título e CC nunca relida → pendente;
  - 1 baixa acima do líquido (juros/multa CP, 9 títulos medidos) conta;
  - soma abaixo do líquido conta.
- A vencedora por `nCodBaixa` prioriza a chave negativa. No front, o balde é próprio em `FORA_DAS_ATIVIDADES`.
- **Impacto medido antes de aplicar:** oben 50 eventos (R$ 128.875,51) e colacor 3 eventos (R$ 2.954,43) saem das atividades, visíveis. Inclui `12097272930`.

## 3 — `fluxo_linha` na projeção de 13 semanas
- **Medido:** a projeção NÃO agrupava por categoria. O único código cru era `desc` das linhas `cp_omie`, e nenhuma tela o lê.
- **Decisão do founder:** só a edge, sem tela nova.
- **O que mudou:** cada linha `cr_omie`/`cp_omie` ganha `fluxo_linha` do mesmo mapa do DFC.
  - ausente/espaços ⇒ null
  - fora do mapa ⇒ `nao_classificado`
  - comparação exata do código, como o PCO e o DFC
  - valores, NCG e PCO idênticos
- **Prod:** 100% do CR/CP aberto está no mapa.
- **Prova:** Deno 96/96 e 4 sabotagens vermelhas, com controle verde antes e depois. `sem-codex` (cota 100% até 02/12): substituído por revisão adversarial independente (0 P1/P2, 3 nits corrigidos).
- **Lições:**
  - `$T` com espaços no zsh não é quebrado em palavras ⇒ exit 127 em TODAS as rodadas. O controle vermelho pegou.
  - `sed` que não casa (recuo diferente) produz "sabotagem" verde ⇒ exigir `cmp` antes de rodar.
  - `git checkout --` de sabotagem desfaz correção NÃO commitada ⇒ commitar antes de falsificar (de novo).

## 5 — CMV de novembro
CMV competência = compras do CP (`2.01.01`) por emissão, sem variação de estoque.
- oben nov = R$ 54,6k. No mesmo ponto do mês (visto até o dia 26), ago–out tinham R$ 115–167k.
- Fonte independente `nfe_recebimentos`: nov R$ 57,5k × out R$ 260,9k.
- ⇒ compra menor + mês aberto. A margem de 76,5% vem do método, não é bug.

## ⚠️ Atropelo do #4247 (achado no /fecho, 2026-11-28)
O squash do item 1 foi feito com `git rebase origin/main` (saída engolida pelo `| tail`) seguido de
`git reset --soft origin/main`. O rebase NÃO tinha aplicado, e o reset sobre a main NOVA deixou no índice
a árvore da branch VELHA. O commit levou **27 arquivos** em vez de 6: ressuscitou a edge `omie-os-sync` e
a migration `20261126233000_omie_os_espelho` (revertidas no #4241, "opção C cancelada") e apagou
`20261126235000_caca_candidatos…`, entre outros.
- **Consertado** por outra sessão em `5bc4349f3`. O diff entre a main de antes do merge e `5bc4349f3` é
  vazio nos arquivos de terceiros.
- **Prod intacta:** sem `omie_os_espelho`, sem função `omie_os*`, sem recibo; `deriva:corpo:prod` verde (685).
- **Regra para squash por `reset --soft`:** só depois de um rebase CONFIRMADO, e conferindo
  `git diff --stat origin/main` ANTES de commitar. Lista com arquivo que não é seu = pare. No item 2 o
  mesmo erro foi pego a tempo por essa conferência; no item 1, não.
