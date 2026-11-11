# Contestação do Codex — plano v9 (parecer cru)

> 2026-11-11, `scripts/codex-async.sh -r high`, sobre a lista de itens e cortes antes dos vereditos (`origin/main` = `fca92fe97`). Texto do Codex sem edição, exceto os caminhos absolutos do worktree, encurtados para relativos. Os vereditos finais estão no [README](../README.md). O "C20" do parecer é o C19 do README (renumerado depois).

**O v9 identifica defeitos reais, mas superestima alguns ganhos e trata hipóteses como causas demonstradas.** Eu priorizaria C17, a correção de completude de C18 e E20. Manteria C20/B4/B5 em diagnóstico. Dos cortes, traria de volta **ESTOQUE-VENDAS-SYNC, SkuPickerDialog e TINT-CATALOGO-TEMP como diagnósticos delimitados**, sem autorizar refatorações antecipadamente.

Revisei o checkout `fca92fe97`, sem editar arquivos nem ler `supabase/schema-snapshot.sql`. As medições de produção e dos runs abaixo são as fornecidas por você; não as reproduzi.

**C17 — AJUSTAR. Defeito comprovado; escopo e entrega precisam ficar mais precisos.**

O código confirma os três números problemáticos. Em [IntelligenceOperationalTab.tsx:84](src/components/intelligence/IntelligenceOperationalTab.tsx:84), ausência de ligações produz zero monetário; a consulta lança erro, mas o componente só usa `isLoading`. Na primeira leitura malsucedida, acaba mostrando zero; numa atualização malsucedida com cache, pode continuar mostrando o valor anterior sem avisar. “Margem Própria” tem o subtítulo “Últimas ligações”, o que limita parcialmente a interpretação, mas não transforma telefonia sem dados em margem medida.

O top-50 também alimenta **distribuição de saúde e quantidade de clientes em risco**, além das médias (`:93–100`, `:154`). Portanto, corrigir somente os dois cards deixaria parte do defeito. O market share em `IntelligenceStrategicTab.tsx:144–146` é matematicamente circular: acima de 33 clientes, estabiliza em 33,3%. “Est.” não legitima essa estimativa.

Remover os três indicadores sem fonte é uma entrega pequena e segura. Já “carteira completa” precisa definir população, filtro de farmer e tratamento de clientes repetidos entre farmers; **17.002 linhas não provam 17.002 clientes distintos**. Remover `.limit(50)` sozinho apenas troca o corte por 1.000. Prefiro agregado no servidor, respeitando autorização, ou paginação explícita se a opção continuar sendo frontend. A primeira alternativa exige migration além de Publish. Como contenção pequena, rotular todos os agregados como “50 clientes de maior prioridade” é honesto, embora não entregue o KPI da carteira.

**C18 — AJUSTAR. Correção necessária; impacto, paralelismo e prova estão mal delimitados.**

A cadeia está comprovada em [useFarmerScoring.ts:363](src/hooks/useFarmerScoring.ts:363): consulta sem paginação, erro descartado e cliente eliminado em `:465–466`. Sob a população e visibilidade informadas, 214 profiles ficam fora da resposta limitada. **Não significa automaticamente 214 clientes faltando na tela**: exclusões e recorte de carteira também interferem. O número precisa ser a interseção entre profiles omitidos e clientes efetivamente elegíveis.

Há outras três correções importantes na narrativa:

- O hook é **somente de exibição** (`:633–639`): não apaga assignments nem persiste scores truncados.
- `capCarteiraLer = isMaster || canViewManagerial` (`:121`) faz a leitura de assignments ser pulada (`:223`). As 17.718 linhas globais não demonstram 18 páginas para esses usuários; para vendedor, RLS e `eligible=true` alteram o denominador.
- A URL grande é risco plausível; não há evidência apresentada de um 414 ocorrido.

Fatiar IDs resolve simultaneamente limite e URL, desde que `user_id` seja único. Eu dimensionaria pelo tamanho serializado: 200 UUIDs já ficam perto de 8 KB com separadores e parâmetros. Lotes menores dão folga. Erro ou `data:null` devem abortar e preservar o último resultado bom, aproveitando o catch existente. **Profile legitimamente ausente não deve abortar tudo**: o próprio repo documenta aliases fiscais sem profile.

Separaria essa correção da aceleração. `Promise.all` reduz espera, não quantidade de trabalho; no Mini, concorrência indiscriminada pode piorar o tempo da RPC de margem. Medir por papel e limitar concorrência é melhor que prometer ganho pelas seis chamadas.

A prova proposta é insuficiente: [universo-pedidos-golden.ts:63](src/test/universo-pedidos-golden.ts:63) gera **160 clientes**, e o stub (`:340–348`) não simula a capa implícita. Manter o golden para equivalência do cálculo, acrescentando casos com mais de 1.000 profiles, falha em lote intermediário, resposta malformada e profile realmente ausente.

**C20 — DIAGNÓSTICO. Correto, mas a investigação precisa começar pela trava existente.**

A concentração temporal sustenta investigar colisão na virada da hora. Não identifica o concorrente: compare erros com **execuções efetivamente expostas** nesse intervalo, distinguindo início da rodada e momento da página 3.

O achado central é que [picking-fila-omie/index.ts:82](supabase/functions/picking-fila-omie/index.ts:82) já chama `comVezOmie`. `_shared/omie-cota.ts:5–20` documenta coordenação de `ListarPedidos` entre quatro edges. Logo, investigar:

- versão realmente implantada dos consumidores;
- chamadas externas ou caminhos que não usam a trava;
- correspondência entre conta lógica e credencial;
- chamada ainda processando no Omie após timeout/lease.

O erro aborta antes de `picking_sincronizar_fila` (`index.ts:289–297`), preservando a fila anterior. O dano é **desatualização**, não necessariamente fila vazia ou operação totalmente parada. Seis minutos é a próxima oportunidade dentro da janela do cron, não garantia de recuperação; no fim do expediente, pode ser muito mais.

Deslocar minuto é mitigação válida se houver concorrente periódico identificado. Retry curto deve repetir somente a página recusada, passar novamente pela trava e caber nos prazos de **80 s para iniciar página, 115 s para aplicar e lease de 150 s** (`:42–46`). Não misturar concorrência com `REDUNDANT` ou bloqueio por consumo indevido.

**B4 — DIAGNÓSTICO. Não aprovaria o calendário nem o ganho apresentados.**

Zero scans torna o índice candidato; não comprova inutilidade. Há consumidores plausíveis e um desencontro concreto a investigar: os índices de lista usam `DESC` sem `NULLS LAST` em `20260613210000_radar_perf_indices.sql:25–31`, enquanto a consulta usa `DESC NULLS LAST` em `20261111120000_radar_carga_publicacao_curta.sql:545`. Isso pode impedir o atendimento direto da ordenação, conforme nulabilidade e plano.

A cronologia também está incorreta. O índice normalizado aparece em `20261107040000_radar_socios_cpf_mascarado.sql:100`, e [20261111150000_radar_privacidade_titular_mei.sql:632](supabase/migrations/20261111150000_radar_privacidade_titular_mei.sql:632) substitui ambos os índices por novas expressões, preservando os nomes. Se aplicada, essa substituição reinicia a observação dos objetos novos. **30/11 não é uma data válida derivada automaticamente de 31/10.** Restart limpo também não implica reset das estatísticas. [Documentação PostgreSQL](https://www.postgresql.org/docs/17/monitoring-stats.html).

O ganho está superestimado e com erro de soma: os tamanhos listados totalizam **93 MB nos zerados e 150 MB nos cinco**, não 166 MB. São tamanhos em disco, não memória necessariamente residente que será liberada de `shared_buffers`. Menos manutenção e WAL são benefícios plausíveis, ainda não quantificados.

HOT baixo não atribui culpa a esses índices: também depende das demais colunas indexadas alteradas e de espaço livre na página. [Documentação HOT](https://www.postgresql.org/docs/17/storage-hot.html).

Manteria EXPLAIN dos **SELECTs internos**, com parâmetros representativos e definições vivas. Um `Function Scan` externo de RPC PL/pgSQL não explica a escolha dos índices internos. Trinta dias sem uso é evidência auxiliar, não autorização automática para drop. A remoção concorrente pelo founder faz sentido após essa análise.

**B5 — DIAGNÓSTICO. Correto; expurgo é alternativa, não conclusão.**

5,7 GiB acumulados em aproximadamente 11 dias equivalem a cerca de **0,52 GiB/dia naquela janela**. Não são necessariamente leituras físicas do dispositivo: as estatísticas não distinguem atendimento pelo cache do sistema operacional. Os 294 s/dia são duração do watchdog inteiro, não CPU ou tempo atribuível ao histórico. [Documentação PostgreSQL](https://www.postgresql.org/docs/17/monitoring-stats.html).

Também contestaria a lista de leitores. A versão de watchdog tint revisada lê `sync_state` em `20261020120000_tint_watchdog_corante_v4_renotifica_e_vigia.sql:267` e `:335`; referências textuais a `job_run_details` nas mensagens não são consultas. É necessário confirmar os corpos vivos e dependências indiretas de `_data_health_compute` e `v_cron_jobs_*`.

Já existe retenção de sete dias em [20260615091839_retencao_cron_job_run_details.sql:25](supabase/migrations/20260615091839_retencao_cron_job_run_details.sql:25). Expurgar sucessos dos ticks mais cedo pode ajudar, mas deve preservar a janela necessária aos consumidores e a evidência da última execução. DELETE não garante redução imediata do arquivo ou do custo de varredura; verificar vacuum e páginas ocupadas.

“Índice talvez não permitido” precisa virar uma verificação de ownership/permissões. Se permitido, um índice alinhado aos predicados reais pode preservar histórico com menos risco funcional. Medir delta e plano primeiro; nada sustenta atribuir os 6,3 s inteiros à tabela.

**E20 — AJUSTAR. É o ganho operacional mais bem sustentado.**

O comando em [.github/workflows/ci.yml:1509](.github/workflows/ci.yml:1509) varre as fontes restantes. O aumento aproximado de 198 s multiplicado por 16 partes representa **52,8 runner-min**, próximo dos 57 runner-min adicionais informados. Isso sustenta fortemente a prioridade, embora não signifique 53 minutos de redução no tempo de parede.

Atualizar somente PGDG preservando as listas restantes é uma boa hipótese de correção. Seu risco está correto e é mais amplo: índices Ubuntu antigos podem apontar para pacotes removidos, e **o download das dependências ainda pode precisar do mirror com DNS quebrado**.

Eu exigiria instalação real na mesma imagem do Actions, com fallback delimitado para atualizar fontes base quando necessário. Timeout e retries devem ter orçamento total; `Acquire::Retries` pode multiplicar a espera, e timeout HTTP não deve ser tratado como garantia de prazo total de resolução DNS. Para o update obrigatório do PGDG, `--error-on=any` permite transformar falha de atualização em erro observável. [Manual APT](https://manpages.debian.org/bookworm/apt/apt-get.8.en.html).

O laboratório **extrai o step do YAML**, não mantém apenas uma cópia textual (`scripts/lab-retry-pgdg/lab.sh:48–55`). Porém, seus dublês (`:143–159`) não provam resolução de dependências, preservação das listas nem comportamento de warnings com exit zero. Manter o lab e validar o caminho real; não começaria por cache.

**E21 — AJUSTAR. Mitigação razoável; causa ainda não demonstrada.**

O incidente sustenta falha intermitente de materialização. Não prova que `maxBuffer` truncou silenciosamente o arquivo. Em [sonda-cron-prova.ts:302](scripts/sonda-cron-prova.ts:302), `execFileSync` deveria completar antes da escrita; pelo contrato Node, falha do processo lança exceção. O CI executa isso sob **Bun 1.3.14** (`ci.yml:592`), portanto uma diferença do runtime é hipótese a testar, não causa estabelecida. [Contrato Node](https://nodejs.org/api/child_process.html#child_processexecfilesyncfile-args-options).

`git archive --format=tar -o ...` elimina o transporte binário pelo buffer e é uma simplificação defensável. Tamanho positivo não prova integridade: exigir sucesso da extração e presença dos arquivos esperados.

Aceito uma retentativa **só da materialização**, em diretório novo, registrando SHA, etapa, tamanho, exit e stderr. Persistindo a falha, `Mecanica` e exit 2, como `:620`. Não repetir automaticamente resultados dos gates nem transformar ausência de veredito em aprovação. P é adequado; não generalizar 1/80 como taxa estável.

**Sobre os cortes:**

- **HIST-COMPRAS-ITENS — manter o corte, condicionado ao denominador correto.** `useHistoricoCompras.ts:44–48` realmente pode truncar e `:78–83` então subconta itens. “Tabela pequena” precisa significar que nenhum conjunto dos 50 pedidos selecionados ultrapassa 1.000 itens. A média por pedido não basta. Sem ocorrência atual, não antepor a C18.
- **FIN-TITULO-VALOR-ZERO — manter o corte.** `omie-financeiro/index.ts:785` e `:948` têm fallback perigoso, mas os dados fornecidos não demonstram dano atual. Contar zeros no destino não detectaria um zero legítimo substituído por `nValorTitulo`; isso limita a evidência, sem justificar reabrir sozinho.
- **PEDIDO-TOTAL-NULO — manter o corte.** `vendas-kpi-dia.ts:38–40` trata desconhecido como zero, mas a população medida não ativa esse ramo. Defeito latente, sem prioridade demonstrada.
- **HOME-CONFIABILIDADE — manter o corte.** Em `useFinanceiroZone.ts:84–99`, falta escopo empresarial, mas tabela vazia conserva `null` e a tela mostra “—” (`:119`). Voltar quando houver produtor/dados; para modo consolidado, apenas acrescentar `.eq(company)` também não resolve.
- **ESTOQUE-VENDAS-SYNC — voltar como DIAGNÓSTICO.** O writer está ativo no catálogo: `useProductCatalog.ts:126–128` chama `sync_estoque`; `omie-vendas-sync/index.ts:637–651` pode sobrescrever saldo conhecido com zero. `_shared/pos-estoque.ts:57–58` não protege esse caminho. Medir payloads sem saldo e exposição do writer; não usar “não medido” como equivalente a “sem problema”.
- **SkuPickerDialog — voltar como DIAGNÓSTICO.** O filtro de família (`:40`) não prova cardinalidade inferior à capa. `.limit(2000)` (`:42`) não vence o teto de 1.000 informado. Medir maior família OBEN; acima do teto, busca local e “Selecionar todos” (`:98`) omitem SKUs silenciosamente.
- **RECEB-XML — manter o corte.** Com XML nulo nas 92 notas, o ganho de payload alegado não existe hoje.
- **PK-FEFO — manter o corte de velocidade.** `AdminEstoquePicking.tsx:154` retorna antes da segunda consulta quando não há tasks. Não confundir essa tabela antiga com `picking_tarefas`, usada pelo fluxo de C20.
- **PEDIDOS-POLL — manter o corte.** O volume informado não sustenta prioridade. Bytes pequenos não provam consulta barata, mas também não há tempo elevado demonstrado que justifique a mudança.
- **REPO-CHARTS — manter o corte, corrigindo a justificativa.** Precache em `vite.config.ts:177–181` reduz download repetido; não elimina parse/execução do módulo em documentos novos. Sem medição da rota, ainda falta benefício demonstrado.
- **RECEB-WATERFALL — manter o corte por falta de latência medida.** Noventa e duas notas limitam volume, mas não eliminam round trips sequenciais. O tamanho da tabela, sozinho, não decide esse item.
- **ACOES-ZUMBIS — manter o corte.** `rotulo.ts:19–24` mostra “interrompida?” após duas horas; não finaliza a execução nem prova que ela morreu. Sem bloqueio operacional ou efeito incompleto demonstrado, não criar limpador automático.
- **TINT-CATALOGO-TEMP — voltar como DIAGNÓSTICO, sem refatorar preço.** `CREATE TEMP TABLE ... AS` aparece, por exemplo, em `20260722113000_tint_fase1d_is_base_pura.sql:299` e `:506`. Tabelas temporárias podem gerar I/O local; “não disco” é incorreto. Medir uma promoção representativa, incluindo buffers locais, temporários de sort/hash, duração e WAL. As rajadas excluídas da janela limpa tornam esse diagnóstico pertinente. [Documentação de buffers temporários](https://www.postgresql.org/docs/17/runtime-config-resource.html).
- **FILA-40 / MUTCHECK-CRESCE — manter fora desta entrega.** Remedir fila depois de E20 evita atribuir espera compartilhada ao mecanismo errado. Mutation-check continua no programa de tempo de merge, com comparação por composição equivalente.
- **MAIN-VERMELHA-PELO-BOT — manter o corte de máquina nova.** `CLAUDE.md:56` sustenta a restrição. Isso não proíbe corrigir a origem do sync ou restaurar arquivos; proíbe justificar novo aparato somente pelo vermelho.
- **HTTP-RESPONSE-INCHADO — manter o corte, rejeitando “só CPU”.** `_http_response` é UNLOGGED, não memória pura: pode ocupar heap/TOAST, buffers e gerar I/O. Os 22 MB não provam payload vivo excessivo; separar conteúdo, índices e espaço reutilizável antes de agir. Há TTL próprio documentado, também reconhecido em `20260615091839_retencao_cron_job_run_details.sql:15–18`. [Documentação Supabase](https://supabase.com/docs/guides/database/extensions/pg_net).

**O fato geral deve permanecer como sinal promissor, não como baseline diário consolidado.** A janela limpa de 29 minutos exclui precisamente cargas potencialmente dominantes. Não sustenta afirmar redução diária de 48 para 5,5 GiB nem atribuir toda a diferença ao #3813. Comparar deltas em ciclos completos, incluindo as rajadas citadas, sem confundir misses de `shared_buffers` com I/O físico.

| item | seu veredito | 1 linha |
|---|---|---|
| C17 | AJUSTAR | Remover números sem fonte; corrigir também distribuição/risco e definir população do agregado. |
| C18 | AJUSTAR | Corrigir profiles agora; separar aceleração e testar mais de 1.000 clientes com capa realista. |
| C20 | DIAGNÓSTICO | Investigar colisão apesar da trava existente; retry deve respeitar prazos e coordenação. |
| B4 | DIAGNÓSTICO | Rever planos, idade dos objetos e expressões; tamanho em disco não equivale a RAM liberada. |
| B5 | DIAGNÓSTICO | Atribuir custo por delta e leitor antes de escolher expurgo ou índice. |
| E20 | AJUSTAR | Ganho forte; atualização PGDG isolada exige instalação real e tratamento das dependências Ubuntu. |
| E21 | AJUSTAR | Arquivo direto e um retry de materialização são válidos; causa do EOF permanece aberta. |
| HIST-COMPRAS-ITENS | CORTAR | Confirmar máximo de itens nos 50 pedidos; ausência de ocorrência mantém baixa prioridade. |
| FIN-TITULO-VALOR-ZERO | CORTAR | Fallback arriscado, sem dano atual demonstrado pelas medições. |
| PEDIDO-TOTAL-NULO | CORTAR | Ramo problemático não aparece na população medida. |
| HOME-CONFIABILIDADE | CORTAR | Sem dados, não há contaminação empresarial atual na tela. |
| ESTOQUE-VENDAS-SYNC | DIAGNÓSTICO | Voltar: writer ativo pode zerar saldo conhecido; helper irmão não o protege. |
| SkuPickerDialog | DIAGNÓSTICO | Voltar: filtro por família não demonstra resultado abaixo de 1.000. |
| RECEB-XML | CORTAR | XML nulo elimina o ganho de payload alegado hoje. |
| PK-FEFO | CORTAR | Sem tasks, a segunda consulta nem executa. |
| PEDIDOS-POLL | CORTAR | Volume e evidência atuais não sustentam prioridade. |
| REPO-CHARTS | CORTAR | Precache não elimina execução, mas falta ganho medido na rota. |
| RECEB-WATERFALL | CORTAR | Falta latência medida; 92 linhas não provam nem descartam custo de rede. |
| ACOES-ZUMBIS | CORTAR | Rótulo evita andamento eterno; falta consequência operacional que justifique limpeza. |
| TINT-CATALOGO-TEMP | DIAGNÓSTICO | Voltar para medir rajada; temporárias não são isentas de I/O. |
| FILA-40 | CORTAR | Remedir após E20, no programa de tempo de merge. |
| MUTCHECK-CRESCE | CORTAR | Investigar separadamente, comparando execuções equivalentes. |
| MAIN-VERMELHA-PELO-BOT | CORTAR | Não criar máquina nova com esse incidente de CI como justificativa. |
| HTTP-RESPONSE-INCHADO | CORTAR | “Só CPU” está errado, mas 22 MB isolados não justificam intervenção. |
| Baseline pós-#3813 | DIAGNÓSTICO | Validar ciclos completos; 29 minutos sem rajadas não estimam o dia inteiro. |

