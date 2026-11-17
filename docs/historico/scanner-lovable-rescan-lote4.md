# Rescan do scanner Lovable Security — lote 4 (2026-11-17)

Continuação do [lote 3](scanner-lovable-rescan-lote3.md). O painel mostrava 7 achados e o pedido foi "resolva". **Nenhum pediu conserto novo:** 4 já estavam corrigidos e no ar, 2 são desenho e 1 é falso positivo. Não há migration, edge nem Publish neste lote. Cada veredito foi conferido na PROD via `psql-ro` e no ledger de deploy (`bun run pendencias:deploy`, rc=0), entre 09:40 e 10:00 UTC de 2026-11-17, sobre o commit `20df4dafb`.

## Por que os corrigidos ainda apareciam

O painel junta duas varreduras. A profunda ("deep scan") tinha 3 dias, ou seja, era de 2026-11-14, anterior aos consertos do lote 3. Os 5 achados dela aparecem com um ícone de relógio ao lado do selo. A outra varredura tinha acabado de rodar e trouxe os 2 sem relógio. Essa leitura do ícone é inferência pela data e pelo conjunto, não saiu da documentação do Lovable.

O casamento entre título e código também é pela descrição: a lista do painel não mostra o código, e o navegador da sessão não estava logado no Lovable para abrir o detalhe.

## Triagem

| Título no painel | Código | Veredito | Evidência na PROD |
|---|---|---|---|
| Any signed-in user can see customer account owners | `43bd6b91` | Corrigido no lote 3 | `cobranca_dona` sem EXECUTE para authenticated, anon e PUBLIC. As 3 policies SELECT de cobrança (`caso`, `evento`, `promessa`) usam `cobranca_sou_dona` |
| Any staff member can redirect customer ownership | `b339bb5b` | Corrigido (#3912 e #3925) | `omie_customer_account_map` com master ALL e staff SELECT. `register_carteira_member` é DEFINER, `admitir_vinculo_conferido` só executa como service_role, e a `omie-cliente` servida é a `v1.12-vinculo-conferido` |
| Any employee can inject markup into order emails | `ec253a34` | Corrigido no lote 3 | A `omie-sync` servida é a `v1.14-email-html-escapado`. Todas as interpolações do corpo do e-mail passam por `escapeHtml` |
| Anyone with the webhook secret can store oversized attachments | `03689f08` | Corrigido no lote 3 | O `gmail-webhook-receiver` servido é o `v1.1-teto-anexos` |
| Any employee can read every customer's process data | `7330d2bc` | Desenho (lote 3) | A RLS de `customer_processes` e `rag_chunks` dá SELECT a employee e master, como a de `profiles` ("Employees can view all profiles"). `customer_processes` tem 0 linhas |
| Caller input shapes the commands radar_lista runs | novo | **Falso positivo** | Seção abaixo |
| Anyone can read every record in tool_categories | novo | **Desenho** | Seção abaixo |

## `radar_lista`: falso positivo

O scanner afirma duas coisas: que quem se cadastra chama a função, e que um valor forjado muda o comando. Nenhuma das duas vale.

- **Quem chama.** O gate `private.cap_radar_prospectar` vem antes de qualquer SQL dinâmico: passa o master, ou o employee com papel comercial. O cliente recém-cadastrado recebe 42501. Anon e PUBLIC não têm EXECUTE.
- **O que entra no comando.** Os pedaços do `WHERE` são constantes do corpo da função. Os valores do chamador entram só por `USING`, como parâmetros ligados, e parâmetro ligado não é lido como SQL. A coluna de ordenação passa por lista fechada de 3 nomes (fora dela, 22023) e por `%I`. O chamador escolhe quais filtros constantes entram, e nada além disso.
- **O corpo vivo é o do repo.** O md5 do `prosrc` na PROD é `829e547135cecdd67d7af0c9c777a99f`, o mesmo cravado na postcondição de `20261111120000_radar_carga_publicacao_curta.sql`.
- **Prova executada que já existia:** `db/test-radar-lista-rpc.sh` (PG17). G1 dá 42501 sem a capability, G2 e G3 conferem a ACL, V1 manda `p_ordem => 'score DESC; SELECT 1'` e recebe 22023, e W2 prova que o curinga do termo é literal. O modo `--falsificar` tem as sabotagens `sem_gate` (G1) e `sem_escape` (W2). A prova não foi rodada de novo nesta sessão.

A função não foi reescrita em SQL estático de propósito. O `WHERE` montado por combinação de filtros é o que dá plano com índice ([radar-indices-lista-nulls-last.md](../runbooks/radar-indices-lista-nulls-last.md)); reescrever para agradar o scanner trocaria um problema que não existe por risco de desempenho numa função quente.

Varredura da classe: entre as funções plpgsql de `public` que anon ou authenticated executam, só `radar_lista` monta SQL com `format`. `venda_painel` executa uma string constante com `USING`.

## `tool_categories`: desenho

A policy "Anyone can view tool categories" (SELECT, `USING (true)`) é intencional: `src/pages/Auth.tsx` lê o catálogo no cadastro, antes do login. São 8 linhas de catálogo (`name`, `description`, `icon`, `usage_type`, `suggested_interval_days`), sem dado pessoal, e não há policy de escrita. A decisão já estava declarada no cabeçalho de `20261113120000_seg_scanner_politicas_select_abertas.sql`, cuja postcondição A7 aborta se a leitura pública sumir.

## Parentes conferidos

- **Oráculo da dona.** `wa_owner_efetivo(uuid)` é SECDEF, authenticated executa e o retorno é o uuid da dona. Ela tem gate interno: só service_role ou staff recebem resposta, e o customer recebe NULL. É o que o `IncomingCallModal` usa para mostrar "cliente da Regina" a quem atende a ligação. Difere de `cobranca_dona`, que respondia ao customer. `carteira_por_municipio` exige `pode_ver_carteira_completa`, e `venda_cobertura_vendedor` exige master.
- **Upload sem teto.** Só 4 edges gravam no storage. As duas que recebem arquivo de fora (`gmail-webhook-receiver` e `promocao-extrair-via-vision`) ganharam teto e cota no lote 3. As outras duas (`enviar-pedido-portal-sayerlack` e `sayerlack-captura-precos`) são automação interna.
- **HTML de e-mail sem escape, não tratado.** `gerar-pedidos-diario` e `monthly-report` montam o HTML sem `escapeHtml`. O scanner não os apontou.
  - `gerar-pedidos-diario` recebe `empresa` e `data_ciclo` do body, de staff ou do cron, e os põe no HTML. Na prática nenhum dos dois leva marcação: o e-mail só sai se `empresa` casar uma linha de `empresa_configuracao_custos` com destinatário (hoje, só `OBEN`), e `data_ciclo` precisa passar pelo parser de `date` do Postgres na RPC `gerar_pedidos_sugeridos_ciclo(text, date)`. O resto vem do banco (`fornecedor_nome`, `grupo_codigo`, `mensagem_bloqueio`).
  - `monthly-report` interpola nome e código de ferramenta e o nome do cliente. A origem desses dados e o destinatário não foram examinados nesta sessão.
  - O conserto é o mesmo helper do lote 3, mas cada edge custa um deploy. Fica como candidato a um próximo lote, se o founder quiser.

## Fica para o founder

- Rodar o **deep scan** de novo. Os 4 corrigidos (`43bd6b91`, `b339bb5b`, `ec253a34`, `03689f08`) devem sair da lista.
- Marcar como aceitos: `7330d2bc` (desenho), `radar_lista` (falso positivo) e `tool_categories` (desenho).
- **Não usar "Try to fix" nem "Try to fix all".** O botão entrega o conserto ao agente do Lovable, que edita o que não foi pedido e empurra na main ([caso](agente-lovable-conserta-o-que-nao-pediram.md)). Aqui ele tenderia a derrubar a leitura pública de `tool_categories` (quebra o cadastro) e a reescrever `radar_lista`.
