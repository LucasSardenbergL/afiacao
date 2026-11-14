# Radar, revisão de 11/11/2026 (Fable 5.2 + Codex): 22 itens em 6 PRs (2026-11-13)

A revisão foi feita sobre a main `25ba82997`. Cada item foi conferido contra a main antes de ser implementado. O veredito, item a item, está na tabela do corpo de cada PR.

## PRs e camadas de deploy

| PR | Itens | Camadas | Estado |
|---|---|---|---|
| #3861 O2: desfecho, offline, cache | 1, 2, 3, 4, 6, 21 (21 parcial: o fuso já era SP) | Publish | no ar, prova por bytes |
| #3862 O4: gate da `radar-ingest` | 22 (o comentário "da linha 166" **não reproduzido**: o impreciso era o da linha 21) | edge v1.9 | no ar, atestada por sonda |
| #3866 O1: cadastro no Omie | 5, 7 | edge `omie-vendas-sync` v1.36 + Publish | no ar |
| #3868 O1b: tipo do `lerLead` | erro TS2739 que o O1 introduziu (achado pelo typecheck do Lovable no deploy) | edge `omie-vendas-sync` v1.38 (no ar como v1.39, ver abaixo) | no ar, sonda 2026-11-14 00:27 UTC (fonte `7cbdf28f2fbd`) |
| #3870 O3a: discagem, UX, a11y | 9 a 17, 19, 20 (16 parcial: o aborto era intencional, faltava avisar) | Publish | no ar, prova por bytes |
| #3871 O3b: retornos paginados, intenção pelo e-mail | 8, 18 | migration `20261113110100` (envelope `db:aplicar`, conferida por psql-ro) + Publish | no ar, bundle `index-BjOtSKJV.js` com `radar_meus_retornos` no chunk `RadarClientes` |

## Contratos que ficam

- **Invalidação depois de um contato**: `src/lib/radar/invalidar-cache.ts` relê só a allowlist `RELER_POR_LEAD`, mais `RELER_DO_LEAD` do próprio CNPJ. O resto sob `['radar']` fica velho (`refetchType: 'none'`). **Query nova que um contato muda tem de entrar na allowlist**, senão a tela fica com o dado antigo. O O3b acrescentou `meus-retornos`.
- **Elegibilidade do cadastro vive na edge** (`omie-vendas-sync/radar-cadastro.ts`). A checagem fica entre o lookup estrito e o `IncluirCliente`, e só roda com `radar` no payload. A recusa vira `RADAR_INELEGIVEL` e, no front, `InelegivelCadastro`, que não é retentável. No lote, o item fica `recusado`. O e-mail só vai ao Omie quando a classificação contábil é negativa explícita (`efetivo === false`). O `null` não basta: foi o P1 do Codex.
- **A agenda tem o dia na chave**: `['radar','prospectar-hoje', alvo, hojeBRT]`.
- **Retornos além do card**: RPC `radar_meus_retornos(p_vendedor, p_offset, p_limit)`, STABLE e na allowlist da lente.

## O que custou tempo (lições)

- **Uma edge deployada pode ter erro de tipo que o CI tolera.** O `edges:typecheck` tolera 78 erros conhecidos por classe. O O1 trocou um TS2739 tolerado por outro igual, e quem acusou foi o typecheck do Lovable no deploy. A correção foi um PR à parte (#3868). Conte por classe **antes e depois** (`TS2739:2 → 1`), não só "0 classe-crash".
- **Colisão de VERSAO entre PRs paralelos na mesma edge.** O #3872 mergeou com `v1.37-vendedor-do-pedido` enquanto o #3868 esperava com `v1.37-radar-lerlead-promise`. No merge da main, a VERSAO vai para a próxima livre (v1.38), o fingerprint é regravado e a citação de linha nos docs anda junto (`docs:citacoes`).
- **Um único deploy cobre a leva.** O `pendencias:pacote` recusou a main com o #3872 (exit 3: RPC chamada por nome não literal, lista de pré-condições incompleta). Depois do #3880, um único deploy a partir da main (v1.39) subiu as três mudanças. Deployar a v1.38 antes não teria sido possível, e seria redundante.
- **`deriva:corpo:prod` vermelho por PR alheio em voo**: migration aplicada antes do merge (#3873). O Publish esperou o merge, e o gate voltou a verde sem nenhuma intervenção.
- **O sensor de edição dá `EDICAO_DETECTADA` pelo `commit_sha` da resposta** mesmo quando o único commit do bot é a regeneração do `types.ts`, que é tolerada. Leia a linha dos commits: com 0 fora dos gerados e 36/36 hashes, nada foi editado à mão.
- **O CI da main ficou vermelho** por `test-pre-anti-deriva-concorrencia` (deadlock 40P01 no PG 17.12, consertado no #3877). Os PRs ficaram BLOCKED. O caminho foi esperar o conserto e fazer `gh pr update-branch`, sem `--admin`.

## Decidido depois: o lote pula lead em posse de outro vendedor (2026-11-14)

O founder respondeu "Sim, pular". A regra entrou na edge `omie-vendas-sync` v1.40 (`radar-cadastro.ts`), com o front acompanhando.

- **Onde vive**: no servidor, como motivo `posse_de_outro` do `RADAR_INELEGIVEL`. O `criar_cliente` passou a seguir a ordem de `criarClienteComRegraRadar`: lead elegível, depois a preparação (razão fiscal), depois a posse **imediatamente antes** do `IncluirCliente`, e só então a inclusão. É o único `IncluirCliente` da edge, e um teste Deno lê o `index.ts` para garantir isso.
- **Escopo**: só o cadastro que não exige conversa, que é o do lote (`respeitarPosse = !exigirEmConversa`, derivado em `lerExigenciaRadar`). O build do lote que já está nos navegadores manda `exigir_em_conversa: false`, então a regra vale assim que a edge sobe, sem esperar o PWA. A ficha individual não mudou, porque o founder só decidiu o lote.
- **Leitura da posse**: a RPC canônica `radar_atendimentos_ativos` com o JWT do chamador (`.eq('cnpj')` e `.limit(2)`). Não precisou de migration, a definição de "ativa" é a mesma da tela, e o `eh_meu` é calculado no banco. Posse desconhecida (erro, chamada sem usuário, forma estranha, 2+ linhas, outro CNPJ) **lança** `RADAR_POSSE_INDETERMINADA`: nada é criado e o item fica como falha retentável, nunca como "livre".
- **Front**: o item vira `recusado` com `donoNome` e aparece como "pulado: em atendimento por <nome>". Não é pendência nem é retentado. O resumo do diálogo conta recusados e pulados. O evento `radar.lote_cadastrado_omie` ganhou `lote_total`, `lote_recusados` e `lote_pulados_posse`, todos com o denominador do lote inteiro, porque o `total` é o da execução.
- **Residuais aceitos** (Codex P1, calibrados):
  - O build velho do front não conhece o motivo e trata a recusa como falha retentável. A edge recusa de novo enquanto a posse estiver ativa, e o `error` já diz "em atendimento por <nome>; nada foi criado no Omie". Se a posse caiu antes da retentativa, o lead está livre e o cadastro é legítimo.
  - Um leitor antigo do `localStorage` descarta o lote que tem o motivo novo. É a mesma classe de quando o `recusado` nasceu (#3866), e versionar a chave não ajuda o leitor antigo.
- **O reenvio também relê a posse** (Codex de código, P1). Depois de um rate-limit, o helper do Omie espera e reenvia o `IncluirCliente`. Sem reler a posse, um lead que outro vendedor assumisse durante a espera era criado no 2º envio. Agora `callOmieVendasApi` aceita `antesDeReenviar`, chamado entre o backoff e o reenvio, e o orquestrador relê a posse ali. Se ela virou de outro vendedor, sai a mesma recusa. A recusa é honesta: o Omie só reenvia uma inclusão depois de rate-limit, ou seja, quando ele recusou a anterior; transitório ambíguo de `Incluir*` lança indeterminada antes. No mesmo parecer, P2: o `falhas` do evento contava os pulados, e agora as recusas desta execução saem de `falhas` e vão para `recusados`.
- **Prova**: Deno com o fluxo real e só a I/O falsa (ordem das chamadas, zero `incluir` na recusa, na posse indeterminada e na posse que muda no reenvio) e vitest com o hook real do lote. Um gate de fonte no `index.ts` exige um `IncluirCliente` só, a exigência lida do payload, o client do chamador na RPC filtrada pelo CNPJ e o hook repassado. A falsificação teve 3 controles verdes (Deno em `C` e `pt_BR`, vitest) e **20/20 sabotagens vermelhas**.
- **Codex**: no desenho, aprovou com ressalvas; no código, reprovou com 1 P1 e 2 P2, os três corrigidos; na reconferência do conserto, aprovou sem achado novo.
- **No ar (2026-11-14), PR [#3889](https://github.com/LucasSardenbergL/afiacao/pull/3889) (`52f17e7f9`):**
  - **Publish**: o founder publicou antes da edge. A ordem invertida não fez mal: o front novo com a edge v1.39 só tinha vocabulário a mais, e o lote seguiu como antes até a edge subir. A prova é por bytes: o chunk `RadarClientes-qOz9Hrrx.js` servido em `steu.lovable.app` contém `lote_pulados_posse`.
  - **Edge**: `pendencias:pacote omie-vendas-sync` gerou o pacote `f0f54a004e40` contra `origin/main@f330b5486`. O Passo 2 foi colado verbatim às 09:24:16Z. O agente conferiu 36/36 sha256, fez o deploy, recebeu 401 na sonda com token inválido e fechou com `No files were edited.` Custou 1,3 crédito.
  - **Sensor de edição**: deu `EDICAO_DETECTADA` só pelo `edit_id`/`commit_sha`. O `get_diff` mostra apenas o `src/integrations/supabase/types.ts` regenerado (`895d3a99a`, tolerado, com tabelas de migrations de outras sessões). Nada foi revertido.
  - **Atestação**: relé `deploy_sonda_disparar(ARRAY['omie-vendas-sync'])` disparado pela sessão, a pedido do founder. Resposta HTTP 200 com `versao: v1.40-radar-lote-pula-posse` e `fonte` `701036bc…`, que é igual ao fingerprint da main. No `pendencias:deploy`, a `omie-vendas-sync` confere. O exit 1 da rodada veio de 7 edges de outras sessões, mergeadas no mesmo dia.
  - **Sinal de uso**: ainda não há. Hoje `radar_atendimentos` tem 0 linhas, ou seja, ninguém assumiu lead. O 1º `lote_pulados_posse > 0` no evento `radar.lote_cadastrado_omie` é o sinal positivo; até lá, a regra está disponível, mas não foi exercida.
