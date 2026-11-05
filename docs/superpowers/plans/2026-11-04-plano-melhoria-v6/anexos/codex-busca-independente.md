=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 430s · 190.968 tokens) ===
Recomendo **5 candidatos**, nesta ordem de ganho/custo. A análise é do commit `81cbd3e31`, sem produção, sem alterações e sem abrir o schema-snapshot. Reproduções e medições abaixo ocorreram em memória; **ganhos de implantação são ESTIMATIVAS**.

1. **NF-NULL — C: preservar valor desconhecido na consolidação de itens**

   **Evidência:** `supabase/functions/omie-sync-vendas-items/index.ts:487` preserva `vProd` ausente como `null`, mas a consolidação do mesmo SKU, em `:529–531`, transforma esse nulo em zero e recalcula o preço unitário. Executei o trecho extraído do arquivo:
   - Duas unidades, valores `[100, null]` → total **100**, unitário **50**.
   - Valores `[null, null]` → total e unitário **0**.
   - Controle `[100, 100]` → total **200**, unitário **100**.

   **Proposta e ganho estimado:** total agregado desconhecido continua `null`; preço derivado não nasce de soma parcial. Evita gravar receita e preço falsos em `venda_items_history`. Incidência e impacto em reais desconhecidos. **Custo P; risco médio**, pelos consumidores desses campos.

   **Novidade:** v2/v3 trataram recebimento de NF, não este importador de vendas. `docs/historico/f3-fontes-faturamento-bu.md:33` registra consolidação e perda de CFOP, mas afirma que os valores ficam corretos. A reprodução com valores ausentes é o fato novo; não propõe reabrir o recorte por BU ou CFOP.

2. **A4-DADO — C: propagar ausência e confiança da projeção de caixa**

   **Evidência:** `supabase/functions/fin-next-best-action/index.ts:152–157` aplica `?? 0` à cobertura/saldo e considera confiança baixa somente quando a resposta inteira é nula. Porém, a A1 retorna cobertura legitimamente nula e motivo de saldo datado em `fin-cashflow-engine/index.ts:1201` e `:1517`.

   Reprodução do trecho real: cobertura `null` e saldo 10.000 → disponível **0, confiança alta**. Cobertura 42 dias, saldo 10.000 e aviso de extrato antigo → disponível **5.000, confiança alta**, sem registrar falha.

   **Proposta e ganho estimado:** representar disponível desconhecido por `null` e transportar a degradação da A1 até a tela. Evita “R$ 0” e confiança alta sem suporte. **Custo M; risco médio**, pois exige ajustar contrato, helper espelhado e apresentação.

   **Novidade:** v3 corrigiu a fonte A1 e leitores de saldo; v5/E5 corrigiu Gestão e formatadores. O consumidor A4 ainda descarta essa informação. A busca no histórico encontrou sua autorização, mas não esta propagação.

3. **DRE-IO — F: carregar as três empresas em paralelo**

   **Evidência:** `src/hooks/useFinanceiro.ts:243–245` executa três `await getDRE(...)` sequenciais. As consultas são independentes: `src/services/financeiroService.ts:472–486` filtra empresa, ano e regime. É caminho ativo da aba DRE.

   **Proposta e ganho estimado:** `Promise.all` com resultado na ordem fixa das empresas, preservando falha integral e o controle de geração existente. A espera passa de aproximadamente `t₁+t₂+t₃` para `max(t₁,t₂,t₃)`. **ESTIMATIVA:** até cerca de ⅔ da espera dessas consultas quando tiverem duração semelhante; não é redução medida da página inteira. **Custo P; risco baixo**, com atenção à concorrência no banco.

   **Novidade:** v4/C2 paralelizou zonas da home; v5/VAL-IO, mapas da A3. O histórico `hot-contas-pagar-lote11.md:34` paralelizou `getLastSyncTime`, não `loadDRE`. Não encontrei decisão anterior para este laço.

4. **NF-CHAVES — D: completar a leitura usada para evitar reprocessamento**

   **Evidência:** `supabase/functions/omie-sync-vendas-items/index.ts:316–329` lê chaves de `venda_items_history` sem paginação ou ordenação; erro apenas é logado. Esse conjunto decide quais notas pular em `:456`, antes dos upserts de `:537`.

   Reprodução com a capa documentada de 1.000 linhas: **2.000 itens de 1.000 notas**, dois itens por nota, deixam somente **500 notas** conhecidas pelo conjunto. As demais podem ser reprocessadas apesar de já persistidas.

   **Proposta e ganho estimado:** paginação completa com ordem estável e falha explícita da leitura. No cenário reproduzido, evita até **500 upserts redundantes por passagem**, trocando-os por poucas páginas adicionais de leitura. Volume real desconhecido; também reduz trabalho dentro do limite de 25 segundos da edge. **Custo P; risco baixo–médio**.

   **Novidade:** v4/N2 tratou falha de gravação do catálogo em `omie-vendas-sync`, outra edge. O histórico desta fonte trata cobertura por BU e semântica fiscal. É correção localizada do conjunto de deduplicação, não retomada do mutirão M-50.

5. **V8-LOTE — E: amortizar subprocessos do gate de sintaxe existente**

   **Evidência:** `scripts/edges-sintaxe-gate.ts:221–223` inicia um Node por módulo; `:291` limita a quatro simultâneos. O CI chama esse gate em `.github/workflows/ci.yml:351–352`.

   Comparei, sem executar os módulos, os **348 fontes transpilados**: `node --check` por stdin, com quatro processos simultâneos, levou **28.872 ms**; parse com `vm.SourceTextModule` no mesmo processo levou **146 ms**, com os mesmos vereditos. A transpిలação, comum aos dois, custou **15.979 ms**. Controles separados rejeitaram redeclaração e aceitaram import remoto/top-level await.

   **Proposta e ganho estimado:** manter o gate, mas usar processo V8 persistente com isolamento e teto. **ESTIMATIVA:** economizar segundos a dezenas de segundos por execução; efeito no tempo total do PR ainda desconhecido. **Custo M; risco médio**: ensaio em Node 26, API experimental, equivalência ainda precisa ser provada no runner e no corpus histórico.

   **Novidade:** não é `test:rapido`, retirada de provas ou novo gate. O histórico documenta a criação desta proteção pelo **incidente #2720**, não a amortização dos processos. Preservar obrigatoriamente parser TS, calibração, recusa por falha de infraestrutura e os quatro casos históricos.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.zmczTXO0Fy)
