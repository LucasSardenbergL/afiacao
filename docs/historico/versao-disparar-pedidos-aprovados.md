# Changelog do `VERSAO` — edge `disparar-pedidos-aprovados`

Movido de `supabase/functions/disparar-pedidos-aprovados/versao.ts` em 2026-11-07 (o gate `limpeza-fonte` acusou 5 linhas de
código em 62). Cada bump novo acrescenta aqui, não no arquivo da edge.

```text
Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
é ele que distingue um bundle novo de um velho em produção.

`v1.3-email-implantado-sayerlack` = pedido do founder (2026-09-25): o resumo "Pedidos disparados"
deixou de sair em todo run. Em produção só sai (a) o e-mail "Pedido implantado na Sayerlack — nº
<protocolo>", no run que registra no Omie um pedido que o portal já aceitou, e (b) o resumo, com
assunto de problema, quando o run tem desfecho que exige ação (barrado pelo mínimo não conta).
dry_run segue com o resumo de sempre. Régua em `email-politica.ts`; o resultado de cada pedido
passou a carregar `protocolo_portal` (vai também para o `sync_reprocess_log`).

`v1.2-claim-disparo` = fecho do Cenário B do TOCTOU: a edge REIVINDICA a linha
(`reposicao_claim_disparo`, migration 20260906190615) imediatamente antes de `IncluirPedCompra`,
e a pendência criada aí veta o cancelamento até o desfecho registrado. Junto: o `{error}` da
gravação final deixou de ser ignorado (`disparado_sem_registro` quando o PO existe e o banco não
gravou), a escrita de `falha_envio` ganhou allowlist de status e NÃO limpa a pendência, e o
resumo/`sync_reprocess_log` passaram a contar sucesso por allowlist.

`v1.1-marco-causal` = o guard temporal lê `omie_po_inexistente_antes_de` (marco causal do relógio
do BANCO, lido ANTES do IncluirPedCompra) em vez de `omie_registrado_em`. Ver #1739 / 654f8576.

⚠️ O sensor só prova versões a partir de si mesmo: um bundle que tenha o marco causal mas seja
ANTERIOR ao #1747 não responde `versao` nenhuma. Ausência do campo = bundle pré-sensor.

v1.4 (2026-10-01) — o dia de SP (classe ii do fuso, fase 3): o dDtPrevisao do IncluirPedCompra sem data
do portal (hoje + lead time em dias úteis, `./previsao.ts`), o yymmdd do número do pedido e o
`dataCiclo` padrão saíam do dia UTC do servidor — o pedido aprovado (= disparado) das 21:00 às 23:59 BRT
ia ao Omie com a previsão um dia útil adiante. O ramo do portal não muda. Nenhuma pré-condição de banco.

v1.5 (2026-10-06) — preço exato no PO Sayerlack: o item do IncluirPedCompra sai de `./produto-po.ts`; com a
decomposição provada pelo portal (preco_unitario_sem_ipi_portal + valor_ipi_portal) vai nValUnit sem IPI +
nValorIpi, sem ela o PO de sempre. A leitura dos itens passou a `select("*")` — sem a migration 20261006120000 as
colunas só não vêm. Nenhuma pré-condição de banco para o comportamento de hoje.

v1.7 (2026-10-11) — recusa definitiva do portal não reenvia (#3169): pedido com
status_envio_portal='erro_nao_retentavel' devolve `portal_recusa_definitiva` (contado em
`portal_recusa_definitiva` na resposta), sem write e sem pré-claim. Antes o pré-claim o rebaixava a
pendente e a edge respondia "envio iniciado". Nenhuma pré-condição de banco (a migration
20261011150000 fecha a mesma porta na RPC, de forma independente).
v1.9 (2026-10-14) — pedido Sayerlack COM protocolo (ex.: importado do portal) não é dividido em lotes de 20.
v1.11 (2026-11-07, pontos cegos Onda 2 / D-1) — pedido do app com protocolo do portal ainda em `default_a_vista`
(condição real não resolvida) NÃO vira PO: lança antes do Omie com o texto lido. Pré-condição de banco: migration
20261107140000 (colunas `condicao_portal_lida`) e a edge de envio v1.13 deployadas ANTES desta.
v1.12 (2026-11-08, pontos cegos Onda 5A fatia 1) — pedido CANCELADO no portal (situação 6 gravada) com pendência
de disparo aberta é conciliado SÓ POR CONSULTA (ConsultarPedCompra AFI-<id>, nunca IncluirPedCompra), antes das
validações de criação: PO confirmado ⇒ registra o vínculo e avisa que o PO existe com o pedido cancelado; não achou ⇒
nada muda. Sem pendência, o claim (migration 20261108120000) recusa e nada vai ao Omie.
v1.13 (2026-11-08, revisão 2, 7.3) — o cObs do PO Sayerlack/OBEN ganha "Transportadora (portal Sayerlack): <nome>",
lida da evidência mais recente e legível do protocolo (`sayerlack_portal_evidencia.itens_brutos.data_pedido`, 7.2).
Fail-open com prazo de 3 s: sem evidência ou sem nome, a linha não entra (nunca inventada). Frete não entra.
v1.14 (2026-11-09, revisão 2, 5.2 fatia 1) — o claim (migration 20261111140000) recusa pedido com divergência portal ×
app aberta (`bloqueio: alterado_no_portal`). Com pendência de disparo aberta, a régua é a do cancelado no portal:
conciliação SÓ POR CONSULTA (PO confirmado ⇒ registra e avisa que o PO saiu com o pedido antigo; não achou ⇒ nada
muda). Sem pendência, nada vai ao Omie.
```
