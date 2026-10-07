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
- Os 5% a menos da NF no PO 1238 (06/10): **promoção para quem bate o volume do trimestre**. O PO segue o portal; a
  diferença vai para a conferência NF↔PO (D4'), que tem de reconhecê-la como desconto de volume.

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

## No ar (2026-10-07, pela sessão, autorizada pelo founder)

- **Migration** aplicada pelo MCP `query_database` às 00:52Z, no envelope de `docs/agent/database.md` §Escrita:
  - pré-voo `psql-ro` 🟢: o corpo da RPC em prod era byte a byte o da `20260906193522`, e nada da migration nova existia;
  - ensaio com `RAISE EXCEPTION 'ENSAIO_OK…'` (rollback conferido por fora);
  - no apply, a postcondição da migration e mais uma guarda de transcrição: o md5 dos 2 corpos, das 13 alíquotas e
    dos 5 CHECKs, calculados por um PG17 local a partir dos bytes do arquivo;
  - 2ª testemunha `psql-ro`: 10/10.
- **Edges** pelo pacote `91e529ae290c` (`origin/main@e18806c54`, pré-condição de banco satisfeita):
  - foram `disparar-pedidos-aprovados` v1.5, `enviar-pedido-portal-sayerlack` v1.10 e `omie-sync-estoque` v1.6 (esta
    de outra entrega, autorizada junto);
  - o Lovable conferiu os 26 hashes e deixou as 3 Active;
  - sonda `db/sonda-pos-deploy-disparar-enviar-sayerlack-omie-sync-estoque-2026-10-07.sql` (recibo #265): **DEPLOY
    CONFIRMADO** nas 3;
  - `pendencias:deploy` saiu 0, com 62/62 edges.
- **Sensor de edição do Lovable:** deu `EDICAO_DETECTADA`, porque a resposta trouxe `edit_id`/`commit_sha` e o commit
  ainda não estava na main. Conferido à mão: o commit do bot (`d0d43894`, em `origin/lovable-sync`) parte de
  `e18806c54` e muda só `src/integrations/supabase/types.ts` (+47, os tipos da migration) — o caso tolerado, nenhuma
  edge tocada.
- **Antes** (envios Sayerlack com protocolo desde 06/09): 26 `checksum_divergente` (captura cega por causa do IPI) e 5
  `json_total_unico` (1 item, IPI embutido no unitário). **Depois:** a medir no próximo envio, com as queries abaixo.

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
