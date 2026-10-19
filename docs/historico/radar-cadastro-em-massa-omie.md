# Radar: cadastro em massa no Omie — "sucesso sem código" e lote orquestrado no cliente (#3163)

**Entrega:** seleção múltipla em `/radar` + barra de ações em lote (Cadastrar no Omie/Oben, Criar tarefas, Exportar CSV, Descartar), histórico de contatos na ficha, Ligar na linha, 27 UFs. Só front — zero migration, zero deploy de edge. Ritual Codex completo (desenho `max` + código `max`).

## Lição 1 — resposta INCOMPLETA da edge não é sucesso (P0 do consult)

A edge `omie-vendas-sync` action `criar_cliente` devolve `success:true, created:true, codigo_cliente:null` quando `callOmieVendasApi` retorna `null` após esgotar o rate-limit. O hook aceitava e chamava `radar_registrar_cadastro_omie`, que marca `ja_cliente=true` e `virou_cliente` — o lead **saía da fila sem cliente no ERP**, sem rastro. Regra: só grava com `success===true`, `created` booleano e código não-vazio; o resto é **INDETERMINADO** (marca `OMIE_RESPOSTA_INDETERMINADA`). Decisão pura em `src/lib/radar/cadastro-omie.ts`; é a mesma classe de "ausente ≠ zero" aplicada a um **identificador**.

## Lição 2 — lote no cliente sem servidor: o que precisa existir para ser honesto

Sem migration nem edge nova, a orquestração fica no browser. O que o review Codex (código) mostrou que FALTA num runner ingênuo, e como ficou:

- **Trava fora do React** (`Set` por usuário em módulo): voltar e reabrir a página não dispara 2º runner sobre o mesmo lote.
- **Persistência SÍNCRONA a cada item** (não via `useEffect`): desmontar a página no meio continua gravando no `localStorage`; o `useEffect` morre com o componente, o lote não.
- **Retomada relê o VÍNCULO antes de qualquer chamada** (inclusive de itens "aguardando" do storage): a RPC não é idempotente (insere outro contato a cada chamada), e um throttling no Omie não pode esconder um cadastro que já tinha concluído.
- **Retry por ETAPA**: falha na gravação do Radar com código Omie confirmado só repete a RPC; "não iniciado" nunca sobrescreve uma falha que guarda código.
- **Concorrência 1 e parada no 1º throttling persistente**: a edge já faz retry com backoff; paralelismo só alonga o bloqueio. A marca `OMIE_TRANSIENT` só chega ao front via `invokeFunction` (o `error.message` cru do supabase-js é o genérico "non-2xx").
- **Cache do Radar só ao final** com `resetQueries` da lista: paginação por offset + itens saindo da fila = páginas puladas se invalidar no meio. Paginação congelada enquanto roda.
- **Lote novo recusado com pendências** e **"todos do filtro" recusado**: teto 100 por lote e a UI diz quantos ficaram de fora.

## Gates que morderam (e a troca certa)

`erro-object-object` (→ `mensagemDeErro(e) ?? '<fallback>'`), `single-shot-truncado` (`.in()` sobre PK ainda exige `.range()`), `universo-pedidos G5` (vocabulário de estado do lote `aguardando`/`nao_iniciado`, não `pendente`/`cancelado`), `fronteiras` (aresta `RadarLinha→BotaoLigar` na baseline). O hook `pr-collision-guard` rodou `gates:rapidos` no checkout principal, não no worktree — `GATES_RAPIDOS=pular` com os 15 verdes aqui.
