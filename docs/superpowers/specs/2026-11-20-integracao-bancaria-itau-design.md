# Integração bancária Itaú → app → Omie — design

> Status: rascunho para aprovação do founder · 2026-11-20 · branch `claude/itau-omie-bank-integration-f75d76`
> 2ª opinião: Codex (gpt-6.2-astra, high) consultado no brainstorm. Levantamentos: Fable (banco prod read-only + pesquisa web).

## 1. Por quê

A integração nativa Omie↔Itaú (extrato + remessa/retorno CNAB) está **suspensa** pelo Omie desde o comunicado de 30/06/2026, sem data de volta. Medido na prod em 20/11/2026 (`psql-ro`, conferido por mim):

| | Colacor | Oben | Colacor SC |
|---|---|---|---|
| Lançamentos de origem extrato (EXTR/EXTP, inclui tarifas) | último **19/11/2025**, 0 depois | último **19/11/2025** | último **23/10/2025** |
| CP com vencimento em 10/2026: pagos / atrasados | 24 / 28 | 60 / 18 | 10 / 13 |
| CP com vencimento em 11/2026 (até dia 19): pagos / atrasados | **0** / 21 | **0** / 29 | **0** / 17 |
| Saldo Itaú segundo o Omie | −R$ 345.951 | +R$ 453.515 | −R$ 200.479 |

Contas Itaú: uma conta corrente por empresa (agência/conta ficam só no cadastro `fin_contas_correntes`, fora do repo) + contas "Pix Itaú" que existem só no Omie.

Os pagamentos são feitos **no Bankline** (founder, 2026-11-20). **Uma pessoa baixa à mão no Omie** e não dá conta. Por isso o livro do Omie descolou do banco, e o que o app deriva dele fica contaminado: DRE caixa, fluxo de caixa, aging, trava de crédito.

**O que o founder quer:** automatizar tudo. O app conversa direto com o Itaú, que é a fonte de verdade do banco, e repassa o resultado ao Omie, que fica como registro contábil. O escopo final cobre extrato e conciliação, retorno de cobrança, pagamentos e remessas.

## 2. Objetivos · não-objetivos · anti-objetivos

**Objetivos**
- O livro do Omie volta a bater com o Itaú, conta por conta e em centavos, a partir de uma data de corte.
- A baixa de CP/CR e o lançamento de tarifas saem da mão da pessoa e passam por **aprovação no app**. Depois, quando houver sinal de precisão, ficam automáticos para os casamentos inequívocos.
- Cobrança (boleto/Pix) e pagamentos (SISPAG) via API nas fases finais.

**Não-objetivos (agora)**
- Conciliação de Banco do Brasil e Omie.CASH. O desenho é multi-banco, mas a entrega é só Itaú.
- Executar pagamento sem aprovação humana no Bankline. **Isso nunca acontece**, em nenhuma fase.

**Anti-objetivos (seria um fracasso mesmo funcionando)**
- **Baixa em dobro:** o app e a pessoa, ou o app duas vezes, baixando o mesmo título.
- **Fabricar número:** lançar ajuste para "zerar" a diferença, baixar pela data de vencimento, ou baixar só porque o status diz "atrasado".
- **Escrever retroativo em período fechado** sem o aval do contador.
- **Derrubar a App Key do Omie com erros:** depois de 10 erros vem o HTTP 425 e um bloqueio de 30 min, que também derruba o sync.

## 3. Abordagens consideradas

| | Como | Prós | Contras |
|---|---|---|---|
| **A — Arquivo → app → Omie, API depois** ✅ escolhida | O financeiro sobe o extrato do Bankline (OFX/CNAB 240). O app valida, concilia, propõe a baixa, uma pessoa aprova e o app grava no Omie. Quando a API Itaú sair, ela alimenta o **mesmo** importador. | Começa já, sem contrato. Cobre o histórico de 1 ano. O arquivo serve de evidência independente. | Há um upload manual até a API chegar. |
| B — API Itaú desde o dia 1 | Edge com OAuth2 + mTLS no STS/gateway do Itaú. | Totalmente automático. | Depende de convite do officer, aceite de um Owner no Bankline e certificado por CNPJ. O **mTLS no Supabase Edge Runtime não está confirmado** (há relato de falha do `Deno.createHttpClient` com cert). São semanas até o 1º número. |
| C — Reativar o Omie via Open Finance | O Omie importa o extrato D-1 e a conciliação é feita dentro do Omie. | É o mais barato. | Vai contra a intenção do founder: o Omie continua dono do dado bancário, e esse canal já falhou uma vez. |

**Escolha:** A, com o pedido da API de Extrato ao gerente Itaú **em paralelo**, porque o prazo é do banco. O founder disse que quer automatizar tudo, e A é o caminho mais curto até isso. A API entra como troca de fonte.

## 4. Fases e critério para avançar

Cada fase só começa com **sinal positivo de uso da anterior, com denominador** (regra da casa, `docs/historico/fase-sem-sinal.md`). Cada superfície nasce com o seu sensor.

### F1 — Extrato bancário independente (só leitura)
- Tabelas novas, todas com RLS:
  - `banco_extrato_arquivo`: empresa, conta, período, hash do arquivo, arquivo original no Storage, saldo inicial/final, quem subiu e quando.
  - `banco_extrato_linha`: uma linha por movimento, com data, valor em centavos (inteiro), sentido, descrição, documento e **id bancário** quando houver (FITID no OFX, número de lançamento no CNAB).
- O parser é um helper TS puro (vitest), espelhado na edge.
- **Fecha em centavos ou recusa o arquivo inteiro:** saldo inicial + créditos − débitos = saldo final. Nada de import parcial.
- **Idempotência:**
  - Reimportar o mesmo período, ou um período sobreposto, não duplica linha.
  - A chave é o id bancário quando estável. Sem id, usa (conta, data, valor, documento, ordinal no dia).
  - Duas tarifas iguais no mesmo dia são legítimas, por isso o ordinal entra na chave.
- A tela mostra o extrato por conta e o **saldo Itaú vs saldo Omie** por dia.
- **Avança quando** o financeiro usar o extrato para conferir um período real (sensor: `banco.extrato_importado` / `banco.extrato_conferido`).

### F2 — Conciliação em leitura (fila humana)
Substitui a tela inerte `FinanceiroConciliacao`. Os defeitos (a)–(g) de `src/services/financeiroConciliacao.ts` são resolvidos por construção.
- Para cada linha do extrato, o motor procura **nesta ordem**:
  1. **baixa já existente no Omie**, inclusive a feita pela pessoa à mão. Isso vira o estado `ja_registrado`;
  2. título em aberto que case. Isso vira `baixa_proposta`;
  3. nenhum casamento. Isso vira `sem_evidencia`.
- Casa por empresa, conta, sentido, valor **líquido efetivo** e referência verificável (documento, nosso número, CNPJ do favorecido).
- Lote, parcial, juros e desconto precisam de composição demonstrável. Se não houver, o item fica `sem_evidencia`, nunca vira chute.
- Tarifas viram `lancamento_proposto` (IncluirLancCC) com a categoria mapeada.
- A decisão humana fica em `banco_conciliacao`, com **UNIQUE por linha de extrato** e um único escritor. O sync do Omie não toca nessa tabela.
- A leitura é paginada com ordem estável e em lote. Nada de N+1.
- **Atenção à data real da baixa:** o LIST do Omie não traz a data de baixa (`docs/agent/financeiro.md`). A baixa existente se detecta por `fin_movimentacoes` (`omie_ncodbaixa`/`data_pagamento_omie`) ou por consulta pontual.
- **Piloto:** conta Oben (conta Itaú principal) + os 29 títulos de CP vencidos em 11/2026.
- **Avança quando** houver uso recorrente da fila e a revisão dos falsos positivos estiver medida. Precisão > recall.

### F3 — Escrita no Omie aprovada (money-path)
- Começa por **CP do período aberto**. CR entra depois de entender quem gera as 200–300 baixas de boleto por mês da Oben (retorno automático ou a pessoa).
- **Comando único** por (linha de extrato × título), com aprovador, carimbo e chave estável:
  - em CP, `codigo_baixa_integracao` derivado do id da conciliação;
  - em CR, a mesma ideia com o campo equivalente.
  - A semântica de repetição é **testada** antes do uso. Não presumimos que o Omie deduplica.
- **Antes de enviar:** reler o título no Omie e abortar se já estiver baixado (a pessoa pode ter baixado no meio do caminho).
- **Timeout depois do envio** vira estado `resultado_desconhecido`. Só sai desse estado por consulta ao Omie ou por revisão humana. Nunca há reenvio cego.
- **`conciliar_documento=S` só na escrita aprovada.** CP não tem ConciliarPagamento depois, então o momento certo é na própria baixa.
- **Tarifas:** IncluirLancCC só com categoria aprovada, e depois de checar que não existe lançamento anterior igual.
- **Fila serializada por (empresa, método)**, coordenada com o sync:
  - respeita 240/min e 4 simultâneas;
  - corta antes do 10º erro;
  - em 425, pausa aquela combinação por 30 min.
- **Retroativo (backlog desde 11/2025):**
  - o app **simula** o impacto mês a mês (DRE caixa, saldo) e mostra isso antes de escrever;
  - grava só em mês aberto;
  - mês fechado exige o aval do contador, registrado no app;
  - nunca há ajuste para zerar diferença.
- **Transição da pessoa que baixa à mão:** ela passa a **aprovar no app** em vez de baixar no Omie. Enquanto a migração não termina, o passo "baixa já existente" (F2.1) evita a dupla baixa.
- **Automático sem aprovação** só depois de medida a precisão por tipo de casamento, e só para o tipo inequívoco (ex.: CP com id/documento exato e valor exato). É uma decisão do founder, com dado na mão.
- Prova obrigatória: PG17 (`prove-sql-money-path`) para o SQL, testes do helper com falsificação, e o ritual Codex no diff.

### F4 — API de Extrato Itaú (troca de fonte)
- A edge `itau-extrato` (OAuth2 client_credentials + mTLS) alimenta o mesmo `banco_extrato_linha`, com origem `api`.
- **Spike primeiro:** uma edge publicada no Lovable obtém token no STS e lê a conta esperada. Se o mTLS falhar no Edge Runtime, o plano B é um proxy mínimo fora do Supabase. Isso é decisão do founder na hora.
- Credenciais por CNPJ, guardadas em Supabase Secrets, com alerta de expiração do certificado. O vínculo CNPJ↔conta↔App Key Omie fica no servidor.
- Cron com `timeout_milliseconds` explícito, entrando no data-health.

### F5 — Cobrança via API (boleto/Bolecode + Pix)
- Entra se a F3 mostrar trabalho recorrente que a emissão própria resolve.
- O webhook autentica e deduplica.
- O que se perder é recuperado por consulta ou retorno. Webhook, retorno e extrato apontam para a mesma liquidação.
- Pilotar só com títulos novos.

### F6 — Pagamentos SISPAG
- O app monta a remessa ou o lote, e **a aprovação continua no Bankline** (alçada do Itaú).
- A aprovação fica vinculada a beneficiário, conta, valor e data.
- A baixa de CP só acontece **depois da liquidação confirmada** no extrato ou no retorno. Remessa aceita ou agendada continua pendente.

## 4b. Invariantes do money-path (challenge do Codex, 2026-11-20 — todas obrigatórias antes da 1ª escrita)

1. **Um canal de baixa por carteira.** A partir de um **corte** (conta + data/hora), os CP do piloto só são baixados pelo app. Antes do corte, conferir as baixas em trânsito. Se precisar voltar ao manual, primeiro pausar o envio e resolver todo `resultado_desconhecido`. A fila local não enxerga a escrita manual, então sem corte a dupla baixa é possível mesmo com o passo "baixa já existente".
2. **Comando durável antes da chamada.** Persistir o comando e o conteúdo aprovado, e reservar o envio atomicamente (`pendente → enviando`). Todo envio interrompido, inclusive depois de reinício do worker, vira `resultado_desconhecido`. Nova tentativa ou nova proposta para a mesma liquidação fica **bloqueada** até verificar no Omie a identidade da baixa (título, conta, data, valor). Uma consulta vazia logo depois do envio **não prova falha**.
3. **Vínculo exclusivo 1:1:1.** Um movimento bancário ↔ uma parcela ↔ uma baixa Omie. UNIQUE nos **três** lados, com reserva em transação. Assim, dois débitos de R$ 500 não podem apontar para a mesma baixa manual. No piloto:
   - a referência tem que distinguir a parcela;
   - tem que haver **um único candidato** em todo o universo da conta;
   - evidência desatualizada, parcial ou conflitante bloqueia a proposta;
   - o espelho preserva baixas canceladas, e o saldo local de CP pode continuar cheio em título pago (`docs/agent/financeiro.md`). Por isso a releitura no Omie é obrigatória.
4. **A aprovação amarra exatamente o que será escrito.** No servidor, na execução:
   - validar a permissão para aquela empresa;
   - derivar a App Key e a conta Omie do vínculo cadastrado, nunca do payload do cliente;
   - conferir título, valor, data efetiva da baixa e período aberto.
   Qualquer mudança desde a aprovação exige nova aprovação.
5. **O extrato tem que ser o certo, não só fechar a conta.** Exigir:
   - agência/conta do arquivo compatível com a conta cadastrada;
   - só movimentos efetivados;
   - saldos de abertura e fechamento verificáveis;
   - continuidade entre períodos (o saldo final de um é o inicial do seguinte).
   Sobreposição ambígua fica pendente. A diferença preexistente Itaú–Omie no corte é registrada à parte. Dia sem cobertura ou sem saldo Omie comprovado aparece como **indisponível**, nunca como zero.

**Escopo do piloto, enxugado:**
- Oben (conta Itaú principal), **um** formato real (o que o Bankline exportar) e **um período aberto completo**.
- Conferir **todos** os débitos do período, inclusive os pagos à mão, os ambíguos e os sem título, e não só os 29 vencidos, que esconderiam candidatos concorrentes.
- **Ficam para depois do piloto:** o 2º parser, o retroativo anual, tarifas, lotes e parciais.
- **Métricas para liberar a escrita aprovada de CP 1:1:**
  - propostas erradas ÷ propostas revisadas;
  - baixas corretas ÷ pagamentos elegíveis;
  - **zero** reutilização de evidência.

## 5. Restrições

- Lovable Cloud: as 3 camadas de deploy são manuais (Publish · edge · migration), e migration custom não se auto-aplica (`docs/agent/deploy.md`).
- Valores em **centavos inteiros**. Ausente ≠ zero.
- 3 empresas = 3 App Keys Omie. Toda tabela e comando carrega `company`.
- Tabela nova sempre com RLS. A escrita no Omie só sai de edge com gate de staff/financeiro, com permissão própria (`pode_conciliar` ganha uma UI de concessão, só pelo master).
- Arquivo novo em `src/` precisa de dono no manifesto de módulos.
- Segredos (App Key, certificado Itaú) nunca entram em texto plano no chat nem no repo.

## 6. Ações fora do código (founder)

1. Pedir ao gerente/officer Itaú a **API de Extrato**, para as 3 empresas, e as respostas:
   - é intradia? traz saldo? qual a janela?
   - quais modalidades a API SISPAG cobre, e o pagamento nasce pendente de alçada no Bankline?
   - qual o formato e a autenticação do webhook de boleto?
   - quais as tarifas e os limites de requisição?
   - existe canal de arquivo (VAN/SFTP)?
2. Baixar no Bankline o extrato da Oben (conta Itaú principal) desde 01/11/2025, em OFX ou CNAB 240, para o piloto.
3. Combinar com a pessoa que baixa à mão a transição para aprovar no app.
4. Perguntar ao contador até que mês o período está fechado.

## 7. Decidido pelo builder (calls marcadas)

- Nomes de tabela `banco_*`, em pt-BR e neutros de banco: *call minha*.
- Formato de entrada da F1: OFX **e** CNAB 240 de extrato. Se só um vier fácil, começa por ele: *call minha*.
- O piloto começa pela Oben, que tem o maior volume (~15k linhas/ano no Itaú) e saldo positivo, logo é a menos ambígua: *sugestão do Codex, aceita*.

- **Critério "o livro bate"** = a **movimentação pós-corte** Itaú × Omie bate em centavos, e não o saldo absoluto. A diferença preexistente no corte é registrada e exibida à parte. Sem isso, um backlog em mês fechado nunca deixaria o critério convergir: *call minha*.
- **Casamento sem referência** (valor exato + conta + janela de data + **candidato único** no universo da conta) **pode** virar `baixa_proposta`. Recebe a marca `casamento_por_valor`, a precisão é medida à parte, e o item **nunca** entra no modo automático. O automático exige referência verificável: *call minha*.
- **Linhas que não são título nem tarifa** (transferência entre contas, aplicação/resgate, conta garantida, impostos, folha): a F2 **classifica e exibe** todas, para dar a visão completa da diferença. A escrita delas fica para depois do piloto: *call minha*.
- **Baixa manual que diverge do extrato** (data, conta ou valor): vira estado `ja_registrado_divergente`, sinalizado para correção humana no Omie. **Estorno/relançamento pelo app fica fora** do escopo F1–F3: *call minha*.
- O limitador fica compartilhado com o sync. O app guarda histórico diário do saldo Omie, registra o aval do contador e ganha a UI de `pode_conciliar`. Na F2 o app lê CR também, e na F3 escreve só CP: *calls do builder, aceitas*.

## 7b. Respostas do founder (2026-11-20)

1. **Os pagamentos saem um a um no Bankline.** A Jessica inclui cada pagamento e o Lucas libera um por um. → Em regra, cada débito do extrato corresponde a **um** pagamento. O casamento 1:1 é o caso normal, e o lote não entra no piloto.
2. **Corte:** quando a funcionalidade estiver pronta, a baixa de CP **deixa de ser feita no Omie** pela pessoa. → O corte (invariante 4b.1) é a data de ativação. A partir dela o app é o único canal de baixa de CP da conta do piloto. Até lá, a F2 só lê e trata a baixa manual como `ja_registrado`.
   *Ainda em aberto:* até que mês o contador fechou. O piloto fica no **mês corrente, que é aberto**. O retroativo espera essa resposta.
3. **Não há conta Omie de teste.** → A 1ª escrita é uma **prova controlada em produção**:
   - **um** título de CP, escolhido e autorizado pelo founder no momento;
   - o plano de reversão vem escrito antes (`CancelarPagamento` + conferência);
   - a mesma prova testa a repetição do `codigo_baixa_integracao` (reenviar o mesmo comando e observar o que o Omie faz), e a 2ª tentativa só sai com o aval do founder;
   - nenhuma outra escrita acontece antes de a prova passar.
4. **As contas "Pix Itaú" existem só no Omie.** No Itaú é uma conta só. → Uma conta bancária mapeia para **N** `omie_ncodcc` (a principal + a "Pix Itaú"):
   - o casamento procura títulos e baixas nas N;
   - a comparação de saldo soma as N;
   - a idempotência é pela conta **bancária**.

## 8. Fica para o builder

Layout da tela, heurística fina de casamento (com testes de propriedade), mapeamento de categoria de tarifa, formato exato do OFX/CNAB que o Bankline exporta (confirmar com arquivo real).
