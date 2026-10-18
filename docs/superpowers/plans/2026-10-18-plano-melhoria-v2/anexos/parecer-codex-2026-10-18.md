=== PARECER CODEX (modelo gpt-6-astra · reasoning max · tentativa 1 · 307s · 160.464 tokens) ===
**Não executaria o v2 como está: há riscos relevantes, mas várias premissas da varredura estão erradas.** Conferi o checkout e executei `casts:stale`; não consultei produção nem reproduzi os tempos do CI.

**1. Prioridade — MOVER.**

Minha ordem: **L1 com correção da NF-e → H → J corrigido → I1 nos caminhos ativos → I2 restrito → restante de L → K2**. K1 fica “quando tocar”; N vira piloto; I3 sai.

Dois ajustes fundamentais:

- Começar I1 por `useTarefas` contraria o congelamento: o manifesto marca tarefas como **congelado e fora do money-path**. Comece por pedidos programados e reposição. [manifesto.ts:103](src/lib/modulos/manifesto.ts:103)
- I2 não são “26 corpos divergentes”: contei **26 entradas, 18 funções, 21 registros PATCH, 4 EDICAO_MANUAL e 1 NAO_MENSURAVEL**. Há registros que apenas citam funções. Priorize as alterações sem representação reconstituível nas migrations, especialmente pedidos. [deriva-corpo-baseline.json:203](db/deriva-corpo-baseline.json:203)

**2. Custo com cinco usuários — CORTAR I3, K3 e M como mutirão.**

M contém falsos positivos suficientemente graves para invalidar o lote:

- Os **cinco `test-wt-*` já estão em `test:hooks`**. [package.json:89](package.json:89)
- `anthropic-cliente` importa a política de `anthropic`; a separação mantém testes sem SDK. `omie-chamada-relogio` também importa `omie-deadline`. São camadas, não duplicações. [anthropic-cliente.ts:3](supabase/functions/_shared/anthropic-cliente.ts:3), [omie-chamada-relogio.ts:24](supabase/functions/_shared/omie-chamada-relogio.ts:24)
- `sonda-fingerprints` tem consumidor transitivo em runtime. “Zero imports diretos por edge” não significa órfão. [sonda-versao.ts:14](supabase/functions/_shared/sonda-versao.ts:14)

Recupere somente correções concretas: **saldo bancário fixado em zero é informação falsa**, não higiene. Oculte o indicador ou mostre indisponibilidade; não implemente três telas por causa de TODO. E `NfeReceipt` já chama `process-nfe`: não é uma tela inteiramente descartável. [FinanceiroGestao.tsx:64](src/pages/FinanceiroGestao.tsx:64), [NfeReceipt.tsx:72](src/pages/NfeReceipt.tsx:72)

**3. Riscos ausentes — FALTA.**

- **Atomicidade e recuperação da NF-e.** O cabeçalho é inserido antes dos itens; falha nos itens devolve 500, mantendo o cabeçalho. A repetição encontra esse cabeçalho e responde “já importada”, sem reparar os itens. L1 precisa incluir correção e teste dessa sequência, não apenas ganhar um `_test.ts`. [omie-nfe-webhook/index.ts:194](supabase/functions/omie-nfe-webhook/index.ts:194), [mesmo arquivo:105](supabase/functions/omie-nfe-webhook/index.ts:105)
- **H pode introduzir autorização aberta.** Hoje o disparador testa um booleano. Após importar o helper, `{ok:false}` continua sendo objeto verdadeiro naquele teste. Exija testes negativos no **handler**, verificando também ausência de efeitos; testar só o helper não cobre a migração. As cópias tampouco são todas booleanas: `fin-cashflow-engine` já retorna `AuthResult`. [disparar-pedidos-aprovados/index.ts:1723](supabase/functions/disparar-pedidos-aprovados/index.ts:1723), [auth.ts:23](supabase/functions/_shared/auth.ts:23)
- **J3 tem dependente indireto.** `mutation-check` não bloqueia `validate`, mas o disparo pós-merge exige sucesso do **workflow inteiro**. Uma falha informativa pode impedir o CI pós-merge. Corrija essa dependência. [auto-merge.yml:65](.github/workflows/auto-merge.yml:65)
- **I1 tem critério de conclusão quebrado.** Medi **49/47**, não 49/33. O gate exige pelo menos **40 casts literais**, portanto rejeitaria zero; e ignora wrappers como `from(name as never)`, existente justamente em pedidos programados. Zero na baseline não prova tipagem restaurada. [casts-stale-gate.ts:42](scripts/casts-stale-gate.ts:42), [usePedidosProgramados.ts:73](src/hooks/usePedidosProgramados.ts:73)

**4. J2 — CORTAR a retirada indiscriminada do pré-merge.**

Ganhar aproximadamente três minutos não justifica remover uma barreira do auto-merge. O próprio CI registra o precedente de falsificação vermelha **depois** do merge. [ci.yml:899](.github/workflows/ci.yml:899)

Além disso:

- `push + schedule` exclui o `workflow_dispatch` usado pelo pós-auto-merge.
- `gates:rapidos` não substitui falsificação: verifica gates, não se suas provas detectam sabotagem.
- J1 precisa ser refeito: no workflow encontrei **uma execução direta** de `test`, `lint:shell` e `test:falsificacao`, nas linhas 256, 591 e 919. O segundo `authz:carimbo` tem outro contrato: exige frescor na main. [ci.yml:1500](.github/workflows/ci.yml:1500)

**Alternativa:** medir custo por suíte, reduzir fixtures caras e dividir a falsificação em partes obrigatórias, preservando a exigência de sucesso de todas. Meça tempo até `validate` **no PR**, fila e minutos de runner; cinco runs na main não demonstram melhoria no auto-merge.

**5. N — MANTER como piloto de produtividade.**

É melhoria operacional relevante para dezenas de agentes, embora não seja correção de produto. Faça **um domínio**, medindo contexto efetivamente carregado e erros de execução; não imponha 30 KB como verdade universal.

“Mover, nunca apagar” não basta: uma regra arquivada e nunca carregada deixa de proteger. Preserve no documento vivo **condição, obrigação, exceções e ponteiro para a evidência**.

Há também dependência executável: `gates:frescura` lê especificamente `docs/agent/deploy.md` e seu censo. Fatiar pode quebrar contratos, referências e instruções de carregamento. [gates-frescura-check.ts:645](scripts/gates-frescura-check.ts:645)

**6. I3 — CORTAR como iniciativa; se houver incidente, redesenhar.**

M-56 está explicitamente cortado no plano anterior, não “aberto”. [plano anterior:52](docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md:52)

O problema não é qualquer ratchet: é **um contador global editado por várias sessões** e a obrigação de pagar dívida alheia. O gate atual já compara identidades de arestas e exige remover entradas resolvidas. [fronteiras.ts:91](src/lib/modulos/fronteiras.ts:91)

Se retomado: comparar **arestas adicionadas pelo PR** contra a base do merge testado; permitir remoções independentes; distinguir renomeação de nova dependência; exigir justificativa para exceções. Sem contador central atualizado por todo PR, sem compensar aresta perigosa removendo outra irrelevante, sem redução obrigatória a cada toque.

**7. K — MANTER parcialmente; sim, há máquina meta nova.**

Acrescentar uma regra ao ESLint continua criando fiscalização nova. “Uma linha num gate existente” não elimina custo de exceções, manutenção e falsos positivos.

Critério honesto: **incidente identificado, recorrência ou dinheiro em risco, regra que detecta aquele defeito, dono do vermelho e custo limitado**. Isso já está documentado. [maquinas-meta.md:11](docs/agent/maquinas-meta.md:11)

- **K1:** quando tocar. Já existe `formatPrecoOuAusente`; não crie outro sinônimo sem definir precisão, ausência e usos legítimos. Barrar `style:'currency'` não corrige cálculo monetário. [format.ts:149](src/lib/format.ts:149)
- **K2:** manter correções concretas. O helper exige sessão e aceita somente corpo; não é substituição universal de qualquer `invoke`. [invoke-function.ts:31](src/lib/invoke-function.ts:31)
- **K3:** cortar. Nome de variável não determina estado persistível na URL; busca temporária e debounce são contraexemplos.

“Contagem cai em todo PR que toca o módulo” também excede **canônico quando tocar**.

**8. Top 5 — MANTER risco concreto como critério.**

Critério: **impacto em dinheiro/produção × evidência do defeito ÷ custo de corrigir, verificar e entregar**.

| Ordem | Trabalho | Risco / custo |
|---|---|---|
| 1 | NF-e: gravação completa e repetição após falha | Alto: recebimento incompleto / M |
| 2 | H: testes negativos nos handlers, depois centralização | Alto alcance de autorização / P–M |
| 3 | J: corrigir dependência do pós-merge; otimizar preservando falsificação | Afeta toda entrega / P–M |
| 4 | I1: pedidos programados e reposição, incluindo wrappers e casts de retorno | Tipagem no caminho ativo / M |
| 5 | I2: focar `reconciliar_pedidos_omie` e `pedido_total_liquido_converter` | Evitar apagar correções financeiras / M |

Em I2, **copiar corpos para `db/` sozinho não resolve**: o auditor monta sua expectativa das migrations de `origin/main`. É preciso fechar a representação reconstituível e provar o comportamento preservado. [audit-deriva-corpo-prod.ts:245](db/audit-deriva-corpo-prod.ts:245)

**Os três cortes:** I3 como lote; K3 como regra/migração; M como mutirão estrutural. Correções pontuais de informação falsa sobrevivem separadamente.

**RESUMO EM 10 LINHAS**

> 1. Revise a baseline antes de transformar números em trabalho.  
> 2. NF-e pode ficar sem itens e impedir a própria recuperação.  
> 3. H precisa provar rejeição nos handlers antes da troca de retorno.  
> 4. Preserve falsificação pré-merge e otimize seu custo.  
> 5. O pós-merge depende indevidamente do sucesso de jobs informativos.  
> 6. Casts medidos: 49/47; o piso atual impede chegar a zero.  
> 7. Priorize casts nos caminhos ativos, não no módulo congelado.  
> 8. As 26 entradas SQL não representam 26 funções divergentes.  
> 9. N merece um piloto; K merece regras estreitas com evidência.  
> 10. Corte I3, K3 e o mutirão M; preserve correções concretas.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.X7RMZ6Wp8b)
