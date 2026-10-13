# Encargo recebido por título (juros/multa/desconto) — 2026-10-13

> Migration `20261013094000_fin_movimentacoes_resumo_encargos.sql` · view `v_titulo_encargos_cr` · edge `omie-financeiro` v1.4 (`resumo-movimento.ts`) · prova `db/test-fin-encargos-titulo.sh` (47 asserts, 19 sabotagens). Lição curta em `docs/agent/financeiro.md` §"Encargo recebido".

## A pergunta

O grupo cobra 2% de multa + 10% a.m. de juros (pro rata, carência de 3 dias) nos boletos das 3 empresas. Quanto disso entra, por título? Uma medição anterior (44% de captura / −R$ 84,6k) foi **retratada**: somava `fin_movimentacoes` por título, e isso soma versões e marcadores zerados.

## Causas medidas (psql-ro, 2026-10-13)

1. **"Recebimento duplicado" = versões do título.** `omie_ncodmov` é hash FNV de ~22 campos, incluindo campos mutáveis (cStatus, dDtPagamento, nº da NF, valores do resumo). Título que muda no Omie vira linha nova; a velha fica com `updated_at` congelado. 2.591 de 16.443 títulos têm >1 linha `CONTA_A_RECEBER`. Dos 5.234 pares versão-velha × atual, **5.231** nunca tiveram a velha tocada depois que a atual nasceu, inclusive 2.362 dentro da janela incremental (seriam revisitadas se o Omie as devolvesse). As 3 exceções são **baixa cancelada e refeita**: o título volta a ATRASADO por dias e depois a RECEBIDO com o mesmo hash. Exemplo de versão: 12067405417, baixado em 27/04 com desconto de 3.344,27 e, na versão seguinte, sem desconto e com uma baixa CC extra de 3.344,27.
2. **"CC 0,00" = marcador de inclusão.** `CONTA_CORRENTE_REC` com cOrigem APIR/MANR/VENR/DEVR/RPTR/'' é 0 em 3.146/3.146 linhas. Caixa é BAXR/APBR, nunca 0.
3. **Baixa cancelada fica no espelho:** 12097272930 está ATRASADO e a BAXR de 1.195,75 segue em `fin_movimentacoes`. As BAXR também têm 4 pares de versões.
4. **O resumo fecha:** `nValLiquido = nValPago − nDesconto + nJuros + nMulta` e `nValPago + nValAberto = nValorTitulo` (172/172). Soma BAXR/APBR = `nValLiquido` em 15/15.
5. **Multa vem dentro de `nJuros`:** 165,00 com 5 dias de atraso → 6,05 = 2%·165 + 10%·165·5/30; 454,00 com 13 dias → 28,75.
6. **Data:** a ótica do título carrega a BAIXA; a CC, a liquidação (+1 dia útil), já medido em `20260909074613`.

## O que entrou

- 13 colunas tipadas em `fin_movimentacoes` (`resumo_*`, `valor_titulo`, `tipo_documento`, `omie_ncodbaixa`, `data_pagamento_omie`, `data_credito_omie`, `resumo_lido_em`), sem DEFAULT, com CHECK de finitude. O writer (`resumo-movimento.ts`) converte com fail-closed: ausente, não-número, não-finito, fora do typmod ou data fora do calendário viram `null`, e nunca derrubam a página.
- `v_titulo_encargos_cr` (security_invoker, sem anon): versão atual por última observação **dentro do título**; baixa velha descartada só quando há linha mais nova com o mesmo conteúdo e sem nCodBaixa distinto; confiança `alta | erp_sem_caixa | erp_nao_quitado | divergente | inconsistente | so_diferenca_caixa | sem_dado`. `encargo_recebido` só sai quando nenhuma evidência o contradiz.

## O que ficou de fora (decidido)

- **Trocar a chave do hash.** O hash não inclui nCodBaixa, então duas baixas legítimas idênticas colapsam antes do banco (achado Codex). Trocar recriaria ~60k linhas e dobraria as somas de `v_titulo_baixas`/fluxo realizado/conciliação. Efeito hoje: caixa < líquido → `divergente`, nunca `alta`.
- **Vigência provada.** "Última observação" não prova que a versão ainda vale: uma versão nova fora da janela de 3 meses só entra no próximo backfill.

## 2ª opinião

Codex (gpt-6-astra, xhigh) em duas rodadas: metodologia (`logs/encargos/codex-consult-1.out` no worktree; achados no corpo do PR) e challenge do código. A 1ª mudou o desenho: confiança `media` virou `divergente`/`erp_sem_caixa`, a derivação virou `diferenca_caixa_documento` e o atraso passou a usar a data do título.

## Leitura provisória (pré-backfill)

Ver o corpo do PR: classificação dos títulos atrasados de liquidação única por "cobrado conforme a política / não cobrado / parcial / desconto". A política bate **ao centavo** nos casos cobrados, o que valida a fórmula e a data. O número definitivo, com filtro de boleto e desconto separado do encargo, sai depois do backfill.

## Resposta medida (pós-backfill, 2026-10-13 16:32Z)

Deploy: migration aplicada pelo `db:aplicar` (recibo #413), edge v1.4 pelo conector Lovable (sonda `DEPLOY CONFIRMADO`, fonte = main), backfill desde 2020 (recibos #420/#421) concluído nas 3 empresas às 16:31Z. Cobertura da view nos boletos atrasados: **100% em confiança que expõe encargo** (nenhum `divergente`/`sem_dado`).

Recorte: `tipo_documento='BOL'`, baixa nos 12 meses, atraso > 3 dias, devido = documento × (2% + 10% × dias/30), atraso pela `dDtPagamento` do título. Query: `db/consulta-encargos-boleto-12m.sql` (read-only, roda no psql-ro).

| CNPJ | boletos | devido | recebido | % | conforme | não cobrado (devido) | parcial (faltou) | desconto em pago atrasado |
|---|---|---|---|---|---|---|---|---|
| oben | 512 | R$ 24.909,50 | R$ 20.009,33 | **80,3%** | 378 | 47 (R$ 4.138,99) | 87 (R$ 731,86) | 1 · R$ 2,40 |
| colacor | 110 | R$ 2.709,37 | R$ 2.063,75 | **76,2%** | 88 | 9 (R$ 621,00) | 13 (R$ 19,67) | 0 |
| colacor_sc | 38 | R$ 631,71 | R$ 555,11 | **87,9%** | 32 | 5 (R$ 75,90) | 1 (R$ 0,27) | 0 |

**Fora do núcleo, separados de propósito:**
- **Baixa sem caixa** (líquido 0, o "desconto" é 100% do documento — abatimento/perdão/compensação, não desconto comercial): oben 67 títulos · R$ 39.278,82; colacor_sc 4 · R$ 1.027,57; colacor 1 · R$ 307,00. Somá-los como "desconto concedido" inventaria uma política de desconto que não existe.
- **Atraso > 180 dias** (cobrança/renegociação; a política linear daria 347% do principal): colacor 1 título de R$ 920 (vencido em 2023).

**Leitura:** onde há encargo, ele bate com a política ao centavo (378+88+32 títulos). A perda é **não cobrar** (61 títulos) e, na oben, as 67 baixas sem caixa de boletos atrasados — que pedem leitura humana (devolução? acordo?). A medição retratada (44% / −R$ 84,6k) misturava versões, CC zerado, todos os meios de pagamento, liquidação CC como data e baixas sem caixa.

## DRE caixa da colacor 2026 (pedido do founder, 2026-10-13)

Primeira gravação (não havia snapshot caixa da colacor em ano nenhum; nenhum mês de 2026 fechado). `db/2026-10-13-dre-caixa-colacor-2026.sql` (recibo #424, trava que recusa durante backfill — provada) gravou jan–jul e a edge foi cortada no wall-clock (~27 s/mês × 10 meses passa do teto pós-desconexão); `…-meses-8-10.sql` (recibo #426) fechou ago–out. Log `complete` 16:53Z.

⚠️ **O número NÃO é receita da colacor:** R$ 567,7k de receita bruta caixa em jan–out contra ~R$ 17,8M/ano na fonte canônica (`fin_dre_competencia_base`, `docs/agent/financeiro.md`). Cada mês acusa 11–24 categorias **sem mapeamento** (`fin_categoria_dre_mapping`), e o competência gravado em maio tem a mesma escala ⇒ defeito ANTERIOR do motor de snapshot para a colacor, não efeito do backfill. Não usar `fin_dre_snapshots` da colacor para decisão até o mapeamento ser completado.

