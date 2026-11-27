# Pendências técnicas da DRE/DFC (mapa próprio) — 2026-11-26/27

Origem: §Pendências de [dfc-realizado-mapa-proprio.md](dfc-realizado-mapa-proprio.md). Uma fatia por PR, money-path:
Codex em 2 consultas (desenho + código), prova PG17 com falsificação em `C` e `pt_BR.UTF-8`, camadas por fora.

| # | Item | PR | Camadas | Estado |
|---|---|---|---|---|
| 1 | Ingestão colapsava baixas iguais | #4247 | migration `20261127000000` (recibo #1512) · edge `omie-financeiro` v1.16 · backfill `db/2026-11-27-backfill-movimentos-chave-ncodbaixa.sql` | migration + edge no ar; backfill colacor_sc ✅ e oben ✅; colacor em curso (recibo #1540) |
| 2 | Baixa cancelada contava como caixa no DFC | #4252 | migration `20261127003000` (recibo #1513) · Publish | ✅ no ar (bytes do Publish conferidos) |
| 3 | Projeção A1 rotular pelo mapa de fluxo | — | — | não iniciado (esperou #4237 na mesma edge) |
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
  - colacor: foi pulada no 1º disparo (cursor pendente) e re-disparada pela variante re-rodável `db/2026-11-27-backfill-movimentos-chave-ncodbaixa-colacor.sql` (recibo #1540). Faltam medir os títulos `4239145638` e `4265682768` quando o cursor dela voltar a NULL.
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

## 5 — CMV de novembro
CMV competência = compras do CP (`2.01.01`) por emissão, sem variação de estoque.
- oben nov = R$ 54,6k. No mesmo ponto do mês (visto até o dia 26), ago–out tinham R$ 115–167k.
- Fonte independente `nfe_recebimentos`: nov R$ 57,5k × out R$ 260,9k.
- ⇒ compra menor + mês aberto. A margem de 76,5% vem do método, não é bug.
