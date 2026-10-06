# Preço exato no PO Sayerlack: a "divergência aberta" era o IPI por NCM

> Entrega de 2026-10-05/06. Spec: [2026-10-05-preco-exato-po-sayerlack-design.md](../superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md).

## O defeito (medido)

- O PO nascia com o preço do motor (CMC ou média histórica) e `nValorIpi = 0`; na NF 000953881 o unitário do PO errou
  de −18,2% a +9,7%.
- A captura do portal falhou fechado em 24 de 28 pedidos desde 06/09 (`checksum_divergente`): o portal cobra a soma
  das linhas MAIS o IPI. O pedido de 1 item passava, mas embutia o IPI no `nValUnit`.

## A prova

- Backtest sobre os 29 pedidos com protocolo (DOM + `data.value` + NCM do cadastro): o modelo da NF-e (linha e IPI
  arredondados por item) fecha 29/29 em ≤ R$ 0,02 com 13 alíquotas; trocar qualquer uma pela vizinha erra ≥ R$ 4,87
  (2922.19.19: R$ 0,18, 1 linha). Nenhuma regra de arredondamento reproduz o portal exato — a tolerância é derivada.
- Em ponto flutuante, `round2(round2(pv) × alíq)` erra 1 centavo nas fronteiras de meio centavo (76 entre R$ 0,01 e
  R$ 2.000 nas 3 alíquotas) — por isso o IPI é calculado em centavos inteiros na edge e a RPC exige igualdade.
- Arquivo-ouro: `db/fixtures/sayerlack-ipi-backtest-20261005.json`, conferido pelo vitest (TS) e pelo PG17 (SQL).

## Decisões do founder

- `preco_unitario`/`valor_linha` seguem como custo com IPI; a decomposição vai em colunas novas que o PO usa.
- A tabela nasce com as 13 alíquotas medidas (4 confirmadas pela NF 000953881).
- Codex: o desenho foi pelo Caminho B (cota em 92%, exit 79); o adversarial de código rodou com o teto furado.

## O que o adversarial pegou (Codex REPROVADO + revisor final)

- **A RPC relia as alíquotas** em cada comando (CP006, CP007, UPDATE): sob READ COMMITTED, uma alíquota ou NCM alterados
  no meio gravariam um IPI que a prova não validou. Agora uma leitura só, materializada (prova PG17 `LU1`).
- **O PO decidia item a item:** decomposição parcial misturava regimes, e quantidade editada depois da captura deixava o
  IPI da LINHA velho (2 → 4 unidades: R$ 881,49 no PO contra R$ 909,24 de custo). Agora o PO usa a decomposição só com o
  pedido inteiro coerente com `valor_linha`; senão, o PO de hoje para todos.
- **Testes que passavam por ausência:** o assert numérico aceitava NaN, e nada travava o `select("*")` do disparo.
  Corrigidos, com sabotagem que morde.
- **Ficou como risco residual** (spec §9): a corrida captura → PO, pré-existente desde a v2 do CAS — o cron do disparo
  roda 1× por dia e o desfecho é o PO de hoje, nunca número fabricado.

## Implantação (founder)

1. Migration `20261006120000_preco_exato_po_sayerlack_ipi.sql` no SQL Editor (ou envelope da sessão).
2. Edges que `bun run pendencias:deploy` apontar: `disparar-pedidos-aprovados` (v1.5) e
   `enviar-pedido-portal-sayerlack` (v1.10). Antes: `git log -S montarProdutosIncluir -- supabase/functions/disparar-pedidos-aprovados/index.ts`
   e `git log -S sayerlack_ipi_itens -- supabase/functions/enviar-pedido-portal-sayerlack/index.ts` na main.
3. 1º PO real com `nValorIpi`: combinado com o founder — conferir `nValorIpi > 0` e `nValTot` do Omie = `valor_total`
   (± tolerância), o que pega o Omie tratando `nValorIpi` como valor por unidade ou recalculando o IPI pelo cadastro.

## Como medir (rode com `psql-ro`)

```sql
-- captura por fonte/motivo desde o deploy (esperado: fonte dom_checksum com motivo nulo; ja_tem_omie = PO que já existia, à parte)
SELECT s.portal_resposta->'captura_custo'->>'fonte' AS fonte, s.portal_resposta->'captura_custo'->>'motivo' AS motivo,
       count(*) FROM pedido_compra_sugerido s
 WHERE s.enviado_portal_em >= '<instante do deploy>' AND s.portal_protocolo IS NOT NULL GROUP BY 1, 2;
-- NCMs a cadastrar (captura cega por alíquota)
SELECT DISTINCT jsonb_array_elements_text(s.portal_resposta->'captura_custo'->'ncm_sem_aliquota') AS ncm
  FROM pedido_compra_sugerido s WHERE s.portal_resposta->'captura_custo'->>'motivo' = 'ipi_ncm_desconhecido';
-- decomposição gravada
SELECT i.pedido_id, count(*) AS itens, count(i.valor_ipi_portal) AS com_ipi, sum(i.valor_ipi_portal) AS ipi
  FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id = i.pedido_id
 WHERE s.enviado_portal_em >= '<instante do deploy>' GROUP BY 1 ORDER BY 1 DESC LIMIT 10;
```
