=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 199s · 153.502 tokens) ===
**Cinco candidatos novos**, ordenados por ganho/custo. Revisão somente leitura do commit `ee71d4917`; não abri o snapshot de schema. Executei duas reproduções em memória sobre as funções atuais. Ganhos de latência abaixo são estimativas estruturais, sem medição em produção.

1. **BND · Eliminar o cálculo de triplas descartado no motor de bundles.**  
   **Evidência:** [useBundleEngine.ts:628](src/hooks/useBundleEngine.ts:628) percorre todas as cestas com três laços aninhados, ordena chaves e preenche `tripleFreq`. O identificador aparece somente na declaração e na própria atualização; nenhuma regra consome esse mapa. As regras seguintes usam `pairFreq`.  
   **Ganho estimado:** eliminar integralmente essa passagem, suas alocações e `C(k,3)` combinações por cesta com `k` produtos frequentes — por exemplo, 1.140 combinações descartadas quando `k=20`. Reduz CPU no navegador durante o recálculo; segundos dependem das cestas reais.  
   **Custo:** pequeno, remoção localizada e comparação dos resultados. **Risco:** baixo; nenhuma saída depende do mapa.  
   **Fora de v2–v4:** C4′ tratou compartilhamento e transporte do histórico. Este é trabalho computacional sem consumidor; não extrai engines nem altera score, janela ou regras comerciais.

2. **UTI · Corrigir a identidade dos recebíveis e impedir falsa adimplência.**  
   **Evidência:** [useUtiContas.ts:133](src/hooks/useUtiContas.ts:133) descarta títulos sem `cnpj_cpf`; nas linhas 164–165, ausência de correspondência vira saldo zero e sinal `false`. O [histórico do intercompany:5](docs/historico/fin-ic-reconcile-contraparte-por-codigo.md:5) documenta **45.386 CR com esse campo vazio em 21/10**; não é contagem atual. O escritor continua lendo esse campo da resposta Omie.  
   **Reprodução:** mantendo cliente, churn e dívida de R$ 750, trocar apenas o documento do título por `''` muda `uti/true/750` para `observacao/false/0`.  
   **Ganho estimado:** recuperar um dos três sinais da triagem e evitar exposição subestimada. Associar por `(company, omie_codigo_cliente)` com identidade comprovada; associação indisponível deve permanecer desconhecida.  
   **Custo:** médio, com validação money-path e cobertura das três empresas. **Risco:** médio, principalmente aliases fiscais e duplicação da exposição.  
   **Fora de v2–v4:** B5 citou essa tela como leitora de `fin_sync_log`, mas tratou o índice de frescor. O casamento incorreto dos títulos não entrou nos candidatos.

3. **CI-GIT · Usar checkout raso somente no job `typecheck`.**  
   **Evidência:** [.github/workflows/ci.yml:189](.github/workflows/ci.yml:189) configura `fetch-depth: 0`. Esse job apenas instala dependências e executa os dois `tsc` — linhas 210, 214 e 235. A justificativa do histórico completo menciona `sonda:bump`, executado em outro job, com checkout próprio. O comentário registra aproximadamente 118 MB para o clone completo.  
   **Ganho estimado:** uma transferência de histórico Git completo a menos por execução do CI. Os 118 MB são referência histórica do clone, não economia integral comprovada; redução de duração precisa ser medida.  
   **Custo:** muito pequeno. **Risco:** baixo no escopo desse job; não estender automaticamente aos testes ou gates que consultam Git.  
   **Fora de v2–v4:** J tratou dependências/fatiamento; A1–A3, custos das provas e execução local. Não altera checks nem reabre a retirada do `heavy`.

4. **HST · Tornar o último preço conhecido independente da ordem dos itens.**  
   **Evidência:** [historico.ts:67](src/lib/venda-cliente/historico.ts:67) só reconsidera o preço quando a data supera `ultimaData`, que também avança para compras sem preço. A consulta em [useHistoricoCompras.ts:44](src/hooks/useHistoricoCompras.ts:44) não estabelece ordem dos itens.  
   **Reprodução:** compra antiga a R$ 45 seguida de compra recente sem preço retorna R$ 45; os mesmos registros na ordem inversa retornam `null`. A ficha de recompra consome esse resultado.  
   **Ganho estimado:** referência comercial consistente, sem perder preço conhecido por ordem arbitrária da resposta. Manter separadamente a data da última compra e a data do último preço conhecido resolve em uma passagem.  
   **Custo:** pequeno, com teste de permutações. **Risco:** baixo a médio; definir desempate de preços na mesma data.  
   **Fora de v2–v4:** não é formatação monetária K1 nem a listagem de pedidos C3; é um defeito específico da redução do histórico.

5. **VAL-IO · Sobrepor quatro leituras independentes da edge de valor.**  
   **Evidência:** [fin-valor-cockpit/index.ts:575](supabase/functions/fin-valor-cockpit/index.ts:575) aguarda, em sequência, mapa de clientes, perfis, custos e estoque — linhas 575, 579, 591 e 614. Os filtros dessas quatro varreduras não dependem dos resultados umas das outras.  
   **Ganho estimado:** com concorrência limitada a dois, quatro varreduras de duração semelhante passam de quatro para duas ondas de espera nessa etapa. O volume de consultas permanece igual; o benefício é latência e tempo de execução da edge.  
   **Custo:** pequeno a médio, preservando paginação, falhas e cálculos. **Risco:** médio: maior pressão simultânea no banco; limitar concorrência e comparar resultados/tempo.  
   **Fora de v2–v4:** C2 paralelizou zonas da home; C6 tratou agregação/cache do cockpit financeiro. Aqui é a edge distinta `fin-valor-cockpit`, sem extração de monólito.

Não vale reabrir o catálogo do wizard: já possui cache de 10 minutos e ordenação separada da busca.  
Não vale um mutirão de `?? 0`: encontrei casos protegidos por `.gt('saldo', 0)` e degradação explícita; grep sozinho acusaria falsos problemas.  
Não vale recomendar índices ou expurgos adicionais nesta revisão: sem plano de execução e contadores atuais, faltou evidência de ganho.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.q01N9AX1K6)
