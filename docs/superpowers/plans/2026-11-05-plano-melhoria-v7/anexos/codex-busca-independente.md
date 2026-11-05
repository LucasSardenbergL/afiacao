=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 1836s · 196.385 tokens) ===
Encontrei **6 candidatos**, conferidos contra o histórico, os cortes v5/v6 e `git grep` dos símbolos em `origin/main`. O checkout corresponde a `80c74384b`. Todos atingem módulos ativos; nenhum depende da retomada de `/rota`, `/orders` ou telefonia.

As reproduções abaixo executaram trechos extraídos do código com Node, em memória e com dependências simuladas. Não comprovam incidência em produção. Não alterei arquivos nem abri o schema snapshot.

**1. OPP-ERRO — falha vira economia de R$ 0 · C**

**Evidência:** [AdminReposicaoOportunidades.tsx:106](src/pages/AdminReposicaoOportunidades.tsx:106) lança o erro da consulta, mas o consumidor descarta `error` e aplica `oportunidades = []`. O redutor em `:218` calcula zero; [OportunidadesTable.tsx:34](src/components/reposicao/oportunidades/OportunidadesTable.tsx:34) apresenta o estado vazio.

**Reprodução:** callback real + `QueryClient`, sem cache: resposta com erro simulado → `status: error`, **0 linhas, economia 0**. Controle com leitura bem-sucedida de `[]` → `status: success`, **os mesmos números**.

**Proposta e ganho:** transportar o estado de leitura até os KPIs e a tabela; falha apresenta indisponibilidade, vazio confirmado apresenta zero. Ganho de correção demonstrado; valor financeiro evitado não quantificado.

**Custo:** P. **Risco:** baixo; cuidar também da falha de atualização com dados anteriores.

**Novidade:** a correção existente nessa página e seu teste cobrem o **banner de negociação**, cuja query já lança e exibe aviso. A consulta principal `oportunidades-hoje` continua desprotegida. Não repete REC-ZERO/SKU-DEMANDA do v6.

**2. CAD-CADEIA — contador pode inventar pendências ou esconder falha · C/D**

**Evidência:** [AdminReposicaoCadastros.tsx:55](src/pages/AdminReposicaoCadastros.tsx:55) lê `sku_grupo_producao` e `sku_parametros` sem paginação nem ordenação; calcula a diferença entre os conjuntos recebidos. Em `:59/:68`, erro retorna zero. Em `:102`, esse resultado aparece como “SKUs sem cadeia logística”.

**Reprodução:** executei o callback extraído com **1.500 SKUs, todos vinculados**, simulando a capa de 1.000 e ordens diferentes nas duas respostas: resultado **500 sem cadeia**. Controles: respostas completas dos mesmos 1.500 → **0**; universo de 500 → **0**. Erro de leitura também retorna **0**.

**Proposta e ganho:** calcular o `COUNT` com `NOT EXISTS` no banco, respeitando empresa e autorização; devolver uma contagem agregada e propagar falhas. Elimina a comparação de duas listas incompletas e reduz duas requisições a uma. Ganho temporal: **estimativa de um RTT**, ainda sem medição.

**Custo:** M. **Risco:** médio pela equivalência de filtros e RLS.

**Novidade:** a falta de paginação já consta como dívida em `single-shot-truncado-gate.test.ts:81`; **não a apresento como descoberta inédita**. O acréscimo é a demonstração de **falsos positivos na diferença de conjuntos**, além do falso zero em erro. Não há entrega ou corte correspondente nos planos consultados.

**3. MAP-EMPATE — sugestão DRE contraditória recebe “alta confiança” · D/C**

**Evidência:** [fin-suggest-mapping/index.ts:118](supabase/functions/fin-suggest-mapping/index.ts:118) aceita mapeamentos de outras empresas e escolhe `matchesByCode[0]`, sem detectar divergência. A leitura em `:100` não ordena. [FinanceiroMapping.tsx:107](src/pages/FinanceiroMapping.tsx:107) permite aplicar em lote as sugestões de alta confiança.

**Reprodução:** executei o bloco real com o mesmo código classificado como `cmv` na Oben e `despesas_financeiras` na Colacor, para sugerir à Colacor SC:

- Ordem Oben→Colacor: **`cmv`, confiança alta**.
- Ordem inversa: **`despesas_financeiras`, confiança alta**.
- Controle com classificações concordantes: mantém **`cmv`**.

**Proposta e ganho:** divergência entre fontes elegíveis deve exigir decisão explícita, ficando fora da aplicação em lote. A comparação precisa considerar o conjunto completo e preservar os filtros tributários existentes. Evita classificação financeira determinada pela ordem de leitura; impacto em R$ desconhecido.

**Custo:** P–M. **Risco:** médio, por alterar a elegibilidade das sugestões.

**Novidade:** o backtest registrado em `jev-backtest-ptbr.md:113` excluiu essa etapa e avaliou as regex; a dívida de paginação também não cobre o empate. **Defeito latente reproduzido; existência atual de mapeamentos conflitantes em produção é HIPÓTESE.**

**4. C360-PARALELO — margem prolonga a espera pelo score · F**

**Evidência:** [customer360/hooks.ts:81](src/components/customer360/hooks.ts:81) aguarda o score próprio, eventualmente o fallback, e só em `:99` busca a margem. `buscarMargemScore` precisa apenas do `customerId`, já disponível.

**Reprodução:** callback extraído com transporte instrumentado:

- Score próprio existente: `own inicia → own termina → margem inicia`.
- Controle sem score próprio: `own → fallback → margem`, também em série.
- Contraprova com as leituras independentes em `Promise.all`: ambas começam antes de qualquer término, com os mesmos valores.

**Proposta e ganho:** iniciar a margem junto da leitura do score, preservando o fallback e o tratamento de margem restrita/indisponível. **Estimativa:** retirar aproximadamente um RTT da resolução do card; hipótese de **100–400 ms**, dependente da rede.

**Custo:** P. **Risco:** baixo a médio; pode acrescentar uma consulta quando não houver score.

**Novidade:** as entregas do Customer 360 trataram universo de pedidos e acesso ao custo. Esta cadeia continua serial; não é VAL-IO nem DRE-IO.

**5. HOME-DND — carregar o arrastar apenas ao personalizar · F**

**Evidência:** [CockpitGrid.tsx:2](src/components/dashboard/CockpitGrid.tsx:2) importa `@hello-pangea/dnd` estaticamente. Em `:72`, monta `DragDropContext` mesmo fora da edição; apenas desabilita o arraste.

**Reprodução:** executei a função extraída com dependências simuladas: `isEditMode=false` **e** `true` montam o contexto. Bundle isolado, produzido inteiramente em memória com React externo: **99.348 bytes, 31.685 gzip**. Controle sem DND: **31 bytes, 51 gzip**. Isso mede a biblioteca isolada, não a redução exata do bundle do app.

**Proposta e ganho:** grade normal leve; carregar a implementação de edição por import dinâmico ao personalizar. **HIPÓTESE de ganho:** retirar parte relevante desses ~31 KB gzip do caminho inicial do staff. A transferência isolada equivale a aproximadamente **250 ms a 1 Mbps**, estimativa que não garante redução igual no LCP.

**Custo:** M. **Risco:** médio; preservar estado das zonas, teclado, ordem personalizada e comportamento ao entrar/sair da edição.

**Novidade:** o v5 antecipou o download do dashboard e separou dependências Radix; não adiou o DND. O F11 descartou adiar polls. Este candidato atua no JavaScript necessário para renderizar a home.

**6. CI-RADAR-ESPERA — reduzir tempo fixo nas provas concorrentes · E**

**Evidência:** [test-radar-cadastro-conflitos.sh:239](db/test-radar-cadastro-conflitos.sh:239) mantém a sessão A aberta por dois segundos em seis cenários; `:469` acrescenta outra espera de dois segundos. O modo `--falsificar` executa controle e 15 mutantes. A tabela vigente registra **360 s** para essa prova em [nucleo-ci-custo.txt:101](db/nucleo-ci-custo.txt:101).

**Reprodução:** extração e contagem em Node confirmaram **14 s fixos por passagem completa**, com até 17 invocações entre normal, controle e mutantes. Não executei PostgreSQL. Simulação da partição vigente: controle **992 s** na maior parte; supondo redução de 120/180 s nessa prova e atualização dos custos, **972/962 s**.

**Proposta e ganho:** liberar A assim que o bloqueio esperado de B for observado, com prazo máximo e falha explícita, mantendo as sabotagens e seus motivos. **DIAGNÓSTICO/experimento:** estimativa de **2–3 runner-min**, traduzida pelo modelo em **20–30 s no caminho crítico** com provas SQL. Falta medir no runner.

**Custo:** M. **Risco:** médio; uma barreira mal implementada pode enfraquecer a prova de concorrência.

**Novidade:** E9 redistribuiu custos; este candidato reduz trabalho dentro de uma prova. Não retoma shards Vitest, escopo de falsificação ou V8-LOTE. O histórico registra otimização semelhante em outra prova, não nesta.

**Ordem recomendada:** OPP-ERRO → CAD-CADEIA → C360-PARALELO → experimento HOME-DND → experimento CI-RADAR-ESPERA. MAP-EMPATE entra como diagnóstico de exposição; sobe de prioridade se houver categorias conflitantes elegíveis para aplicação em lote.

