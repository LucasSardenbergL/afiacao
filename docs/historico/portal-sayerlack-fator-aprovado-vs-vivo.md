# O fator VIVO não é o fator APROVADO — TOCTOU aprovação→envio no portal Sayerlack (2026-09-05)

> Lição de money-path (compras). Regra viva em `docs/agent/reposicao.md` §Portal Sayerlack; princípios em
> `docs/agent/money-path.md`. Edge `enviar-pedido-portal-sayerlack` v1.2 → **v1.3-fator-aprovado-vs-vivo**.

**Contexto.** O #2157 fez o motor (`gerar_pedidos_sugeridos_ciclo`) gravar `qtde_final` já no múltiplo da
embalagem do portal e persistir o fator usado em `pedido_compra_item.fator_embalagem_portal` (NULL = não
arredondou). A edge (v1.2) relia `sku_fornecedor_externo.fator_conversao` na hora do envio e normalizava
`qtde_final` à compra física com o fator VIVO. O challenge Codex (gpt-5.6-sol, xhigh) achou 3 buracos no
encontro das duas metades:

1. **TOCTOU.** Comprador aprova 40 L = 8 baldes com fator 0,2. Alguém corrige o de-para para 0,18 antes do
   envio. A edge compra `ceil(40×0,18)=8` e normaliza para 44,44 L — uma compra que ninguém aprovou. Fix:
   `verificarFatorAprovado(aprovado, vivo)` — aprovado presente e ≠ vivo (igualdade EXATA, sem epsilon: os dois vêm do MESMO
   `numeric`; uma tolerância de 1e-9 deixava 0,2 → 0,2000000009 trocar 200 por 201 embalagens em 1.000 L) → recusa o pedido INTEIRO antes de qualquer efeito externo
   (`erro_nao_retentavel`, motivo `fator_aprovado_divergente` com os dois fatores no `portal_erro`,
   `requestSent: false`). O ciclo seguinte regrava e o comprador reaprova. Precisão > recall.
2. **Chave de fornecedor.** O motor casa `fornecedor_nome` por igualdade exata; a edge casava
   `ILIKE '%SAYERLACK%'` e indexava num `Map` last-wins — com alias cadastrado, podia escolher outro
   fator/SKU do que o motor usou. Fix: `.eq("fornecedor_nome", pedido.fornecedor_nome)` (medido em prod via
   psql-ro: um único nome, `RENNER SAYERLACK S/A`, em `sku_fornecedor_externo`, `sku_parametros` e
   `pedido_compra_sugerido` — zero recall perdido hoje) + `indexarMapeamentos`: >1 linha ATIVA para o mesmo
   `sku_omie` recusa por `mapeamento_ambiguo`; ativa vence inativa; só-inativa fica para o ramo "sem
   mapeamento ativo" dizer o motivo certo.
3. **Bound de finitude.** `fator_conversao < 1e9` existia só no SQL (CHECK `fator_positivo` e a CTE
   `portal_fator`); a edge aceitava 1e9. `FATOR_MAX = 1e9` em `fatorValido`, usado por `qtdePortal`,
   `qtdeFisicaOmie` e `verificarFatorAprovado`.

**Forma.** O helper virou ESPELHO: fonte em `src/lib/reposicao/qtde-portal.ts` (vitest), cópia verbatim na
edge entre `// MIRROR-START qtde-portal`/`END`; paridade textual + gate de forma ("USA o produto no map que
decide a compra", chave exata sem `.ilike(`, `recusarPreBrowserless` com `escritaCritica` e
`requestSent: false`) em `src/lib/reposicao/__tests__/qtde-portal-edge-invariants.test.ts`. As 3 recusas
pré-Browserless (fator inválido, fator divergente, mapeamento ambíguo) saem por UMA closure — antes cada
ramo repetia o update + `gravarTentativa`. TDD com vermelho observado nos dois runners; falsificação 5/5
vermelhas (ILIKE de volta · guard removido do map · espelho divergente · bound removido · guard neutralizado).

**Também fechado no mesmo PR (Codex P2):** erro de banco ao ler `sku_fornecedor_externo` virava mapa vazio →
"SKUs sem mapeamento ativo" definitivo e FALSO; agora é falha TRANSIENTE retentável (`erro_buscar_mapeamentos`).

**Ficou ABERTO para decisão do founder (Codex P0/P1, mudam produto/motor):** `fator_embalagem_portal` NULL
reabre o TOCTOU quando o fator muda de 1 → 0,2 (exige o motor persistir o fator para TODO item e NULL virar
fail-closed); `qtde_final` editada à mão pós-motor (37) ainda é normalizada para 40 sem reaprovação; itens
seguem graváveis depois da aprovação; `sku_portal` do de-para é mutável sem snapshot; `reposicao_persistir_qtde_inteira`
(disparador) aplica `ceil` genérico a compra física fracionária (1/3,6); "Forçar reenvio" do PortalDrawer
reencaminha sem reaprovar. Ver comentário do PR.

**Deploy (ordem importa).** A edge seleciona `fator_embalagem_portal` — a migration do #2157 tem de estar
aplicada ANTES; senão todo pedido Sayerlack cai em `Erro ao buscar itens` (retentável, nenhum POST).

**Lição.** Quando duas fases leem a MESMA fonte mutável em instantes diferentes e a 2ª tem efeito
irreversível, a 1ª tem de PERSISTIR o valor que usou e a 2ª tem de CONFERIR — não basta cada uma estar certa
com o dado do seu instante. E chave de junção diferente entre motor e edge (`=` vs `ILIKE`) é a mesma
classe do §"corte por ranking" do CLAUDE.md: eixo diferente da decisão que a tela serviu.
