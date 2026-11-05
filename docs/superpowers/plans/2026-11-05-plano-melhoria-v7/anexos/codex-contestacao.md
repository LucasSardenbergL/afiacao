=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 443s · 145.047 tokens) ===
Revisei o checkout **`80c74384b`**; a referência local `origin/main` já aponta para outro commit. Não alterei arquivos, não acessei produção e não abri `schema-snapshot.sql`. Os números de produção e CI abaixo são os fornecidos por você; a conferência independente foi estática, no código.

**C7 APROV-FANTASMA · AJUSTAR**

**Conferência:** `supabase/functions/omie-cliente/index.ts:1311–1337` reutiliza perfil encontrado por documento e, somente quando cria outro, insere sem `prospect_source`. Os filtros já existem em `src/pages/AdminApprovals.tsx:55–61` e `src/hooks/dashboard/useSistemaZone.ts:48–55`.

O corte correto é **(a) + (b), com procedência comprovada no backfill**:

- Marcar `omie_import` somente no perfil novo criado pelo importador. Não reclassificar o perfil real reutilizado por documento.
- Os 16.070 são o conjunto candidato, não uma prova suficiente de origem. Cruzar com o usuário Auth criado como placeholder — o escritor registra `is_placeholder: true` em `index.ts:1319` — e tratar divergências separadamente.
- Aplicar o backfill pelo envelope/founder, sem alterar aprovação, papéis ou vínculos fiscais.

**Cortar (c) como regra permanente.** `omie_customer_account_map` prova vínculo comercial, não ausência de pedido de acesso. O próprio importador vincula perfis preexistentes (`:1353`), e a aprovação reconhece o caso legítimo “já vinculado” (`AdminApprovals.tsx:177`). Um `NOT EXISTS` por usuário não duplica aliases, mas continua semanticamente errado: pode esconder cliente real vinculado. Não resolver por documento nem apagar aliases.

A ausência de escalada para master retira esse risco do item; permanece um defeito operacional de aprovação. Paginação da fila real é residual, não substitui corrigir a origem.

**C8 CAD-ZERO · AJUSTAR**

**Conferência:** `src/pages/AdminReposicaoCadastros.tsx:44,59,68,85` devolve zero em falha; `:95–109` também transforma ausência inicial em zero. O anti-join no cliente está em `:55–71`.

Manter imediatamente estados distintos de carregamento, falha e zero medido. Corrigir apenas os `return 0` sem ajustar a renderização não basta.

**Separar a RPC da justificativa atual:** pelos volumes fornecidos, não existe truncagem hoje. `COUNT … NOT EXISTS` é uma implementação melhor se substituir essa leitura agora, mas não precisa virar condição para entregar a correção honesta. Se entrar, preservar o recorte por **empresa + SKU**, `ativo=true` e as permissões; não usar diferença entre contagens, que não equivale a contar SKUs sem vínculo. Sem novo gate: a dívida já consta em `src/__tests__/single-shot-truncado-gate.test.ts:81`.

**C9 MERC-PROMO · AJUSTAR**

**Conferência:** `src/pages/AdminReposicaoMercado.tsx:66–67` fabrica zero; o card fixa `unavailable: false` em `:134`.

**Premissa parcialmente falsa:** os três irmãos carregam a indisponibilidade, mas o render ainda imprime `c.value` incondicionalmente (`:164`) e acrescenta “Sem dados disponíveis” (`:165–166`). Portanto, mostram **zero com ressalva**, não um número ausente.

No mesmo lote de C8, corrigir promoções e o render comum: indisponível → `—` e motivo; carregando → estado de carregamento; zero → somente leitura bem-sucedida. Não copiar integralmente o padrão atual dos irmãos.

**C10 OPP-ERRO · MANTER**

**Conferência:** `src/pages/AdminReposicaoOportunidades.tsx:106–119` lança o erro, mas consome `data=[]` sem estado de falha. As somas começam em zero (`:218–237`). `src/components/reposicao/oportunidades/OportunidadesTable.tsx:34–35` interpreta contagem zero como vazio real.

Usar o estado da consulta para governar **KPIs e tabela**, reaproveitando `estadoDeLeitura`, já usado na própria página (`:95–103`). Falha inicial não pode afirmar economia zero nem ausência de oportunidades. Falha de atualização com dados anteriores deve identificá-los como desatualizados.

Não ampliar este item para uma reforma do otimizador ou da paginação sem evidência adicional.

**C11 MELH-BADGE · AJUSTAR**

**Conferência:** `src/hooks/useMelhorias.ts:150–162` confirma o zero em falha. Entretanto, `src/components/AppShell.tsx:595–596` só apresenta badge quando o valor é positivo.

**Trocar `0` por `null` não resolve o sintoma:** ambos continuam sem badge. O comentário de `useAlertasCriticos.ts:13–15` assume explicitamente essa ocultação.

Escolher um contrato completo: consulta lança, conserva eventual valor anterior e o consumidor distingue indisponibilidade; ou retorna estado explícito com representação correspondente. Não criar um sistema global de alertas por isso. Prioridade inferior às correções monetárias e de aprovação.

**C12 FAM-1000 · MANTER**

**Conferência:** `src/components/reposicao/aumentoDetail/MapeamentoDialog.tsx:49–58` lê produtos com `.limit(5000)` e deduplica depois. O caso já está registrado na baseline em `src/__tests__/single-shot-truncado-gate.test.ts:67`; isso não significa que foi corrigido.

Com a medição de 85 contra 75 famílias, há perda atual comprovada. Prefiro **distinct no servidor**, mantendo o mesmo universo e autorização; paginação estável dos produtos também resolve sem criar RPC. Uma view deve preservar RLS explicitamente.

Não trocar por um limite maior. Os cortes locais de 30/50 sugestões (`:100–101`) são outro mecanismo: a busca ocorre sobre a lista carregada, portanto não recupera famílias que nunca chegaram. Testar uma família cuja única ocorrência fique depois da primeira página.

**F12 C360-PARALELO · AJUSTAR**

**Conferência:** `src/components/customer360/hooks.ts:81–102` serializa score e margem. **Os dois erros**, da leitura própria e do fallback, são descartados. `src/lib/scoring/margemScores.ts:63–65` confirma que a margem só precisa do cliente.

Paralelizar a cadeia “próprio → fallback” com a margem. Preservar:

- Fallback apenas quando a leitura própria teve sucesso sem linha.
- Falha da margem degradando somente a margem, como já ocorre.
- Estado de erro no consumidor: `src/pages/Customer360.tsx:127` atualmente extrai apenas `score.data`.

“−1 RTT” é hipótese, não resultado: o ganho é a sobreposição das durações, e clientes sem score passam a provocar uma chamada de margem antes dispensada. Laboratório deve incluir score próprio, fallback e ausência legítima.

**F13 HOME-DND · MANTER**

**Conferência:** import estático em `src/components/dashboard/CockpitGrid.tsx:2`; contexto montado sempre em `:72`; `isDragDisabled` apenas desativa o comportamento (`:92`).

Separar a implementação editável em módulo carregado sob demanda. Confirmar no build e na rede que a home deixou de alcançar o DND: há outro consumidor em `src/components/KanbanBoard.tsx:3`.

**Já entregue:** `vite.config.ts:365–370` separa dependências compartilhadas que antes puxavam charts. Não atribuir novamente esse ganho ao F13 nem tratar os 31 KB isolados como economia garantida da navegação.

Laboratório antes/depois, incluindo primeira entrada na edição, teclado, reordenação e persistência. Cuidado com remontar zonas e perder estado ao alternar os dois layouts.

**E14 ESCOPO-MAIN · AJUSTAR**

**Conferência:** `scripts/provas-sql-escopo.ts:166–168` força execução fora de PR; `:226–232` sequer calcula diff nesses eventos. O dispatch está em `.github/workflows/auto-merge.yml:118`. Além disso, **`validate` só aceita o skip em `pull_request`** (`.github/workflows/ci.yml:1501–1515`).

**Reabre uma proposta mais estreita; não reabre E2 integralmente.** O fato novo é haver escopo conservador implementado e custo medido. A ausência de merge queue e a necessidade de validar combinações continuam.

Eu faria a primeira entrega somente para **diff cumulativo exclusivamente documental**, com estas condições:

- Base ancestral cujo SQL e união efetivamente terminaram verdes; “workflow verde” sozinho pode significar provas puladas.
- Comparar com o SHA fixo deste run, não com a referência móvel de main.
- Base desconhecida, inacessível, não ancestral ou diff inconclusivo → executar.
- Push direto e cron diário continuam completos; adaptar também o `validate` e seus testes existentes.

**Não estender automaticamente toda a allowlist do PR à main.** O próprio script documenta leituras dinâmicas invisíveis ao cálculo (`:18–20`), e `docs/historico/ci-provas-sql-escopo.md:39` define a execução completa na main como cobertura desse residual. Estender a `src/`, `public/` e `.claude/` muda esse contrato.

A economia potencial é aproximadamente **145 − 39 = 106 runner-min por run elegível**, não 145. Oito merges documentais não garantem oito skips: pode haver mudança funcional ainda não validada no intervalo acumulado.

**E16 N=7 · MANTER**

**Conferência:** matriz ainda com seis partes em `.github/workflows/ci.yml:1152`. O runner recebe o total pela estratégia (`:1375`); a união já é genérica (`:1462`). N=7 segue apenas como opção em `docs/historico/ci-lote6-v6-lpt-remedido-e-shard-vitest.md`.

O crítico medido justifica experimentar. **19,0 observado contra 16,4 previsto não prova desbalanceamento**: o documento mostra forte variação entre runners. N=7 reduz carga atribuída por parte; não elimina essa variação.

Medir parede até `validate`, p90 de fila e runner-min, além da pior parte. Não criar outro balanceador ou sensor. O ganho de 2–2,5 minutos fica como hipótese; preservar a união e considerar o trabalho extra exclusivo da primeira parte (`ci.yml:1393`).

**E17 CI-RADAR-ESPERA · AJUSTAR**

**Conferência:** as pausas existem em `db/test-radar-cadastro-conflitos.sh:239,469`, mas sustentam transações abertas enquanto o teste observa bloqueios (`:228–245`, `:472–476`).

A estimativa de 20–30 segundos está insuficientemente fundamentada. São **sete retenções de dois segundos por passagem completa**, e `--falsificar` executa controle mais 15 sabotagens (`:37–62`). O núcleo também roda a passagem normal. Algumas sabotagens abortam antes; outras atravessam as esperas. O custo medido do conjunto é **360 s**, em `db/nucleo-ci-custo.txt:101`.

Experimento válido: substituir a retenção fixa por liberação após observar o bloqueio, com timeout de falha e tratamento de término antecipado da sessão. **Não apenas diminuir o sleep.** Manter as sabotagens de remoção de lock acusadas pelo motivo correto.

Depois, atualizar o custo LPT e medir o crítico completo. Economizar segundos numa prova não implica economizar os mesmos segundos no `validate`.

**D10 CR-MAPA · AJUSTAR — prioridade máxima**

**Conferência:** `supabase/functions/fin-cashflow-engine/index.ts:414–439` carrega o mapa em cada chamada de `carregarDados`; `:1371` repete essa carga para cada cálculo. O cron ainda enfileira três cenários por empresa em `supabase/migrations/20261020120100_fin_cashflow_snapshot_cron_escalonado.sql:52–60`. O fechamento em falha já está correto em `_shared/baixas-cr.ts:25–43,51–63`.

**Cortar “cache por empresa/dia” como desenho inicial:** isso introduz frescor intradiário e invalidação num caminho financeiro. Prefiro **uma carga de dados por execução dos três cenários**, compartilhada dentro da invocação, mantendo o contrato interativo de cenário único.

Não basta chamar `calcular()` três vezes: ele releria tudo. Extrair a carga comum, preservar independência dos cálculos e reconciliar alertas somente pelo realista (`index.ts:1445`).

`work_mem` local é alternativa experimental, não causa comprovada: spill e 3,9 s isolados não demonstram que memória resolverá o timeout concorrente. Preservar a guarda de equivalência da RPC com a view (`20261019110100_fin_titulo_baixas_cr_mapa.sql:61–66`).

Exigir prova PG17 e comparação financeira dos três cenários. A persistência atual usa `INSERT` (`index.ts:1416`), portanto retry de lote não é automaticamente idempotente. O plano deve incluir recomputar o cenário faltante após a correção; publicar código não repara o snapshot.

**D11 GDH · AJUSTAR**

**Conferência:** o último corpo encontrado contém as leituras repetidas do último sync em `supabase/migrations/20261031191715_data_health_saldo_bancario_conta_a_conta.sql:135–143`.

Duas correções de premissa:

1. **Já existe índice** `(action, status, completed_at DESC)` em `20261101201804_indices_lote7_seq_scans.sql:44–45`. Ele não corresponde diretamente à busca global pelo último `completed_at`; “sem índice” é amplo demais.
2. Nesse corpo versionado, `cron.job_run_details` e `net._http_response` aparecem em **mensagens de diagnóstico**, por exemplo `:212–214`, não como leituras diretas dessas tabelas. Se produção diverge, é preciso identificar o corpo efetivamente medido.

Manter diagnóstico por trecho e em três horários. Os 2,1 s com zero blocos lidos enfraquecem atribuir **essa execução** a leitura física; não identificam sozinhos CPU, contenção ou causa da diferença. O D6 já classificava IO como hipótese não provada (`docs/historico/d6-watchdog-diagnostico-v6.md:36–38`).

O polling é de 120 s, sem background (`src/hooks/useDataHealth.ts:17–18`), e o badge é restrito a master/gestor (`src/components/shell/DataHealthBadge.tsx:18–20`), não a toda sessão indiscriminadamente.

Diagnosticar o compute puro; não executar watchdog com efeitos para “medir”. Preservar o acoplamento do trio em eventual mudança.

**D12 RADAR-IO · MANTER, somente diagnóstico**

**Conferência:** `idx_radar_empresas_local` é `(uf, municipio_nome)`, em `supabase/migrations/20260610200000_radar_fundacao.sql:45–46`. Os contadores fornecidos justificam procurar quais consultas estão provocando as leituras.

**Não concluir:** tabela maior que `shared_buffers` não prova necessidade de ampliar memória; `heap_blks_read` não equivale necessariamente a bytes físicos lidos do armazenamento, pois há cache do sistema operacional. Os 16 scans também não identificam o chamador nem o custo temporal.

Em 07/11, comparar deltas desde o reset, chamadas, tempo total/médio, blocos e planos das consultas responsáveis. Separar cron, importação e uso interativo. Nenhum índice, reescrita ou corte por limite está autorizado pela evidência atual.

**SLA-5000 · CORTAR — manter o corte**

`src/components/reposicao/slaFornecedor/useSlaFornecedor.ts:47–50` confirma o limite inadequado como garantia de completude, mas 607 linhas não comprovam perda atual. Dívida latente, abaixo de C12 no ranking. Reabrir com crescimento ou ao tocar essa leitura.

**HIST-CICLOS · CORTAR a truncagem — manter o corte**

`src/pages/AdminReposicaoCadastros.tsx:245–252` lê até 2.000 e pagina localmente (`:259–263`); 784 linhas totais não sustentam truncagem atual.

Há outro defeito: `:253` transforma erro em lista vazia. Incorporá-lo ao lote de C8, sem reabrir um projeto de paginação.

**CONFIABILIDADE · CORTAR — manter o corte**

`src/components/financeiro/cockpit/useFinanceiroCockpit.ts:74–85` faz as leituras seriais e ignora o erro retornado. Contudo, a fonte está nominalmente em `docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/anexos/tabelas-jamais-escritas.txt:74`.

Não otimizar consulta sem produtor. Isso não autoriza transformar ausência em confiabilidade boa; apenas mantém fora deste lote a superfície sem dado.

**MAP-EMPATE · CORTAR — manter o corte**

`supabase/functions/omie-financeiro/index.ts:1911–1917` ordena defaults antes de específicos e sobrescreve por código. A precedência entre esses dois escopos existe; a ambiguidade depende de duplicidade conflitante dentro do escopo.

Com zero conflitos medidos, não há defeito atual demonstrado. A paginação do leitor de configuração já foi entregue em `src/services/financeiroService.ts:924–938`; não contabilizá-la novamente.

**FARMER-CALLS · CORTAR — manter o corte**

`src/pages/FarmerCalls.tsx:162–181` confirma leitura dos últimos 100 registros e posterior consulta de nomes. Com tabela vazia e telefonia congelada, não há justificativa para otimizar ou ampliar essa superfície. O eixo “mais recentes” é coerente com um histórico de chamadas.

**E15 SONDA-CRON · CORTAR — manter o corte**

O step permanece em `.github/workflows/ci.yml:385`. O ganho informado é pequeno e não ataca o crítico atual. Fila p90 de 0,9 minuto não reabre E11 nem justifica novas condições de escopo.

**Acréscimos**

**1. MAP-SALVAR · acrescentar ao lote de C12**

Em `MapeamentoDialog.tsx:63–72`, falha na leitura dos mapeamentos deixa o consumidor com `[]`; o botão continua habilitado (`:301`). Salvar apaga primeiro (`:131–136`) e insere depois (`:161–165`), em operações independentes.

Duas formas de perda: salvar sobre leitura desconhecida ou falhar no insert depois de apagar. Bloquear edição/salvamento até conhecer o estado e realizar a substituição de forma transacional, preservando autorização. Provar que falha de gravação mantém o mapeamento anterior. É risco demonstrável no código, não incidente de produção que eu tenha reproduzido.

**2. MAP-ESCOPO · acrescentar ao mesmo lote**

Em `MapeamentoDialog.tsx:145–157`, `apenasEspecificos=true` com seleção vazia cai no ramo que grava `sku_codigo_omie_especifico: null`. Isso significa **família inteira**: a condição SQL está em `supabase/migrations/20260930230623_hoje_sp_views_defaults_classe_ii.sql:733`.

Reprodução estática: selecionar “específicos”, fechar o picker sem selecionar e salvar. O resultado amplia o escopo contra a escolha exibida. Exigir ao menos um SKU ou uma escolha explícita de família inteira. Não é necessário novo gate ou sensor.

**Ordem recomendada de lotes**

1. **D10 isolado:** corrigir a recorrência financeira, provar equivalência e incluir reparo do snapshot faltante.
2. **C7:** escritor + backfill por procedência + conferência dos dois leitores.
3. **C12 + MAP-SALVAR + MAP-ESCOPO:** completar o catálogo e impedir perda/ampliação indevida do mapeamento.
4. **C8 + C9 + C10 + C11:** estados honestos até o consumidor; incluir o erro do histórico de ciclos no mesmo arquivo.
5. **E16:** experimentar sete partes e medir o resultado completo.
6. **E14 restrito:** escopo documental cumulativo com ancestral efetivamente provado. **E17 depois**, como experimento separado, sem misturar ganhos.
7. **F13, depois F12:** laboratório antes/depois, sem alegar ganho populacional com um usuário.
8. **D11/D12:** diagnóstico somente leitura em trilha paralela; o resultado decide se haverá lote de implementação.

Cada lote fecha com evidência própria. Melhorias adicionais de produto continuam condicionadas ao sinal de uso da fase anterior; nenhuma dessas propostas exige criar uma máquina meta nova.

