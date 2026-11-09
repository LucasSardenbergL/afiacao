# Radar — "para visitar" no agregado por município (2026-11-09)

Fecha a lacuna que o pacote N deixou ([radar-desempenho-acabamento-pacote-n-2026-11-09.md](radar-desempenho-acabamento-pacote-n-2026-11-09.md)).
O chip "Para visitar" filtrava a fila, mas o mapa e o ranking não o aplicavam e só avisavam disso. O número do
chip desligado tinha sumido, porque o recorte vivo custa ~5,5 s. Migration `20261111160000_radar_agregado_visitar.sql`.
Merge ≠ produção: migration e Publish são do founder.

## O que mudou

1. **Dimensão `visitar boolean`** em `radar_agregado_municipio`, `_cnae` e `_cnae_sec`, escrita pelo único escritor
   (`radar_agregado_recalcular`) com a MESMA função da fila (`private.radar_contato_visitar`). A função só roda nos
   candidatos, que são o mesmo pré-corte da `radar_lista`: sinal em `radar_contato_contabil` ∪ correção positiva.
   Nenhuma regra foi reescrita, então não há um segundo lugar para divergir.
2. **Validade separada:** `radar_agregado_estado.visitar_calculado_em` (= `calculado_em` quando foi este código que
   escreveu) e `visitar_base_contabil`. `private.radar_agregado_visitar_em()` só devolve a data com
   `visitar_calculado_em = calculado_em` e o agregado válido. Um recálculo de código antigo (DR) grava `visitar` NULL. Sem a
   guarda, o filtro contaria ZERO; com ela, a dimensão fica indisponível.
3. **Frescor real ≠ "1 h":** o cron é horário, mas o recálculo só roda de fato 1×/dia (marco 06:35 UTC) ou quando o
   lote muda. E a contabilidade é recalculada às 06:50, DEPOIS do marco. Sem mudança, a dimensão ficaria até 24 h
   atrás da regra. Agora o recálculo roda também quando `radar_contato_contabil_estado.calculado_em` é mais novo que
   o lido (na prática 06:35 e 07:35 UTC). A correção do vendedor entra no próximo recálculo, e a tela diz de quando é a
   contagem.
4. **`radar_contagem_por_municipio`** (DROP + CREATE: assinatura nova, ACL reemitido nomeando os papéis):
   `p_so_visitar`, `p_municipio_codigo`, `p_so_agregado`. Devolve `para_visitar`, `para_visitar_total` (janela
   ANTES do LIMIT) e `visitar_contado_em`. Fora dos agregados (data mínima, data fora do corte, CNAE secundário não
   coberto, inéditos de outro lote) a resposta vem SEM o recorte e com `visitar_contado_em` NULL, e a tela mantém o
   aviso. Com `p_so_agregado`, esses recortes devolvem 0 linhas sem ler `radar_empresas`.
5. **Front:** mapa e ranking mandam `p_so_visitar` e mostram "Só os 'Para visitar', na contagem de DD/MM HH:MM"
   quando a resposta aplicou o recorte. O aviso "não aplica" só aparece quando ela não aplicou. O chip desligado
   voltou a ter número, lido do agregado (`p_limit` 1 + `p_so_agregado` + a cidade da fila), só quando o recorte da
   fila cabe nele: sem busca textual, sem "só sugeridos" e sem nome de cidade digitado sem código. O `title` do chip
   diz de quando é a contagem. O chip ligado segue contado na própria fila ("N+").

## Custo medido em prod (psql-ro)

- Recálculo atual: 3 min 30 s (`cron.job_run_details`, 04 a 09/11), dentro do `statement_timeout` de 15 min do cron.
- A regra nos candidatos, com o corpo de `radar_contato_visitar`/`avaliar` copiado (o `claude_ro` não executa
  `private.*`): **67.043 candidatos → 15.383 para visitar, 16,5 s** (EXPLAIN ANALYZE, hash join com 1 seq scan).
- Contagem: os agregados têm 21,7 mil / 108 mil / 138 mil linhas. O número do chip lê o agregado, não `radar_empresas`.
- **Pós-apply, medido em prod (psql-ro, 09/11):** 1º recálculo com a função de verdade (tick 22:35Z) `succeeded` em
  **2 min 27 s**; `para_visitar_total` = **15.383**, o mesmo número da simulação com a regra copiada.

## No ar (2026-11-09)

- PR #3769 mergeado às 17:58Z (`32ae4139a`).
- Migration aplicada pelo founder no SQL Editor, por volta das 22:25Z. A validação pelo psql-ro deu 7/7 ✅: colunas, assinatura
  nova (a velha caiu), md5 da contagem e do recálculo, ACL, `private.radar_agregado_visitar_em`, e a dimensão
  calculada no tick 22:35Z (`visitar_calculado_em = calculado_em`).
- Publish feito, conferido nos bytes de `steu.lovable.app`: `RadarClientes-KKe6YopJ.js` (antes `Ba2nq4St`) com
  `p_so_agregado` e "visitar-contado"; `RadarMapa-Bf0DUIDh.js` com "visitar-contado". Isso é disponibilidade, não
  adoção: o SW só troca quando o cliente clica.
- Ordem real: o Publish veio ~1 min antes do tick. Nesse intervalo a tela mostrou o aviso "não aplica" e o chip
  ficou sem número, como desenhado (ausente ≠ zero).
- No caminho, o `types.ts` regenerado pelo bot do Lovable (`0b5287a44`) quebrou o typecheck da main. A #3770
  consertou; este PR só precisou de rebase.

## Provas

- PG17 `db/test-radar-agregado-visitar.sh` (55 asserts, no núcleo do CI): corpos de prod como fixture (md5), apply
  2×, oráculo linha a linha em 14 recortes, indisponível ≠ 0 (antes do tick e depois do código velho), recálculo por
  contabilidade nova, `p_so_agregado` com 0 leituras (e o medidor com dente), total antes do LIMIT, PRE anti-deriva,
  ACL. `--falsificar`: 11/11 sabotagens vermelhas no assert certo, com o controle verde, nos dois locales
  (`C` e `pt_BR.UTF-8`).
- vitest: `para-visitar-contagem.test.ts` (cabe/total/rótulo/dica/aplicado), `useRadarContagemMunicipios.visitar.test.tsx`
  (forma da chamada), `RadarRankingCidades.estados.test.tsx` (avisos). Falsificação do front: 6/6 vermelhas, com controle.

## Lição

"Staleness de 1 h, o cron é horário" estava errado. O cron horário era um no-op 23 vezes por dia (o recálculo tem
marco diário), e a fonte da dimensão nova é recalculada DEPOIS do marco. Antes de prometer frescor de um agregado,
leia o gate de "já calculado" do escritor e o horário de cada fonte que ele lê.
