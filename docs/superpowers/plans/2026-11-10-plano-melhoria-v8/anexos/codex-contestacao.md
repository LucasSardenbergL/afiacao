# Contestação do Codex — plano v8 (2026-11-11)

> Parecer cru, sem edição além de: caminhos absolutos trocados por relativos ao repo e a linha da cópia temporária removida. O que foi adotado está no §6 do [README](../README.md).

=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 225s · 128.920 tokens) ===
**O plano tem boas prioridades, mas superestima a certeza de T1 e parte de um diagnóstico incompleto em R2.** Li o README inteiro e as regras; não consultei o banco nem o snapshot.

1. **T1**

   **CONCORDO — preservar os 15 s.** A fila barata e a concentração do tempo nas promoções sustentam essa decisão; porém, tempo não atribui blocos, e 4.366 MB é o delta do **banco inteiro**, não exclusivamente da promoção ([histórico:560](../../../../docs/historico/tint-purge-staging-io.md:560)). Troque “não tira nenhum bloco” por “não reduz o trabalho obrigatório das promoções”.

   **AJUSTAR — convergência.** ≤31,8% é um limite superior válido, não cobertura medida; chegar a 90% exige **pelo menos 15 runs**, assumindo 20 mil assinaturas novas por run, população estável e cobertura dos pares restantes. O código reserva capacidade para reescritas e só assina fórmulas tocadas, portanto **18/11 é cenário otimista, não prazo garantido** ([migration:288](../../../../supabase/migrations/20261104110100_tint_receita_assinada_no_cabecalho.sql:288)); a soma histórica tampouco comprova atingir 90%.

   **AJUSTAR — corte do teto.** Adiar aumento é defensável pelo pico de escrita/WAL/duração; sujar o visibility map não basta para descartá-lo enquanto M2 nem existe. Faltou avaliar lookup dos cabeçalhos em lote, por par, evitando buscas repetidas, com os mesmos predicados, assinatura inválida→comparação completa e prova diferencial de preço; é candidato a bancada, não ganho garantido.

2. **T2 — AJUSTAR.** “Fora da janela” e fila vazia não impedem ingestão concorrente: a edge insere cabeçalhos e itens em requests separados ([edge:624](../../../../supabase/functions/tint-sync-agent/index.ts:624)). O `ACCESS EXCLUSIVE` bloqueia edge e promote, podendo provocar timeout e atrasar catálogos; não prometa “segundos”: coordene pausa breve da ingestão/consumidores, drenagem, `lock_timeout` curto e espaço disponível. Avalie primeiro `VACUUM` comum, que pode devolver páginas vazias do final; `FULL` é justificável se insuficiente, enquanto `pg_repack` depende de disponibilidade e acrescenta complexidade ([PostgreSQL](https://www.postgresql.org/docs/17/sql-vacuum.html)). Na pós-condição, tamanho deve **diminuir**; integridade exige contagem/conteúdo, não igualdade de `n_live_tup`, que é estimativa.

3. **R2**

   **AJUSTAR — ~29 GiB/dia.** A conta sustenta uma extrapolação de leituras fora do `shared_buffers`, corroborada aproximadamente pelas seis rodadas noturnas, **não tráfego físico de disco** ([PostgreSQL](https://www.postgresql.org/docs/17/monitoring-stats.html)). A primeira leitura dois segundos após o início e a publicação defasada das estatísticas impedem tratar a janela como medição exata por execução; repita com baseline anterior e leitura posterior estabilizada, controlando concorrência.

   **DISCORDO — “regex sem índice”.** O índice proposto **já está na própria migration**, inclusive com pós-condição de validade ([SQL:202](../../../../supabase/migrations/20261111150000_radar_privacidade_titular_mei.sql:202), `:670`): conferir produção e planos precede criar outro. Predicado literal idêntico permite reconhecer a implicação, mas não garante escolha do índice; `LIMIT p_lote` não altera isso ([PostgreSQL](https://www.postgresql.org/docs/17/indexes-partial.html)). Há avaliação do predicado na carga mensal, porém índice vazio quase não recebe entradas, e `razao_social` já participa de GIN, portanto não atribua ao parcial uma perda inédita de HOT ([GIN:18](../../../../supabase/migrations/20261103100100_radar_busca_trgm.sql:18)). Separar backfill só é melhor após localizar o custo: anti-join e exclusões permanecem; preserve verificação pós-carga.

4. **§5 — AJUSTAR.** As opções existem, mas favorecem otimização com promessas excessivas: “converge até 18/11”, “expurgo sai quase inteiro” e “~4×” ainda são hipóteses. Corrija **46,7 MB/15 min**, não /10 min ([histórico:37](../../../../docs/historico/tint-purge-staging-io.md:37)); 871 MB são **bytes lidos do heap**, não seu tamanho (`:555`), e 2×4.366 MB ≈ **8,1 GiB**, não 8,7 GiB. Banco/cache não mede conjunto de trabalho; comparação histórica não isola RAM, 51 GB temporários acumulados não descrevem hoje, e ausência de impacto medido não prova impacto zero.

5. **Demais itens e cortes**

   - **C16 — AJUSTAR:** prioridade correta; recorrência não prova defeito no leitor. A evidência gravada deve distinguir campo ausente na fonte de falha de extração; preserve a recusa ([edge:717](../../../../supabase/functions/sayerlack-importar-pedido-portal/index.ts:717)).
   - **C13 — CONCORDO:** corrigir significado e erros dos quatro deltas, não apenas coluna.
   - **C14 — CONCORDO:** correção precisa atravessar query e apresentação; trocar zero por badge invisível continua escondendo indisponibilidade.
   - **C15 — CONCORDO:** remover/não medido; projeção de gasto não estabelece LTV.
   - **D13 — AJUSTAR:** sem login não significa fora da carteira; 7.070/500 exige 15 rodadas sem novas entradas, e processado pode significar erro ([edge:507](../../../../supabase/functions/visit-score-recalc-client/index.ts:507)).
   - **E18 — AJUSTAR:** reexecutar tudo é defesa deliberada contra manifesto adulterado; diff simples enfraquece essa garantia ([script:432](../../../../scripts/sonda-cron-prova.ts:432)). Prefira experimentar paralelismo limitado.
   - **E19 — CONCORDO:** retry limitado, baixando arquivo antes de extrair; não repetir saída parcial diretamente para `tar`.
   - **Cortes — CONCORDO:** tick, B3, SCORES-2,5X, EMBALAGEM, CICLOS, MAIN-ESCOPO e trabalho já coberto pelo programa de CI.
   - **Cortes — AJUSTAR:** teto conforme T1; OMIE-PRODUCTS pode custar CPU/WAL mesmo em cache; RADAR-PUBLICAR merece diagnóstico dos timeouts, sem esperar outro mês para investigar.

**MUDANÇAS QUE EU FARIA NO TEXTO**

- Corrigir unidades, janela de 15 minutos e leitura versus tamanho.
- Substituir prazo da M1 por cenário condicionado e cobertura real.
- Reabrir diagnóstico R2 pelo índice existente.
- Explicitar coordenação operacional do T2.
- Retirar garantias de ganho e preservar a defesa do E18.

