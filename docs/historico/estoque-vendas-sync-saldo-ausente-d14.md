# D14 — o `nSaldo ?? 0` do `omie-vendas-sync` não fabrica zero hoje (diagnóstico, sem conserto)

Lote 6 do plano v9 (`docs/superpowers/plans/2026-11-11-plano-melhoria-v9/README.md`, linha D14), que voltou
como **diagnóstico** pelo parecer do Codex (`anexos/codex-contestacao.md`, ESTOQUE-VENDAS-SYNC). Medido em
2026-11-11, sessão só leitura (`psql-ro` + 1 leitura do Omie). **Desfecho: defeito não medido → sem mudança
de edge, sem deploy.**

## A suspeita

`supabase/functions/omie-vendas-sync/index.ts`, action `sync_estoque` (`syncEstoque`):

- `estoque: Number(prod.nSaldo ?? 0)`: `nSaldo` ausente, `null` ou `""` vira **estoque 0** (ausente ≠ zero);
- falha ao ler o mapa `omie_products` da página só faz `console.error`: a página é **pulada**, o cursor
  avança e a resposta é `success: true` (a UI mostra "Estoque atualizado!");
- falha de UPDATE por linha também só faz `console.error`: some do `totalUpdated` e o run segue `success`.

O escritor irmão (`_shared/pos-estoque.ts`, `acumularPosicoesDaPagina`) descarta o item sem saldo
explícito (`numeroExplicito`), mas não protege este caminho. E o registro do gate
(`src/lib/gates/estoque-escritores-registro.ts`) classifica esta edge como `positivos-parcial` ("nunca
zera"), coisa que o `?? 0` não garante: a G4 só pega `estoque: 0` **literal**.

## A medição

| Pergunta | Medida | Resultado |
|---|---|---|
| O zero de `omie_products` é fabricado? | `omie_products` × `inventory_position` (escrita pelos donos do zero), por código e conta | **3.304 de 3.304 pares com `estoque = saldo`**; os **5.805 zeros são 100%** produtos sem posição ≠ 0 |
| O Omie manda item sem `nSaldo`? | `scripts/reposicao-replay/extrair-omie-posicao.ts 2026-11-10` (Oben, `cExibeTodos=S`, a lista COMPLETA, superconjunto da que a edge lê) | **3.715 de 3.715 itens com `nSaldo`**, 0 ausentes; 2.913 zero e 802 ≠ 0, o mesmo perfil do `omie_products` oben (2.915 zeros, 800 > 0, 1 < 0) |
| Quanto o writer é exercido? | `fin_sync_log` `action='sync_estoque'` (o `logVendaSync` registra cada invocação) | **781 invocações desde 2026-05-28**; nos últimos 30 dias, **73 em 3 dias** (13/10, 24/10, 01/11), **1 usuário (`master`)**, 0 erro |
| As falhas silenciosas aconteceram? | lotes intermediários (`complete=false`) com `totalUpdated < 100 × páginas` | **0 de 307** desde julho; em junho, 6 de 339 (época do `orphaned_running_timeout`, já fora da janela de logs) |
| Por quanto tempo um zero errado duraria? | `sync_state` `inventory` + cluster de `omie_products.updated_at` | os donos do zero (`omie-analytics-sync` em `:00`/`:15`, `sync-reprocess`) reescrevem todos os posicionados **a cada hora** (cluster único às 17:00 oben/17:15 colacor) |

Duas fontes de evidência **não existem** e ficaram de fora de propósito: os logs da edge no Lovable Cloud
retêm ~10 min (`docs/agent/sync.md`), e esta action não grava `acoes_execucoes`. Por isso a prova do
"payload sem `nSaldo`" veio do próprio Omie, não de log.

Lacuna declarada: a leitura do Omie foi só da **Oben** (o Mac só tem a credencial dela). Para a **Colacor**,
a evidência é a do banco: 1.532 de 1.532 pares iguais e o run de 01/11 com 1.465 itens gravados em 15
páginas, todos os lotes cheios.

## Por que não consertar agora

O critério do lote era "Fase 2 só com zero fabricado ou risco real". Nenhum zero fabricado foi medido, o
Omie entregou 100% dos itens com saldo, e o caminho é usado por 1 pessoa em ~3 dias por mês, com o dono
do zero reescrevendo tudo em ≤ 1 h. Corrigir custaria um deploy manual de edge para fechar uma via que
não foi exercida. O código continua contrariando o "ausente ≠ zero": isso fica registrado como dívida
com gatilho, não como incidente.

## Gatilho para reabrir (a query, não o recado)

Reabra como conserto (regra do irmão: `numeroExplicito` → ausente não grava; falha do mapa ou do UPDATE
→ 500 + `fin_sync_log` `error`, no molde de `catalogo-gravacao.ts`) se **qualquer** destas sair ≠ 0:

```sql
-- 1) zero em omie_products com posição ≠ 0 do dono do zero (fabricado ou atraso)
SELECT count(*) FROM omie_products op JOIN inventory_position ip
  ON ip.omie_codigo_produto = op.omie_codigo_produto
 AND ip.account = CASE op.account WHEN 'colacor' THEN 'colacor_vendas' ELSE 'vendas' END
WHERE op.estoque = 0 AND ip.saldo <> 0;

-- 2) lote intermediário do sync_estoque que gravou menos do que listou (falha silenciosa ou mapa pulado)
SELECT count(*) FROM fin_sync_log
WHERE action = 'sync_estoque' AND status = 'complete' AND started_at > now() - interval '30 days'
  AND (results->>'complete')::bool IS FALSE AND (results->>'totalUpdated')::int < 200;
```

E também se o uso mudar de perfil: o `sync_estoque` passar a ser chamado por vendedores (mais de 1
`triggered_by` por mês no `fin_sync_log`) ou por cron.

## Lição

Um retrato bate-certo **não prova ausência** num espelho que outro writer reescreve de hora em hora: o
zero fabricado viveria minutos e seria apagado antes de qualquer `SELECT`. O que fechou o diagnóstico foi
medir **a fonte** (o payload do Omie) e **a exposição** (o `fin_sync_log`), não o estado derivado.
