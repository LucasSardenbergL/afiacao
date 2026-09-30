# expandir_promocao_item: overload ambíguo, similarity fora do search_path e a expansão que apagava o item (2026-09-30)

> Issue #2665, achado lateral do #2653 ([like-cru-camada-sql.md](like-cru-camada-sql.md)). Migration
> `20260930220148_expandir_promocao_item_overload_similarity_volume.sql`, prova
> `db/test-expandir-promocao-item.sh` (no núcleo do CI).

## O sintoma

Adicionar item numa campanha de promoção (`AdminReposicaoPromocaoDetail.tsx`) insere o item e chama
`supabase.rpc("expandir_promocao_item", { p_item_id })`, que mapeia o código do fornecedor para os SKUs
Omie. Em prod a chamada falhava, e o mapeamento caía no manual: em `promocao_item`, os estados
automáticos (`expandido_automatico`, `unico`) param em 2026-05-13, e depois só há `manual_confirmado`.

## Os 3 defeitos

Medidos por `psql-ro` em 2026-09-30 02:24 UTC; o 3º, provado em PG17 sobre o snapshot com os corpos
de prod calibrados por md5.

1. **Chamada ambígua (42725).** Coexistiam `(p_item_id bigint)` e `(p_item_id bigint,
   p_threshold_similaridade numeric DEFAULT 0.5)`. A chamada de 1 argumento casa os dois, nomeada e
   posicional; com o threshold explícito, resolve. A migration UUID `20260510223800` já faz `ALTER` nos
   dois, e o catálogo não diz quando o 2º nasceu (o `xmin` do `(bigint)` é o do GRANT em massa de
   2026-08-14).
2. **`similarity()` fora do `search_path` (42883 no parse).** O corpo roda com `search_path = public,
   pg_temp`, e o `pg_trgm` mora em `extensions`. O parse resolve a chamada até no ramo não tomado de um
   `CASE`: quebravam o ramo de similaridade (0 variantes) **e** o laço de expansão (≥2 variantes), e só
   o caminho "único" rodava.
3. **A expansão que apagava o item.** O laço insere cada variante com `(campanha_id,
   sku_codigo_fornecedor, volume_minimo)` iguais aos do original, e o `UNIQUE uq_item_na_campanha` é
   sobre essas 3 colunas. Com `volume_minimo` NULL não colide, porque NULL não colide com NULL. Com
   volume preenchido, as N variantes colidem com o próprio original, o `ON CONFLICT DO NOTHING` as
   engole, e o original era desativado assim mesmo. As observações iam junto, porque
   `array_length('{}', 1)` é NULL e `texto || NULL` zera a coluna. A resposta era `'expandido'`.

O 3º estava **escondido pelo 1º**: o 42725 barra a chamada antes de qualquer caminho. Consertar 1+2 e
parar ali trocaria um erro visível por perda silenciosa. A prova mostra isso (A6): o predecessor com
só a similarity qualificada apaga o item com volume.

## Decisões do founder

- **Fica o `(bigint, numeric DEFAULT 0.5)`; o `(bigint)` sai.** É o corpo com o LIKE escapado do #2653,
  e a tela (`MapeamentoStatusCell`) já exibe os estados de similaridade dele. O front não muda: a
  chamada de 1 argumento passa a resolver no default. O pré-flight `db/preflight-dependencia-funcao.sql`
  deu 0 linhas acionáveis.
- **Com ≥2 variantes e volume preenchido, não expande.** O item fica ativo, `'ambiguo'`, com os
  candidatos no formato do `resolver_sku_por_codigo_fornecedor`, e a tela mostra "Pendente". O
  mapeamento manual já contornava o `UNIQUE`, sufixando `#omie<id>`. Mais uma guarda: laço sem nenhuma
  inserção aborta em vez de desativar o original. Volume vazio (150 dos 151 itens) segue igual.

## A migration

O corpo é o de prod (md5 `bc8f2c0e…`, o da `20260929000234`) com 3 trocas feitas por script com
contagem exata: `extensions.similarity` 5×, o bloco `'ambiguo'` e a guarda. O corpo novo tem md5
`566edd78…`, calculado pelo banco.

- **PRE:** trava as duas linhas de `pg_proc` (`ALTER … SET search_path` no-op, padrão da
  `20260927195430`) e exige o md5 exato de cada overload. O sobrevivente aceita o de prod ou o novo; o
  `(bigint)`, se ainda existe, só o de prod. Confere também as dependências late-bound do corpo novo
  para o papel que chama pelo front (`authenticated`): USAGE em `extensions` e EXECUTE em
  `extensions.similarity`; USAGE em `private` e EXECUTE no helper.
- **`DROP FUNCTION IF EXISTS … (bigint)`**, sem CASCADE.
- **POS:** um overload só; a chamada do front resolve (`EXPLAIN` com 1 argumento nomeado, sem
  executar); nenhuma `similarity(` nua; md5 exato; atributos (INVOKER, VOLATILE, `search_path`, dono);
  e **OID e ACL iguais aos da PRE**.
- `NOTIFY pgrst, 'reload schema'`. Os event triggers `pgrst_*_watch` de prod já fazem isso.
- Aplicação pelo **SQL Editor**, com `BEGIN/COMMIT` no arquivo, porque DROP é DDL destrutivo e fica
  com o founder.

## Deriva e carimbo

A entrada `OVERLOAD_FORA_DO_REPO` do `(bigint)` em `db/deriva-corpo-baseline.json` (aceite temporário
do #2667) sai no mesmo PR, e o carimbo foi re-gravado. O `deriva:corpo:prod` lê as migrations de
`origin/main`. Até o merge **e** o apply, ele fica vermelho por desenho: `OVERLOAD_FORA_DO_REPO` antes
do merge, `CORPO_ANTERIOR` entre o merge e o apply. Depois dos dois, `EM_DIA`, e uma nova gravação do
carimbo o limpa.

## A prova

41 asserts, rodados nos 2 locales. **C** (5): predecessores = prod por md5, e as sementes de
similaridade do lado certo do limiar. **A** (6): os 3 defeitos reproduzem. **M** (18): a PRE recusa
corpo estranho nos dois overloads, sobrevivente ausente, trava não-no-op e dependência fora de alcance,
e **trava** a linha (duas conexões, barreira observada, com controle); cada camada da POS recusa a sua
variante pelo rótulo certo; aplica e re-aplica. **F** (12): a chamada do front como `authenticated`,
montada como o PostgREST monta (`json_to_record` + notação nomeada), nos 3 caminhos com e sem volume e
com e sem similaridade, mais a guarda do laço vazio, o LIKE literal, a RLS e os guardas antigos.
`--falsificar`: controle verde na mesma invocação e 18 sabotagens, cada uma vermelha por RESULTADO no
assert declarado.

## Onde mais o comportamento aparece

- **Tela:** `MapeamentoStatusCell` trata `unico_por_similaridade`/`expandido_por_similaridade`
  ("Revisar — similaridade"). `'ambiguo'` cai em "Pendente", com a busca manual de uma ou mais
  embalagens.
- **Edge `promocao-extrair-via-vision`:** usa o `resolver_sku_por_codigo_fornecedor`, não esta RPC.
- **`types.ts`:** fica como está. O front chama com `as never`, e a assinatura de 1 argumento continua
  válida.
- **Deploy:** uma camada só, a migration. Sem edge e sem Publish.

## Lições

- **O erro que barra a entrada é o que impede o resto do corpo de rodar.** Uma função que falha cedo
  há meses nunca executou em prod os caminhos que vêm depois da falha, e "funcionava antes" não prova
  nada sobre eles. Antes de desbloquear, exercite todos os caminhos. O conserto da falha de entrada é
  o que os expõe.
- **Overload com DEFAULT torna ambígua a chamada que omite o default** (42725). Criar a variante com
  parâmetro opcional exige `DROP` da antiga no mesmo bloco.
- **`ON CONFLICT DO NOTHING` que copia a chave do registro de origem colide com a própria origem.**
  Com `NULLS DISTINCT`, só funciona enquanto a coluna anulável segue NULL. O fluxo manual sabia disso;
  a RPC, não.
- **Detector de DROP+CREATE por ACL é cego quando o ACL é o do DEFAULT ACL.** A POS do #2653 usava o
  ACL porque as funções dela eram fechadas, e o DROP+CREATE as reabria para `anon`. Esta é aberta
  (PUBLIC/anon/authenticated), e um DROP+CREATE renasceria com o mesmo EXECUTE. O sinal que sobra é o
  **OID**, capturado na PRE e comparado na POS.
