=== PARECER CODEX (modelo gpt-6-astra · reasoning high · tentativa 1 · 253s · 151.218 tokens) ===
Conferi `HEAD = origin/main = ee71d4917`, sem abrir o snapshot nem alterar arquivos. Os números de produção/Actions são os fornecidos; não os remedi.

**Correção do contexto:** B2/B9 entregaram remoção de índices + `fillfactor=80`, preservando os carimbos. O [histórico](../../../../../docs/historico/hot-carimbo-sync-lote14.md) rejeita explicitamente diff-before-write nesse caso.

| ID | Veredito | Evidência conferida e contestação |
|---|---|---|
| F1 | **AJUSTAR** | `ProtectedRoute:18` e `App:234` confirmam a espera. As três consultas **já são paralelas** (`AuthContext:115`). Compartilhar loaders com as rotas, sem duplicar 156 caminhos; preservar autorização. Os 300–800 ms continuam hipótese. |
| F5 | **AJUSTAR** | `AppShell:364` só navega no clique. Reutilizar F1, incluindo foco de teclado e intenção de ponteiro. **Risco oculto:** import especulativo pode acionar o reload global de `main:65` quando faltar chunk; tratar antes de ampliar prefetch. |
| F2 | **AJUSTAR** | `sw:269` **já é cache-first** para release promovida; `sw:208` exige assets completos antes da promoção. Cortar “sem promoção”: perde essa garantia e não resolve primeira visita sem SW. Diagnosticar com navegação/rede existentes antes de adicionar coluna ou sensor; n=18 não separa causalidade. |
| F3 | **AJUSTAR** | `vite.config:380` agrupa Radix; `:324` restringe o agrupamento compartilhado a `src/`, mas o fechamento do grafo percorre dependências. −35–45 KB e “shell usa quatro” não estão demonstrados. Exigir comparação do build e ciclos antes de aceitar o ganho. |
| F4 | **AJUSTAR** | `AppShell:437` já pausa aba oculta e exclui customer/sales-only. Há duplicação exata entre `:447` e `useAlertasCriticos:20`: começar aí. RPC posterior deve preservar RLS, escopo, falhas por contador e invalidações; passar pedidos de 30→60 s reduz frescor. Oportunidades já usa MV cacheada. |
| BND | **MANTER** | `useBundleEngine:628–639` preenche `tripleFreq`; nenhuma etapa consome o resultado. Remover o laço cúbico é localizado; não atribuir ganho ao boot, pois ocorre no cálculo. |
| VAL-IO | **MANTER** | `fin-valor-cockpit:575/579/591/614`: quatro leituras independentes confirmadas. Paralelizar mantendo paginação e falha integral; não prometer snapshot transacional nem esconder erro com lista vazia. |
| UTI | **AJUSTAR** | `useUtiContas:134/164/230` confirma descarte e zero falso; sem documento, o sinal já é `null`, não `false`. Casar empresa/conta+código com identidade fresca e unívoca. Mapa incompleto/ambíguo → desconhecido; ausência de vínculo não prova ausência de dívida. |
| HST | **AJUSTAR** | Reproduzi a [função real](../../../../../src/lib/venda-cliente/historico.ts:67): mesmos itens retornam **10, 20 ou null**, conforme ordem. Separar data da última compra da data do último preço conhecido; definir empate. Acrescentar apenas `order` na consulta não corrige a derivação. |
| E5 | **AJUSTAR** | `FinanceiroGestao:69–81` engole erro/ausência. Ampliar aos cards: `:91/:98/:105` também fabricam zero em carga/falha. Preservar desconhecido até a renderização e distinguir erro, carregamento e zero observado. |
| E6 | **CORTAR** | Premissa falsa: `useValor:6` e `useFunding:11` invocam engines por **useQuery**. As mutations salvam uma configuração por empresa; as edges consultadas calculam respostas sem persistir recompute. A regra de ação global não sustenta este candidato. |
| E7 | **AJUSTAR** | Os dois exemplos estão errados: `cashflow-format:14` e `grupos/format:14` produzem **R$ 0,00 para null** — conferido em execução. Já existe `formatPrecoOuAusente` em `lib/format:149`. Corrigir consumidores demonstrados; cortar migração indiscriminada e ESLint novo sem incidente elegível. |
| D1 | **AJUSTAR** | Índices confirmados em `20260615095710…:34/38`; leitor em `financeiroService:1104`. Remover índice não garante HOT: o próprio B2/B9 precisou de espaço na página. Medir scans, buffers e HOT com carga representativa; separar CP de CR e reestimar CR após B3. |
| D2 | **CORTAR** | `calculate-scores:1001/1016/1112/1116` grava componentes além do total. Comparar só score perderia mudanças explicativas. Com retenção de 60 dias, cliente estável poderia perder **todo** o histórico. Sem taxa de repetição e consumidores SQL verificados, não justifica mudar o contrato da série. |
| D3 | **AJUSTAR** | Fatiar: classificação reescreve tudo (`20261001014100…:365`). Porém carteira **tem** frescor por `last_synced_at` (`20261031191715…:205`), e [mapa fresco](../../../../../db/omie_customer_account_map_fresco.sql:23) expira após sete dias. Começar classificação; adiar demais até preservar frescor, fencing e contratos de contagem. |
| D4 | **AJUSTAR** | Só investigação focal. `20261102204836…:14–18` já envolve `has_role`, preservando `auth.uid()` externo. O histórico registra zero `has_role` cru no `public`: os 26 residuais precisam de nomes/expressões para reconciliar a divergência. Nenhuma reescrita em massa sem EXPLAIN por persona. |
| D5 | **MANTER** | Manter **releitura**, não DROP. `20260613210000…:25/30/35` documenta índices para consultas concretas do Radar. Sete dias sem scans não cobrem uso mensal nem provam inutilidade; exigir lista nominal, constraints e planos dos consumidores. |
| E1 | **AJUSTAR** | Dependência fora de db comprovada: `db/test-projecao-13s-saldo-fresco.sh:290` lê `src/`; outras provas leem scripts e skills. Escopo conservador no workflow existente; incerteza roda tudo. Adaptar também união/recibos (`ci:1365`) e validate (`:1425`), que hoje exigem execução completa. |
| E2 | **CORTAR** | Como mudança isolada, zero falhas em 300 runs não prova redundância da validação da **combinação**. `auto-merge:118` confirma dispatch; não basta acrescentar input, pois união/validate recusam skips. Reavaliar após E1 e validação anterior ao merge; não somar economias sobrepostas. |
| E3 | **AJUSTAR** | `ci:79` reconhece a solução, mas não há `merge_group` ativo. Avaliar fila nativa reutilizando `validate`, regras do repositório e adaptação do auto-merge. `mutcheck-escopo:227` roda tudo fora de PR. CI vermelho não autoriza criar outro gate próprio pela regra meta. |
| CI-GIT | **MANTER** | `ci:175–235` só instala dependências e executa os dois typechecks; não usa histórico. O comentário sobre `sonda:bump` ficou deslocado. Checkout raso apenas nesse job; ganho pequeno, sem mexer nos outros. |
| E8 | **CORTAR** | Os 11 `@ts-expect-error` existem. Em analytics há **oito diretivas** `@ts-ignore`, ligadas a EdgeRuntime, não cinco. Não demonstram lentidão nem defeito funcional; saneamento oportunista quando esses trechos forem alterados. |

Ordem sugerida:

1. **Lote imediato:** UTI, HST e E5 em PRs separados; BND e CI-GIT podem avançar em paralelo. E7 restrito aos consumidores comprovados.
2. **Lote de desempenho localizado:** VAL-IO; deduplicação de F4; F1 seguido de F5. Trabalhos independentes em paralelo; F3 separado para não confundir medições.
3. **Lote CI:** E1 conservador e desenho de E3 coordenados. E2 fica fora até existir evidência da cobertura substituta.
4. **Lote banco:** classificação de D3; D1 após observar B3. D4 somente medição; D5 em **07/11, 10:33 UTC**, conferindo que os contadores não reiniciaram. F2 permanece diagnóstico.

**Prova SQL + segunda opinião:** F4 se virar RPC, D3 ao alterar funções/frescor, D4 antes de alterar RLS; D1 exige prova PG17 de HOT, leituras e locks. UTI exige prova do casamento/completude; se introduzir SQL, também execução sob papéis reais.

**Segunda opinião money-path, com testes comportamentais:** UTI, HST, E5, E7 e VAL-IO. SQL não é obrigatório só por uma alteração permanecer em TypeScript. F2/F3 e E1/E3 também merecem segunda opinião arquitetural pelos contratos envolvidos.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.yKlAuSeVhq)
