=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 205s · 138.390 tokens) ===
**Eu cortaria C3 do v6 atual e D7 como investigação de defeito. Rebaixaria F10/F11 a diagnóstico e F8 até comprovar uso do consolidado.** As maiores premissas erradas são: o lease dos scores não deduplica o dia; a fila de contatos está congelada; e contar hooks não conta requisições ativas.

Conferi o checkout `81cbd3e31`. Não editei arquivos nem abri `supabase/schema-snapshot.sql`. Tratei suas medições de produção como dados fornecidos.

**Um usuário não invalida automaticamente os F.** A regra exige sinal positivo com denominador, não dois usuários. O founder pode ser o usuário legítimo de uma superfície administrativa. Porém:

- Vitals provam navegação instrumentada; não distinguem, sozinhos, trabalho real de visita de laboratório.
- 16.070 cadastros customer não são denominador de usuários operacionais dessas telas.
- Falta separar rota, persona, build adotado e tarefa realizada. Os sensores existentes e a confirmação do founder podem responder; não cabe criar outra máquina.
- C pode justificar correção sem adoção demonstrada quando há comportamento errado reproduzível numa superfície disponível. **“Money-path” não libera investimento em módulo deliberadamente congelado.** C3 é esse contraexemplo.

Nos itens de correção:

| Item | Veredito | Contestação |
|---|---|---|
| **C1 A4-DADO** | **AJUSTAR** | Defeito confirmado, mas trocar apenas `:152–157` deixa outra fabricação em `fin-next-best-action/index.ts:69`: `disponivel ?? 0`. O classificador também não exige disponibilidade conhecida (`:70`). Corrigir transporte, helper espelhado, classificação e contrato frontend (`financeiroService.ts:1398`). Propagar motivos da A1, distinguindo cobertura desconhecida de saldo conhecido. Nem todo motivo da A1 invalida caixa: `fin-cashflow-engine/index.ts:599` registra degradação de PMR/PMP/CCC. **Não transformar qualquer degradação em nulidade indiscriminada.** |
| **C2 REC-ZERO** | **AJUSTAR** | Manter a correção dos **quatro cards**, não só trânsito/divergências: pendentes e efetivadas repetem o erro em `AdminEstoqueRecebimento.tsx:41–46,86–93`. Só lançar na query não basta: a renderização ainda fabrica zeros em `:104,111,118,125`. Separar os formatadores: em grupos, os hooks já convertem os valores antes deles (`useGrupoComercial.ts:26,47`; `useGrupoFinanceiro.ts:38,56`). Alterar apenas `formatBRL` pode não mudar nenhum resultado. Exigir consumidor demonstrado, conforme o corte E5 do v5. |
| **C3 FILA-TICKET** | **CORTAR do v6 atual** | O defeito é mais forte: ticket ausente vira zero e **exclui** por `valor_nao_paga`, antes da ordenação (`contact-list.ts:80,95–99`). Entretanto `/rota` está congelada até 10/01/2027 (`manifesto.ts:781–787`), com bloqueio de navegação; o consumidor externo também desabilita a query (`useCriticaFila.ts:54`). Reabrir na retomada do módulo. Não inventar ticket substituto para fazê-lo entrar na fila. |
| **C4 SKU-DEMANDA** | **AJUSTAR** | Há erro silenciado, mas **falha não gera 90 pontos em zero**: retorna `[]` em `SkuDetailSheet.tsx:117`. Uma consulta bem-sucedida sem vendas passa pelos buckets e gera os zeros (`:122–130`). O gráfico recebe vazio sem aviso (`:417`). Corrigir estados de leitura e degradação dos stats; não apresentar a premissa como “mesmo gráfico de SKU parado” nem afirmar que altera o motor de demanda. |
| **C5 DES-HIST** | **AJUSTAR** | Confirmado, com escopo maior no mesmo fluxo. `useHistoricoData.ts:118` usa `live.meta_pessoal` também para trimestre antigo sem meta: **transporta a meta atual para o passado**. O hook lança erros nas queries, mas só expõe loading (`:165–181`). Além disso, o trimestre passado exibe “Meta não atingida” (`QuarterCardItem.tsx:35–42`); “0% da meta” aparece apenas no atual (`:77–89`). Corrigir nulidade, procedência temporal e julgamento visual juntos. |

Nos itens de velocidade:

| Item | Veredito | Contestação |
|---|---|---|
| **F7 CR-BOOT** | **AJUSTAR** | É o F mais sustentado: duplicação comprovada e medição específica do boot. `useDisplayAccess.ts:37` instancia o hook que faz fetch por instância. Semear pela **resposta bem-sucedida**, nunca pelo estado `commercialRole` do contexto: `AuthContext.tsx:172` não distingue erro comercial de ausência. Compartilhar leitura do usuário real, preservando lente, chave por usuário, invalidação e comportamento de autorização em refetch falho. Os ~0,55 s são ganho candidato de laboratório, não redução demonstrada do LCP. |
| **F8 DRE-IO** | **AJUSTAR — condicionado ao uso** | Série confirmada em `useFinanceiro.ts:243–245`; transformação pequena e plausível. Mas não há sinal fornecido de uso de **DRE consolidado**. Confirmar essa superfície antes de promovê-la a lote. Preservar geração, ordem dos resultados e falha integral. Estar no domínio financeiro não torna uma otimização de IO uma correção de dinheiro. |
| **F9 TINT-COUNT** | **AJUSTAR** | Os 8 s frios justificam investigar a consulta, mesmo com um usuário. **`staleTime` longo não resolve a primeira visita sem cache.** E a chave única reúne fórmulas, mapeamentos e última importação (`TintDashboard.tsx:23–43`): aumentá-lo congela todos. Separar a contagem cara; se estimada, rotulá-la como aproximada e preservar filtro por account. O LCP com n=1 não atribui causalidade ao count. |
| **F10 RADAR-RTT** | **CORTAR como implementação; manter hipótese** | Rodada e lote começam em paralelo; rodada só bloqueia o preset score (`useRadarLista.ts:116–129`). A lista espera o lote por correção, inclusive para não misturar páginas de lotes diferentes (`:132–141`). Irmãos chegam depois, mas **não bloqueiam a lista nem mudam sua ordem** (`useRadarIrmaos.ts:13–15`). Há três etapas até o enriquecimento completo no caminho frio; não está provado que existam três RTT no caminho crítico do LCP. |
| **F11 BOOT-ADIAR** | **AJUSTAR — diagnóstico primeiro** | A contagem de ~13 polls superestima o ativo: telefonia, tarefas e WhatsApp estão condicionados ao congelamento em `AppShell.tsx:533,538,547`. Outros compartilham cache com páginas. Medir requisições realmente disparadas e competição no boot; depois adiar somente consumidores secundários. O precedente `AppShellLayout.tsx:84–92` usa idle/timeout: não comprova que os dados da rota já pintaram. Adiar também não elimina o custo recorrente de `get_data_health`. |

Nos itens de CI:

| Item | Veredito | Contestação |
|---|---|---|
| **E9 LPT** | **MANTER** | Atualização de mecanismo existente, com desequilíbrio medido. O próprio `nucleo-ci-custo.txt:5–17` prescreve re-medição e soma normal + falsificação. **Retirar a promessa de ~3 min por PR:** média das medianas não é duração balanceável de um run; setup, fila e provas indivisíveis interferem. Comparar distribuição prevista com durações por prova dos mesmos runs. |
| **E10 SHARD** | **AJUSTAR — experimento limitado** | O caminho crítico em 6/11 PRs sem provas sustenta tentar dois shards. Não sustenta “metade de 7,3 min”: duplica setup, consome outra vaga e pode aumentar fila. Preservar `forks`/isolamento — `vitest.config.ts` documenta dependência de `process.chdir()`. Aceitar se melhorar parede até `validate`, com toda a suíte distribuída, contabilizando runner-min. |
| **E11 ESCOPO-FALSIF** | **AJUSTAR** | Ganho direto é runner-min; ganho de fila é hipótese dependente de concorrência. “Parede igual” também é forte demais, especialmente depois de E10. O `validate` atualmente rejeita falsificação pulada (`ci.yml:1475–1497`). Adaptar decisão de escopo e agregação juntas, conservadoramente. Não presumir que todo `docs/**` é irrelevante: testes e gates podem ler documentação. A sonda envolve closures históricos e harness (`:363–369`), não só a edge alterada. |
| **E13 V8-LOTE** | **AJUSTAR** | Um Node por módulo confirmado em `edges-sintaxe-gate.ts:221–223`, já com pool limitado. Atenção: o script roda em **Bun**; “in-process” ali pode trocar o motor que o gate pretende verificar. Usar processo Node persistente para parse V8, sem executar módulos, preservando diagnóstico TS, calibração e falha quando não conseguiu checar. Os 146 ms de parse não equivalem ao tempo total: transpile continua em `:279–288`. É otimização do gate existente, ancorado em #2720. |

Nos itens de banco:

| Item | Veredito | Contestação |
|---|---|---|
| **D6 WATCHDOG** | **MANTER diagnóstico, ajustar hipótese** | Crescimento merece atribuição; scans agregados não identificam o responsável. `_data_health_compute` tem várias leituras de `fin_sync_log` na migration `20261031191715…:135–162`, mas `fin_sync_watchdog_check` é outro caminho, descrito como independente do trio acoplado em `20260704160000…:45–47`. Conferir definições vivas e planos das consultas internas. **EXPLAIN da chamada externa pode esconder o custo interno; EXPLAIN ANALYZE do watchdog executa seus efeitos.** O diagnóstico read-only precisa recortar as leituras, não executar a rotina de notificação. |
| **D7 SCORES-2X** | **CORTAR** | A premissa é explicitamente falsa. A [migration do reforço](../../../../../supabase/migrations/20260730120001_calculate_scores_reforco_0625.sql:23) aceita duas execuções e **mais 6.633 linhas por tabela/dia** (`:29–33`). O lease impede sobreposição; terminar saudável libera o próximo run. Inclusive **13.266 = 2 × 6.633**, exatamente o volume antigo documentado. Seus números não provam que a segunda passada começou em novembro; podem refletir crescimento da população. Não remover o reforço nem deduplicar a série. |
| **D8 ROLLBACK** | **AJUSTAR** | Manter atribuição, sem interpretar 17% como taxa de falhas do produto. **`pg_stat_statements` não basta:** estatísticas de execução são atualizadas para operações bem-sucedidas, portanto os statements que falham podem faltar. Cruzar deltas por janela, logs com SQLSTATE, aplicação/papel e configuração transacional. Rollback também pode ser solicitado deliberadamente pelo PostgREST. [PostgreSQL](https://www.postgresql.org/docs/17/pgstatstatements.html), [PostgREST](https://postgrest.org/en/stable/references/transactions.html). |
| **D9 ANALYZE/VACUUM** | **AJUSTAR** | Separar as tabelas. Em `venda_sugestao`, 223 mil estimados contra 2.993 reais é evidência forte para atualizar estatísticas e investigar manutenção. No Radar, tamanho e ausência de manutenção na janela não provam bloat nem estatísticas ruins. Verificar alterações, tuplas mortas, heap/índices/TOAST e impedimentos ao autovacuum. VACUUM comum recupera espaço para reutilização; não prometer redução dos GB em disco. [Documentação PostgreSQL](https://www.postgresql.org/docs/17/routine-vacuuming.html). |

Quanto aos cortes já feitos:

| Corte | Veredito |
|---|---|
| **NF-NULL** | **MANTER O CORTE**, limitado à evidência OBEN/180 dias. Zero nulos nessa população reduz prioridade; não prova impossibilidade nas demais empresas e caminhos. |
| **NF-CHAVES** | **MANTER O CORTE** para o cron medido. A baseline em `single-shot-truncado-gate.test.ts:106` registra dívida; não certifica segurança. Reabrir se a janela manual/backfill ultrapassar o limite relevante. |
| **`ordem-entre-edges` com `paths:`** | **MANTER O CORTE.** Contradição literal com a invariante do workflow em `:12`; ainda há eventos de edição do corpo sem alteração de arquivos. |
| **Três resíduos D4** | **MANTER O CORTE.** Com ruído medido, contagem de padrões no fonte não justifica intervenção. |
| **`useAdminOrderDetail`** | **MANTER O CORTE.** Além de orders vazio, `/orders` pertence ao módulo congelado (`manifesto.ts:17–25`). |
| **ESLint de `?? 0`** | **MANTER O CORTE.** O padrão textual não distingue soma vazia legítima, ausência indevida e contrato de exibição. Não reabrir uma máquina genérica já recusada. |
| **Verificações datadas no Fecho do v5** | **MANTER**, com critérios: HOT por **delta após aplicação**, não percentual acumulado; índices respeitando ciclos mensais; vitals separados por build adotado. Chegar a 09/11 não garante amostra suficiente. |

Acrescentaria **um item**, mais concreto que várias hipóteses F:

**TOTAL-EDITADO — MANTER.** Em `DetalhesModal.tsx:86`, `totalAtual || pedido.valor_total` substitui **zero editado pelo total antigo**. A quantidade aceita zero (`useDetalhesModal.ts:410–412`), o total é recalculado (`:150–152`) e o rodapé mostra esse total diretamente (`ItensTable.tsx:265`). Ao zerar todas as quantidades, cabeçalho e rodapé podem divergir. Corrigir a escolha pela disponibilidade/estado dos itens, preservando zero conhecido; não é resolvido pela mudança do formatador.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.GtLOufV559)
