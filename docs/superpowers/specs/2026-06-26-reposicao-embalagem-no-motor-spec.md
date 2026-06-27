# Embalagem econômica DENTRO do motor de pedidos (QT↔GL) — spec

> Money-path. Reverte a §14.2 de `2026-06-04-embalagem-economica-design.md` (o painel era conselheiro e
> NÃO tocava o pedido automático). Agora `gerar_pedidos_sugeridos_ciclo` (1) **consolida o estoque no nível
> do grupo** e (2) **escolhe a embalagem mais barata por litro**. Decisões do founder (Lucas, 26/06):
> (a) **motor escolhe a embalagem**; (b) **estrito** — na dúvida mantém o quartinho, nunca fabrica custo;
> (c) **base de custo = preço do portal cadastrado no app**; (d) **galões parados são estoque REAL** (confirmado).

## Dois problemas (relato + descoberta)

1. **Embalagem cara:** mesmo concentrado em QT (quartinho 0,81 L) e GL (galão 3,24 L = 4 QT). O galão é mais
   barato por litro, mas o pedido sugerido insiste no QT (WP01, WP87, WP04…).
2. **Galão parado ignorado (descoberto 26/06):** o motor olha só o estoque do quartinho e é cego aos galões
   em estoque → manda comprar WP87/WP04 mesmo com galão parado na prateleira (super-compra / compra desnecessária).

## Causa-raiz (provada em prod via psql-ro)

`gerar_pedidos_sugeridos_ciclo` lê **só `sku_parametros`** (só o QT tem parâmetro de reposição) e:
- nunca consulta `sku_embalagem_equivalencia` / `sku_preco_fornecedor_capturado` → **cego a embalagem**
  (sugere o QT porque é o único parametrizado; o GL nem tem `ponto_pedido`/`estoque_maximo`);
- conta o estoque só do SKU âncora (QT) → **cego ao estoque do grupo** (ignora o galão parado).

Não é julgamento de custo; é cegueira de catálogo + de estoque.

## Dados reais (prod, 26/06) — empresa OBEN, fornecedor Renner Sayerlack

| Concentrado | SKU QT / GL | estoque QT | estoque GL (Omie) | ponto/máx (QT) | cmc QT→GL (R$/L) | preço app QT→GL÷4 (R$/L) |
|---|---|---|---|---|---|---|
| WP01 preto | 8689775044 / 12078998671 | 3,24 | 0 (+2 a caminho) | 6 / 10 | 100,17 → **ausente** | 81,71 → **76,62** (−6,2%) |
| WP87 ocre  | 8689775019 / 12097949925 | 1,62 | **9,72 (3 galões)** | 2 / 4 | 116,39 → 115,20 (−1%) | 97,57 → **87,05** (−10,8%) |
| WP04 azul  | 8689733271 / 12101098529 | 0,81 | **3,24 (1 galão)** | 1 / 2 | 121,96 → 114,13 (−6,4%) | 106,00 → **86,25** (−18,6%) |

- Equivalência (`sku_embalagem_equivalencia`, 'oben'): unidade_base `QT`, fator QT=1 / GL=4. 1 QT=0,81 L, 1 GL=3,24 L.
- Portal-map (`sku_fornecedor_externo`, **'OBEN'**): QT+GL dos 3 mapeados (`WPxx.3900QT/GL`, `UN`, fator_conversao 1).
- Preço app (`sku_preco_fornecedor_capturado`, **'oben'**, `manual_usuario`): WP01/WP87 05/06; WP04 26/06.
- ⚠️ Case-sensitivity: `sku_parametros`/`sku_estoque_atual`/`sku_fornecedor_externo` = **'OBEN'**; `sku_embalagem_equivalencia`/`sku_preco_fornecedor_capturado` = **'oben'**.

## Base de custo (DECIDIDO: preço do app decide, cmc valoriza)

- **Decisão da embalagem** = menor `sku_preco_fornecedor_capturado.preco / fator_para_base` — o preço líquido do
  portal que o founder cadastra no app (mesma data → comparação limpa). Os 3 dão galão.
- **Por que não o cmc pra decidir:** o cmc é custo cheio (com impostos) e histórico → *achata* o desconto
  (WP87: −1% no cmc vs −11% no preço de tabela) e não tem o galão do WP01 (nunca comprado em galão). O cmc
  do Omie serve pra **valorizar a linha** (como hoje), NÃO pra decidir a embalagem.

## Estoque de grupo (DECIDIDO: GREATEST das 2 fontes; galões reais)

- As 2 tabelas de estoque DIVERGEM nos galões: `inventory_position.saldo` tem WP87/WP04 GL (9,72 / 3,24) mas
  não WP01 GL; `sku_estoque_atual.estoque_fisico` tem WP01 GL mas não WP87/WP04 GL. Os QT batem nas duas.
- **Founder confirmou (26/06): os galões parados são estoque físico REAL.**
- Estoque por membro = `GREATEST(COALESCE(inventory_position.saldo,0), COALESCE(sku_estoque_atual.estoque_fisico,0))`
  (pega o galão real de onde estiver; contar a mais = comprar a menos = lado seguro money-path). Mais `em_transito`
  e `pendente` do grupo. ⚠️ `inventory_position` é account-aware (oben → `vendas`/`oben`).

## Comportamento desejado (por grupo de equivalência)

1. **Estoque do GRUPO** (litros) = Σ membros [GREATEST(inv,sea) + em_transito + pendente].
2. **Gatilho** = estoque_grupo ≤ `ponto_pedido` da âncora (QT). Necessidade = `estoque_maximo` âncora − estoque_grupo.
3. **Escolha** = menor preço-app/fator entre membros com preço **FRESCO (≤45 d)** + fator + portal-map presente.
   Senão **estrito** → âncora (QT) + flag `embalagem_economica_indisponivel:<motivo>`. Nunca CMC ausente como 0.
4. **Dimensionar** = `ceil(necessidade / fator_para_base_do_galão)` (necessidade na escala da RPC; galão = 4× a âncora →
   WP01: `ceil(4,76/4)=2` galões). Grava `qtde_final = nº de embalagens` do SKU escolhido.
5. **Custo da linha** = **preço-app do SKU escolhido** (R$/embalagem; galão sempre tem preço-app fresco quando é escolhido);
   **nunca 0**. `preco_unitario` casa a unidade de `qtde_final` (R$/galão × nº galões = R$ real). Afeta `valor_total`/alerta R$3k.
   *(quartinho NÃO é tocado — mantém `cmc` cru como hoje; só passa a somar estoque do grupo.)*

**Prova viva dos 3 (com consolidação):**
- **WP01:** grupo 3,24+0 = 3,24 (+2 a caminho = 5,24) ≤ ponto 6 → **DISPARA**. Nec 10−5,24 = 4,76 → `ceil(4,76/3,24)` = **2 galões**. (sem galão parado → compra galão, legítimo)
- **WP87:** grupo 1,62+9,72 = 11,34 > ponto 2 → **NÃO compra** (galão parado).
- **WP04:** grupo 0,81+3,24 = 4,05 > ponto 1 → **NÃO compra** (galão parado).

## Unidade do envio (CRAVADA empiricamente — pendência resolvida 26/06)

Lidos `disparar-pedidos-aprovados` (Omie `nQtde=ceil(qtde_final)`, `nValUnit=preco_unitario`, `nCodProd=sku`) e
`enviar-pedido-portal-sayerlack` (portal `qtde=ceil(qtde_final × fator_conversao)`; `fator_conversao=1` p/ QT e GL).
Provas em prod:
- **`qtde_final` = nº de EMBALAGENS do SKU** (não litros). Prova: WP01.3900GL já virou pedido em 14-15/05 com
  `qtde_final=2` (2 galões), `preco_unitario=0` → **cancelado** (3 linhas em `pedido_compra_item`). O cancelamento
  foi por **custo 0** (cmc do galão ausente viraria 0) — exatamente o que a decisão "nunca fabricar, usar preço-app" mata.
- **`cmc` é R$/L** (100,17 × 3,24 L = R$324,5 = 4 QT × ~R$81). Quantidades históricas no `sku_leadtime_history` são
  sempre múltiplos de 0,81 (0,81/2,43/3,24/5,67/7,29) com `valor_unitario` em R$/L → compra-se embalagem inteira, registra-se volume.
- **Convenção vigente da RPC (mantida, NÃO "consertada"):** estoque vem em litros do Omie (`op.unidade='L'`) e a RPC
  subtrai `estoque_maximo − estoque_efetivo` tratando o resultado como "unidades a comprar" (descasamento litros↔embalagem
  pré-existente, tolerado, fora de escopo). Dimensiono o galão na MESMA escala: `nº_galões = ceil(necessidade / fator_galão)`.

**Decisão de unidade:** grava-se `qtde_final = nº de embalagens` e `preco_unitario = R$/embalagem` do SKU escolhido.
Galão → `preco_unitario = preço-app do galão` (R$/galão, líquido, sempre presente quando se escolhe galão, > 0). Omie/portal
recebem o nº de embalagens direto (`fator_conversao=1` mantido). Isso espelha o que o quartinho já faz hoje — não introduz
descasamento novo. ⚠️ a precisão de granularidade (`/fator_galão` vs `/volume_real`) é o ponto a stress-testar no Codex/prove.

## Decisões cravadas

- **A. Custo da linha:** preço-app do SKU escolhido (R$/embalagem), na unidade de `qtde_final`; nunca 0. *(Prova viva: galão
  com preço 0 foi cancelado em 14-15/05 — o preço-app > 0 mata isso. cmc fica fora: é R$/L e exigiria volume da embalagem.)*
- **B. Frescor:** motor confia no preço app por **45 dias** (painel usa 24h, apertado pra cadastro manual). Config
  `embalagem_preco_motor_stale_dias`. Stale → estrito (QT). *(Founder pode ajustar o prazo.)*
- **C. Estoque:** GREATEST das 2 fontes, somado no grupo.
- **D. Local:** dentro da RPC (CTEs de consolidação por grupo), não pós-passo (idempotência + gate mínimo/3k coerentes).

## Provar antes de aplicar (PG17 falsificável)

Asserts (seeds = dados reais acima):
- (a) **WP01:** sem galão parado, galão fresco+mapeado+mais barato → gera **2 galões** WP01, custo ≠ 0.
- (b) **WP87/WP04:** galão parado faz estoque_grupo > ponto → **NÃO gera pedido** (anti super-compra).
- (c) galão sem preço fresco → mantém QT + flag (estrito).
- (d) galão sem portal-map → mantém QT + flag.
- (e) cmc E preço app ausentes → custo **NÃO** vira 0 (degradação honesta).
- (f) consolidação não double-conta `em_transito`.
- **Falsificar:** sabotar o gate estrito (`IF false`) e a consolidação (somar só QT) → exigir VERMELHO em (b)/(c)/(d).
- Threat-model (`docs/agent/threat-model-template.md`): default fail-closed = âncora; 1 assert por default.
- Codex `/codex` (xhigh, adversarial) no diff + metodologia. **NÃO** deixar varrer o schema-snapshot.

## Revisão adversarial (Codex xhigh + teste-contra-prod) — 7 correções vs. o 1º rascunho

O 1º rascunho passou no PG17 com seeds idealizados, mas **um dry-check contra prod** (a query de validação rodada
read-only) e o **Codex (gpt-5.5 xhigh)** convergiram em achados que o seed mascarava. Corrigidos e re-provados:

- **P0-a `GREATEST(inventory_position.saldo, sku_estoque_atual.estoque_fisico)`** — as 2 fontes DIVERGEM por SKU:
  galão WP87/WP04 vive SÓ em `inventory_position` (9,72/3,24); WP01 GL SÓ em `sku_estoque_atual` (pendente 2). O
  rascunho lia só `sku_estoque_atual` → WP87/WP04 voltariam a comprar. (Pego pelo dry-check-contra-prod ANTES de aplicar.)
- **P0-b `em_transito` do galão × `fator_para_base`** — 2 galões em voo = 8 unidades-base, não 2. Sem isso, o ciclo
  seguinte re-dispararia (double-buy). `inv_saldo` é account-aware (oben → vendas/oben), 1 linha/SKU (mais recente).
- **P1-c âncora NÃO pode ser galão** (membro `fator>1`): senão um GL com `ponto_pedido` viraria âncora E seria
  escolhido por outro → 2 linhas do mesmo GL (uma com custo CMC/0). *(Latente real: o WP01 GL já tem `sku_parametros` habilitado.)*
- **P1-d anti-duplicidade de oportunidade** cobre a âncora **E** o SKU escolhido (galão) — senão a troca driblava o gate.
- **P1-e `minimo_forcado_manual`** respeitado na troca: `ceil(GREATEST(necessidade, minimo)/fator)` (piso ANTES de dividir).
- **P1-f filtros de catálogo** (ativo/tipo 04/família/`ativo_no_omie`) aplicados ao MEMBRO escolhido, não só à âncora
  (senão compraria galão descontinuado).
- **P2 (aceito):** granularidade `/fator` nunca compra menos que o legado QT (herda o descasamento litros↔embalagem); campos
  de estoque do item passam a representar o grupo (o disparo não os usa). Documentados, não bloqueiam.

Prova final: `db/test-embalagem-motor.sh` (PG17, divergência de fontes real + pedido em voo + oportunidade) — 14 asserts
+ 9 falsificações com dente (cada fix tem uma sabotagem que o vira vermelho).

## Não-objetivos

Não mexer no painel frontend (já correto). Não auto-aprovar. Não cadastrar os pares por código (cadastro é
founder/portal). Não tocar a via de venda assistida.
