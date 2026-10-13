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
