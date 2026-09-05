# Changelog do marcador `VERSAO` — edge `enviar-pedido-portal-sayerlack`

> **A classe (2026-09-05):** o `versao.ts` de uma edge instrumentada **afunda sozinho com o tempo**.
> Cada bump só ACRESCENTA comentário e o arquivo tem meia dúzia de linhas de código, então a razão
> código/total cai a cada entrega até o gate `limpeza-fonte` acusar ("o fiscal está olhando quase nada
> destes arquivos"). Aqui o arquivo chegou a **6 linhas de código em 66**. O marcador é marcador; o
> changelog mora aqui, e o `versao.ts` guarda uma linha por versão apontando para cá.

Detalhe de cada entrega vive no diário do PR correspondente. Esta página existe para não perder o
"por que" de cada bump quando o `versao.ts` é enxugado.

| versão | o que mudou |
|---|---|
| `v1.0-sensor-inicial` | primeira instrumentação da sonda (`{"probe":true}`). |
| `v1.1-pos-login-no-envio` (`8ee8afa15`) | o pós-login deixou de inferir sucesso de `url_changed` e passou a classificar por SINAIS do DOM (menu do sidebar, campos de senha), via `_shared/sayerlack-pos-login.ts`. Antes, a troca de senha exigida pelo portal virava exceção anônima. ⚠️ Bump **TARDIO**: o commit mergeou em 2026-08-21 com o marcador ainda em `v1.0`, então a sonda não discriminava aquele deploy — ver [sonda-marcador-congelado.md](sonda-marcador-congelado.md). |
| `v1.2-qtde-portal-fator-embalagem` | quantidade do portal via `qtdePortal` (`./qtde-portal.ts`): `fator_conversao` converte unidade (Omie em LITRO para portal em BALDE, fator 0,2), com `round6` antes do `ceil` (poeira binária virava balde a mais) e fail-closed em fator inválido (antes ia `NaN` no input). |
| `v1.3-fator-aprovado-vs-vivo` | 4 achados do challenge Codex, todos fail-closed ANTES do Browserless: (1) TOCTOU aprovação→envio — `pedido_compra_item.fator_embalagem_portal` (o fator com que o MOTOR arredondou) diferente do `fator_conversao` VIVO vira `erro_nao_retentavel`; (2) chave de fornecedor EXATA em vez de `ILIKE`, e mais de uma linha ativa por `sku_omie` recusa por `mapeamento_ambiguo` (antes: `Map` last-wins); (3) `fator_conversao < 1e9` espelhado do SQL (`FATOR_MAX`); (4) erro de banco ao ler o de-para é TRANSIENTE, não "sem mapeamento" definitivo. |
| `v1.4-captura-custo-json-efetivar` | a captura de custo deixou de ser cega: 97/97 envios (jun→set/2026) vinham com `sku_portal=''` e `total_raw=''`. O custo passa a nascer de `./captura-custo.ts` — JSON do Efetivar mais DOM por header-matching, com cadeia de prova — e a cegueira virou sensor. Ver [sayerlack-captura-custo-cega.md](sayerlack-captura-custo-cega.md). |
| `v1.5-custo-portal-rpc-cas` | a ESCRITA do custo virou a RPC transacional `sayerlack_aplicar_custo_portal` (migration `20260905090000`): compare-and-set NO BANCO (`omie_pedido_compra_numero IS NULL AND status_envio_portal = 'sucesso_portal'` no próprio UPDATE, porque `jaTemOmie` em memória era snapshot e corria com o PO Omie) e itens tudo-ou-nada (`ROW_COUNT` diferente de `n` gera `CP004` e ROLLBACK; antes o custo MISTO ficava persistido). ⚠️ Depende da migration aplicada: sem ela todo envio cai em `erro_rpc`. |
| `v1.6-preco-venda-e-total-da-linha` | `dom_checksum` somava `Preço Venda × Qtd UN`, mas o DOM prova que **Preço Venda já é o total da linha**. A soma inflada reprovava todo pedido multi-item por `checksum_divergente` — fail-closed, mas com a captura do DOM morta e invisível. A tolerância passa a depender do número de linhas, e o resumo ganha `delta_rel`. Ver [sayerlack-captura-custo-cega.md](sayerlack-captura-custo-cega.md) §Adendo. |
