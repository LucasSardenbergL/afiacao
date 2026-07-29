# Teto de cobertura pós-compra no motor de reposição (B/C) — spec

> **Money-path.** Mexe em `gerar_pedidos_sugeridos_ciclo` (RPC quente). Pré-flight feito 2026-07-29:
> prod byte-idêntica a `db/embalagem-motor-rpc.sql`. Guard de paridade:
> `src/lib/reposicao/__tests__/embalagem-motor-paridade.test.ts` (corpo do CREATE até EOF).

## Problema (medido em prod, OBEN, 2026-07-28)

O motor é min-max sem teto de cobertura: dispara em `estoque_efetivo <= ponto_pedido` e compra
`estoque_maximo − estoque_efetivo`. Para B/C intermitentes o lote equivale a meses de estoque:

- Capital em estoque (habilitados): R$307.672. Classe A saudável (42–71d de cobertura, real ≈ alvo).
- Classe B: R$73k real vs R$43k alvo (115–163d). Classe C: R$94k real vs R$35k alvo (421–847d).
- Compras dos últimos 90d: **~R$25k/trimestre criaram cobertura pós-compra acima de 90d (B) / 60d (C)**;
  em A, só R$422 acima de 120d — o teto em B/C não toca o A.
- Dente de serra 1↔2 dos C lentos (pp=1, max=2): venda de 1 dispara reposição de 1 → capital
  permanente de ~2×cmc por SKU numa cauda de 134 SKUs CZ.

Caminhos já REPROVADOS que esta spec NÃO repete: recalibrar a fórmula global (jun/2026: inchou
+4%/+11%), buffer por classe XYZ, exclusão de outliers, auto-aprovação.

## Decisão

**Cap de cobertura pós-compra por classe ABC, aplicado ao `qtde_final` do ciclo NORMAL.**
Invariante: com o teto ativo, a compra nunca leva `(estoque_efetivo + compra)/demanda_media_diaria`
acima do teto da classe — exceto pelos pisos explícitos abaixo. O cap **só reduz** (nunca aumenta
quantidade); classe A fica sem teto.

### Regras

1. **Config (fusível):** `company_config` chaves `reposicao_teto_cobertura_dias_b` (seed `90`) e
   `reposicao_teto_cobertura_dias_c` (seed `60`). Chave ausente/vazia/`<=0` → **sem cap** para a
   classe (comportamento atual). Deletar a chave = desligar. Formato int em texto (padrão
   `embalagem_preco_motor_stale_dias`).
2. **Elegibilidade do cap por linha:** classe `sku_parametros.classe_abc` ∈ {B, C} com teto
   configurado **e** `demanda_media_diaria > 0` **e** `COALESCE(minimo_forcado_manual,0) <= 0`.
   Fora disso → sem cap (fail-safe = comportamento atual). `classe_forcada` é 100% NULL em prod —
   não entra (limitação documentada).
3. **Cap em unidades-âncora:** `cap = GREATEST(floor(teto·d − estoque_efetivo), piso)` onde
   `piso = 1 se estoque_efetivo <= 0, senão 0` (lot-for-lot: SKU zerado com demanda repõe ao menos
   1 unidade — o dente de serra 1↔2 vira 0↔1, capital da cauda cai ~50% sem descontinuar nada;
   descontinuar é decisão humana, fica no painel de desova).
4. **Aplicação:** `qtde_sugerida` permanece o min-max cru (auditoria na tela: capado aparece como
   `qtde_final < qtde_sugerida`). `qtde_final = ceil(LEAST(necessidade_ancora, cap) / fator)` no
   ramo galão e `ceil(LEAST(necessidade, cap))` no ramo padrão. O `ceil` da embalagem pode exceder
   o teto em até `fator−1` unidades-âncora (tolerado, documentado).
5. **Linha capada a ZERO sai do pedido** — os INSERTs (pedido e item) filtram `qtde_final > 0`
   além de `qtde_sugerida > 0`. Sem rastro seria subcompra silenciosa → **log**.
6. **Observabilidade:** tabela `reposicao_teto_cobertura_log` (run_id, empresa, sku, descrição,
   grupo, classe_abc, teto_dias, demanda_diaria, estoque_efetivo, qtde_sem_teto, qtde_final,
   motivo `capado_parcial|capado_zero`). RLS espelho de `reposicao_estoque_nao_confirmado_log`
   (INSERT authenticated WITH CHECK true; SELECT via `private.cap_compras_ler(auth.uid())`).
   Toda linha com `qtde_final` reduzida pelo cap loga (parcial e zero).
7. **Escopo:** só o ciclo NORMAL (`gerar_pedidos_sugeridos_ciclo`). Ciclos de oportunidade/promoção
   (forward-buying deliberado com conta própria de VE) **não** são capados. Gate de
   estoque-não-confirmado, embalagem, mínimo de faturamento: inalterados.

### Interações verificadas

- `minimo_forcado_manual` (26 SKUs em prod): vence o teto (decisão humana explícita).
- `demanda_media_diaria` NULL/`<=0` (54 SKUs habilitados): sem cap.
- Grupo de embalagem: cap calculado sobre `estoque_efetivo` do GRUPO (mesma base do gatilho),
  antes da divisão pelo fator.
- `em_transito`/pendente já estão dentro de `estoque_efetivo` — o cap conta o a-caminho.

## Prova (PG17, `db/test-teto-cobertura-motor.sh`, padrão test-embalagem-motor.sh)

Cenários: (1) C lento no ponto com estoque>0 → capado a zero, item fora do pedido, log
`capado_zero`; (2) mesmo SKU com estoque_efetivo=0 → compra 1 (piso), log `capado_parcial` se
necessidade>1; (3) B com cap parcial → `qtde_final = floor(teto·d − estoque)` e log; (4) A →
intocado; (5) mínimo forçado → sem cap; (6) d NULL/0 → sem cap; (7) config ausente → run
byte-comparável ao baseline sem teto (assert de igualdade de pedidos/itens); (8) galão: cap em
âncora antes do fator (ceil excede ≤ fator−1); (9) linha capada parcial mantém
`qtde_sugerida` cru no snapshot. Falsificações: remover o LEAST → 1/3 vermelhos; remover o piso
→ 2 vermelho; remover filtro `qtde_final>0` → 1 vermelho (linha zerada no pedido); sabotar
leitura da config → 7 vermelho. Rodar sob `LC_ALL=C` e `pt_BR.UTF-8`, sentinelas ASCII.

## Entrega

Migration `2026-07-29 *_reposicao_teto_cobertura_motor.sql`: log + RLS + seeds de config ANTES do
CREATE; função por último, corpo byte-idêntico a `db/embalagem-motor-rpc.sql` (guard de paridade
compara do CREATE até EOF). Apply manual no SQL Editor (lovable-db-operator). Rollback: DELETE das
2 chaves de config desliga o cap sem tocar a função.
