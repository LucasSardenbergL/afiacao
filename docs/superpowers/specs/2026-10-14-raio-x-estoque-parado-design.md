# Raio-X do estoque parado — faxina (fase A) — design

**Data:** 2026-10-14 · **Status:** design aprovado em chat (seções 1–4), aguardando revisão da spec
**Contexto:** projeto 1 de 3 do programa "ciclo financeiro de compras" (2 = orçamento de compra; 3 = previsão TSB). CCC medido ≈ 102 dias; a alavanca grande é **DIO** (cada dia ≈ R$ 6,3k de caixa), não DPO (boleto 7d Sayerlack já é ótimo).

## 1. Objetivo e critério de sucesso

Transformar o estoque parado/em excesso da **Oben** em decisão por SKU e, dessas decisões, em **caixa liberado** — sem tocar o app, o banco nem o Omie.

- **Faxina primeiro (A), ferramenta permanente depois (B).** As decisões manuais desta fase viram as regras e a carga inicial de B.
- **Meta (6 semanas após publicar):** 100% do Top 61 (por R$) decidido **e** ≥ R$ 60k liberados (vendido a CMC + crédito de troca usado).
- **Portão para B:** só começa com esse sinal **medido** (query da §6), não com "ninguém reclamou".

### Fora de escopo (YAGNI)
Escrita no Omie ou no app · migration/tabela/edge · preço de liquidação sugerido · estoque Colacor · notificação automática.

## 2. Diagnóstico de partida (retrato 2026-10-14, psql-ro)

Universo: conta `oben`, saldo > 0, CMC > 0, e (fora do motor **ou** sem venda em 12m **ou** cobertura > 180d) → **~611 SKUs, R$ 341k**.

| Categoria | SKUs | R$ | Tratamento |
|---|---:|---:|---|
| Mercadoria | 495 | 246k | aba 1 — destino por SKU |
| Não-mercadoria (espectrofotômetro, máquina Bio-Chem, software, mostruário, cartela) | 17 | 66k | aba 2 — reclassificar com contador (corrige DIO, **não** é caixa) |
| Insumo de máquina (Concentrados MixMachine; ATL/ATP da família Concentrados LC — 2ª máquina, consumo não registrado) | 97 | 26k | aba 2 — contagem física (risco de estoque fantasma) |
| Granel p/ fracionar (1.000 kg) | 2 | 5k | aba 2 — contagem física |

Fatos de domínio confirmados pelo founder (2026-10-14):
- ATL/ATP "poliéster liso" são concentrados de uma **segunda máquina em uso**; o consumo não é registrado.
- Granel 1.000 kg é **envasado aqui** (insumo de fracionamento).
- O resto da família "Concentrados LC" (primer, verniz, endurecedor, catalisador) é **mercadoria para vender**.
- **Sayerlack aceita troca** por crédito no próximo pedido.

Limites do dado: histórico de venda (NF) começa em **2025-10-21** (12 meses) → "sem venda **em 12 meses**", nunca "nunca vendeu". NF de entrada (`nfe_recebimentos`) só existe a partir de 2026-10 → fornecedor desconhecido para ~R$ 145k da mercadoria. Os 61 SKUs de maior valor = R$ 184k (54%).

## 3. Dados e classificação

**Fontes (read-only, `~/.config/afiacao/psql-ro`):** `inventory_position` (account `oben`) · `v_venda_items_history_efetivo` (empresa `OBEN`) · `sku_parametros` (empresa `OBEN`) · `omie_products` (account `oben`) · `nfe_recebimento_itens`+`nfe_recebimentos`.

**Por SKU:** código, descrição, família, ativo, fornecedor (`sku_parametros.fornecedor_nome` → emitente da última NF de entrada → `?`), saldo, CMC, valor, no motor (s/n), classe ABC, última venda, qtd 12m, nº clientes, cobertura (dias = saldo ÷ (qtd12m/365)), **top 5 clientes compradores** (razão social, última compra, qtd), categoria + motivo, destino sugerido + motivo.

**CMC ausente/zero:** fora da lista avaliada; contados numa linha "sem custo — não avaliado" (ausente ≠ zero).

**Categoria** (por família + padrão de descrição; o motivo é exibido e a página permite reclassificar):
1. `nao_mercadoria`: família `Imobilizado` ou descrição `MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY`
2. `insumo_maquina`: família `Concentrados MixMachine`, ou família `Concentrados LC` com descrição `^AT[LP]`
3. `granel`: descrição `1000 ?KG`
4. `mercadoria`: o resto

**Destino sugerido** (só mercadoria; avaliado na ordem, 1ª regra que casa vence):

| # | Condição | Sugestão |
|---|---|---|
| 0 | cadastro **ou** entrada < 90 dias | `novo_aguarde` |
| 0b | unidade da venda ≠ unidade do estoque | `revisar` (cobertura "não confiável") |
| 1 | fornecedor casa `sayerlack` (sem caixa) e 0 vendas em 12m | `trocar` |
| 2 | vendeu em 12m e cobertura > 365d | `venda_dirigida` (há compradores a quem dirigir) |
| 3 | vendeu em 12m e cobertura 180–365d | `manter_suspender_recompra` |
| 4 | outro fornecedor (ou `?`) e 0 vendas em 12m | `liquidar` (sem comprador a quem dirigir; motivo pede ao founder o fornecedor se houver chance de troca → vira `trocar`) |

Regra 0 por entrada só enxerga NFs desde 2026-10 (início de `nfe_recebimentos`); antes disso vale a data de cadastro do produto.

Destinos possíveis na decisão: `trocar` · `venda_dirigida` · `liquidar` · `manter_suspender_recompra` · `estrategico` · `erro_cadastro`. **A sugestão só pré-seleciona; nada conta como decidido sem o toque humano.**

## 4. A página (Artifact privado, interativo)

- **Placar (topo):** R$ decidido / R$ total + barra; R$ por destino; selo **Top 61**.
- **Aba 1 — Mercadoria:** cards ordenados por R$ (mobile-first); filtros destino sugerido · fornecedor · pendente/decidido · Top 61. Card: descrição, família, fornecedor, saldo, valor, última venda, cobertura, motivo. Expandir → clientes compradores. Decisão = 1 toque + observação opcional + fornecedor editável quando `?`. Cards `trocar` decididos ganham "troca concluída: crédito R$".
- **Aba 2 — Contagem física & reclassificação:** não-mercadoria, insumo de máquina, granel. Campo "quantidade contada" → diferença vs Omie (un e R$). Não-mercadoria marcado "reclassificar com contador".
- **Saídas:** lista de troca Sayerlack (SKU, código, qtd, R$ — o founder envia ao representante; Claude não envia nada) · lista de venda dirigida **agrupada por cliente**.
- **Usuários:** founder + comprador; cada decisão grava quem e quando.

## 5. Armazenamento

- **Retrato** embutido na página (JSON datado). Republicar com retrato novo **não** apaga decisões.
- **Decisões e contagens** no banco compartilhado do Artifact (capability `db`), 1 documento por SKU: `destino`, `observacao`, `fornecedor_informado`, `credito_troca`, `qtd_contada`, `decidido_por`, `decidido_em`. Leitura por Claude via `ArtifactData`.
- Sem Supabase: é dado transitório da faxina; na fase B vira carga inicial.

## 6. Medição (T+4 a T+6 semanas, mesma query, read-only)

Para cada SKU do retrato: Δ saldo valorizado pelo **CMC do retrato**, decomposto em:
- **vendido** — NFs do período (receita e margem);
- **trocado** — `credito_troca` informado na página;
- **liquidado** — NF com preço abaixo do praticado nos 12m (mostra margem sacrificada);
- **continua parado** — saldo restante.

**Alerta de contradição:** SKU decidido `trocar`/`liquidar`/`manter_suspender_recompra` presente em `pedido_compra_item` criado após a decisão.

**Duas contas, nunca somadas:** caixa liberado (vendido + crédito usado) ≠ DIO corrigido pela reclassificação de não-mercadoria (R$ 66k, sem caixa).

## 7. Armadilhas e validação

**Pré-voo (falhou → não publica):**
- `max(inventory_position.synced_at)` da conta `oben` < 24h.
- Só account `oben` (`vendas` duplica a Oben).
- Unidade venda ≠ estoque → regra 0b.

**Validação do retrato:** totais por categoria batem o diagnóstico (R$ 341k / ~611 SKUs; desvio > 2% → explicar antes de publicar); 10 SKUs do Top 61 conferidos contra o banco; 3 entregues ao founder para bater no Omie.

**Teste da página:** desktop + celular no navegador do app; decidir → recarregar → persiste; placar = soma dos cards; gerar as duas listas e conferir 1 linha de cada; desfazer decisões de teste antes de entregar.

## Apêndice A — SQL base do retrato (ponto de partida; o plano o completa com unidades, top clientes e datas de cadastro)

```sql
with e as (
 select ip.omie_codigo_produto::bigint sku, ip.saldo, ip.cmc, ip.saldo*ip.cmc val
 from inventory_position ip where ip.account='oben' and ip.saldo>0 and ip.cmc>0),
v as (select sku_codigo_omie sku, max(data_emissao) uv, sum(quantidade) q12,
             count(distinct cliente_codigo_omie) ncli
      from v_venda_items_history_efetivo where empresa='OBEN' group by 1),
base as (
 select e.*, sp.sku_codigo_omie is not null motor, sp.classe_abc, sp.fornecedor_nome forn,
        p.familia, p.ativo, p.descricao, v.uv, coalesce(v.q12,0) q12, coalesce(v.ncli,0) ncli,
        case when coalesce(v.q12,0)>0 then e.saldo/(v.q12/365.0) end cob_dias
 from e
 left join sku_parametros sp on sp.empresa='OBEN' and sp.sku_codigo_omie=e.sku
 left join lateral (select * from omie_products op
                    where op.omie_codigo_produto=e.sku and op.account='oben' limit 1) p on true
 left join v using (sku)),
rec as (
 select distinct on (ri.produto_omie_id::text) ri.produto_omie_id::text pid,
        r.razao_social_emitente forn_rec, r.data_emissao::date ult_entrada
 from nfe_recebimento_itens ri join nfe_recebimentos r on r.id=ri.nfe_recebimento_id
 where ri.produto_omie_id is not null
 order by ri.produto_omie_id::text, r.data_emissao desc)
select b.*, rec.forn_rec, rec.ult_entrada
from base b left join rec on rec.pid=b.sku::text
where not motor or q12=0 or cob_dias>180;
```
