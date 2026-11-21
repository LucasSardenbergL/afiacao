# Automação bancária e financeira (Itaú primeiro) → app → Omie — design

> Status: **v2** (escopo ampliado pelo founder: programa de automação bancária, financeira e contábil), rascunho para aprovação · 2026-11-20 · branch `claude/itau-omie-bank-integration-f75d76`
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

**v2 (founder, 2026-11-20): automatizar tudo que é banco e o trabalho administrativo, financeiro e contábil em volta dele.**
- O app **sugere** os pagamentos que o Lucas tem de liberar.
- O Lucas libera sozinho, sem a Jessica.
- Liberado, o app inclui o pagamento no banco (Pix, boleto, TED).
- O extrato consolidado de **todas** as contas sai para o e-mail da contabilidade assim que estiver disponível.
- Outras automações contábeis entram conforme aparecerem.

## 2. Objetivos · não-objetivos · anti-objetivos

**Objetivos**
- O livro do Omie volta a bater com o Itaú, conta por conta e em centavos, a partir de uma data de corte.
- A baixa de CP/CR e o lançamento de tarifas saem da mão da pessoa e passam por **aprovação no app**. Depois, quando houver sinal de precisão, ficam automáticos para os casamentos inequívocos.
- **Extrato consolidado** de todas as contas (Itaú nas 3 empresas, BB, Omie.CASH, Justa, adquirentes), validado e enviado à contabilidade quando estiver disponível.
- **Pagamentos sugeridos pelo app.** O Lucas libera no app, o app inclui no Itaú e o Lucas confirma no Itaú com o token. A Jessica sai do processo.
- Cobrança (boleto/Pix) via API, se houver demanda medida.
- Automações contábeis de fechamento mensal (ver Frente F).

**Não-objetivos (agora)**
- Conciliar e baixar no Omie contas que não sejam do Itaú. BB, Omie.CASH, Justa e adquirentes entram **na leitura e no extrato consolidado** primeiro. A conciliação delas vem depois do piloto Itaú.
- **Pagamento sem a confirmação do Lucas com o token do Itaú. Nunca acontece, em nenhuma fase** (decisão do founder, 2026-11-20). Execução direta só pelo app fica adiada e exige os controles da Frente C.
- O agente de código **nunca** dispara pagamento. Quem inclui é o app, depois do clique do Lucas.

**Anti-objetivos (seria um fracasso mesmo funcionando)**
- **Baixa em dobro:** o app e a pessoa, ou o app duas vezes, baixando o mesmo título.
- **Fabricar número:** lançar ajuste para "zerar" a diferença, baixar pela data de vencimento, ou baixar só porque o status diz "atrasado".
- **Escrever retroativo em período fechado** sem o aval do contador.
- **Derrubar a App Key do Omie com erros:** depois de 10 erros vem o HTTP 425 e um bloqueio de 30 min, que também derruba o sync.
- **Pagar em dobro:** sugerir ou incluir um título que já foi pago, agendado ou enviado.
- **Pagar a quem não deve:** Pix cujo titular ou CNPJ, consultado no banco, não bate com o fornecedor; boleto com beneficiário diferente.
- **Mandar à contabilidade um extrato incompleto como se fosse completo.** Conta faltante ou que não fecha aparece escrita no e-mail.

## 3. Abordagens consideradas

| | Como | Prós | Contras |
|---|---|---|---|
| **A — Arquivo → app → Omie, API depois** ✅ escolhida | O financeiro sobe o extrato do Bankline (OFX/CNAB 240). O app valida, concilia, propõe a baixa, uma pessoa aprova e o app grava no Omie. Quando a API Itaú sair, ela alimenta o **mesmo** importador. | Começa já, sem contrato. Cobre o histórico de 1 ano. O arquivo serve de evidência independente. | Há um upload manual até a API chegar. |
| B — API Itaú desde o dia 1 | Edge com OAuth2 + mTLS no STS/gateway do Itaú. | Totalmente automático. | Depende de convite do officer, aceite de um Owner no Bankline e certificado por CNPJ. O **mTLS no Supabase Edge Runtime não está confirmado** (há relato de falha do `Deno.createHttpClient` com cert). São semanas até o 1º número. |
| C — Reativar o Omie via Open Finance | O Omie importa o extrato D-1 e a conciliação é feita dentro do Omie. | É o mais barato. | Vai contra a intenção do founder: o Omie continua dono do dado bancário, e esse canal já falhou uma vez. |

**Escolha:** A, com o pedido da API de Extrato ao gerente Itaú **em paralelo**, porque o prazo é do banco. O founder disse que quer automatizar tudo, e A é o caminho mais curto até isso. A API entra como troca de fonte.

## 4. Fases e critério para avançar

### Programa (v2): frentes e ordem

| Frente | O que entrega | Fases | Ordem |
|---|---|---|---|
| **A — Extrato consolidado + contabilidade** | Extrato de todas as contas no app, validado. E-mail à contabilidade quando estiver disponível. | F1 (Itaú Oben) → F1b (todas as contas + envio) | 1ª |
| **B — Conciliação e baixa no Omie** | Fim da baixa manual | F2 → F3 | 2ª |
| **C — Pagamentos** | Sugestão diária → liberação no app → inclusão no Itaú → confirmação com token → baixa após liquidação | F6 (antes da F5, sugestão do Codex) | 3ª |
| **D — API Itaú** | Troca o upload pela API. Corre **em paralelo**, porque o prazo é do banco. | F4 | paralela |
| **E — Cobrança** | Boleto/Pix próprios | F5 | se houver demanda medida |
| **F — Contábil** | Pacote de fechamento mensal (extratos, conciliação, pendências), tarifas, impostos | a especificar depois da B | 4ª |

A F2 já calcula a "sugestão do dia" em leitura, para a Frente C nascer sobre um livro conciliado. Sugestão sobre livro descolado paga em dobro.

**Dependências reais (Codex v2):**
- A F2 começa quando a **F1 estiver validada na Oben**, sem esperar as outras fontes.
- A F1b corre **em paralelo** à Frente B.
- A F6 só abre para a conta pagadora que estiver com **conciliação comprovada**.

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

### F1b — Extrato consolidado de todas as contas + envio à contabilidade (só leitura)
- Mesmo modelo `banco_extrato_*`, com uma **fonte por conta**. As fontes por conta estão em §4c.
- **Uma conta bancária real conta uma vez.** Isso vale para a "Pix Itaú" e para as contrapartes que só existem no Omie.
- Justa e adquirentes: confrontar bruto, taxas, antecipações e estornos com o crédito líquido. Na F1b isso só é **exibido**, sem conciliar.
- **Pacote por período, por empresa e conta:**
  - arquivo original;
  - arquivo importável;
  - resumo com saldos inicial e final, nº de movimentos e se fecha em centavos;
  - pendências.
- **Contas esperadas fixadas por CNPJ e período**, com as exclusões explícitas (ex.: B76). Período sem movimento também precisa estar coberto. Agenda de recebíveis **não** prova liquidação.
- **Contas faltantes ou que não fecham aparecem escritas**, nunca omitidas. No prazo combinado com a contabilidade, as pendências são comunicadas mesmo que o pacote completo ainda não possa sair.
- **Destinatários autorizados por empresa** (sem e-mail no código):
  - o cadastro e qualquer alteração são confirmados pelo Lucas por canal independente;
  - a autorização é conferida a cada acesso.
- **Entrega por link autenticado, revogável e com expiração**, com só os documentos necessários (LGPD art. 6º, necessidade). Anexo só se a contabilidade exigir e o Lucas aprovar.
- Cada envio fica registrado: o que foi, para quem, quando e o hash dos arquivos. Reenvio é explícito.
- Sensor: `banco.pacote_contabil_enviado`, com denominador **contas validadas ÷ contas esperadas**.

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

### F6 — Pagamentos (Frente C; vem antes da F5)
Fluxo decidido pelo founder (2026-11-20): **app + token Itaú**.
1. **Sugestão diária.** O app monta a lista do que pagar a partir do CP do Omie. Antes, cruza essa lista com o extrato conciliado, os agendamentos e as ordens já enviadas, para não pagar em dobro. Prioridade e caixa vêm dos engines financeiros existentes.
2. **Liberação no app pelo Lucas**, único aprovador. A liberação amarra empresa, conta pagadora, título/parcela, favorecido, valor e data. Mudou algo depois da liberação, precisa liberar de novo.
3. **Inclusão no Itaú pelo app**, que nasce **pendente de alçada**. Reserva atômica por (empresa, título, parcela). Resultado desconhecido bloqueia novo envio até consultar o banco.
4. **O Lucas confirma no app Itaú Empresas ou no Bankline com o token.** A última chave fica fora do nosso sistema. Assim, um app ou Supabase comprometido não consegue tirar dinheiro.
5. **Baixa de CP no Omie só depois da liquidação confirmada** no extrato ou no retorno. Pagamento incluído ou agendado continua pendente.

Controles desde o 1º pagamento (challenge Codex v2):
- **A alçada é provada, não presumida.** Cada combinação de CNPJ × modalidade × canal (API ou CNAB) começa **desabilitada**. Só é habilitada com prova de três coisas:
  - a ordem nasce pendente;
  - só o Lucas autoriza, com token;
  - a credencial do app não consegue liquidar.
- **Corte de inclusões.** A partir da ativação, ninguém mais inclui pagamento de CP no Bankline para a conta do piloto. As pendências e os agendamentos anteriores são importados. **Imediatamente antes do envio**, o app revalida título, agendamentos e ordens. Se a consulta falhar ou estiver desatualizada, bloqueia.
- **O destino exato entra na liberação** e é conferido no servidor antes da inclusão:
  - Pix: chave, titular e documento;
  - TED: banco, agência, conta, titular e documento;
  - boleto: linha digitável, beneficiário, valor e a referência da obrigação.
- **Uma liquidação, uma baixa.** Ordem, retorno e movimento de extrato se ligam à **mesma liquidação bancária**. O comando de baixa por parcela é único (UNIQUE), seja disparado pelo retorno ou pela F2/F3.
- **Pix:** titular e CPF/CNPJ da chave consultados no Itaú (DICT) e comparados com o fornecedor do título. Divergência ou identidade insuficiente bloqueia.
- **Boleto:** o beneficiário registrado é conferido com o fornecedor.
- A credencial da API tem **escopo só de inclusão** quando o Itaú permitir.

**Pré-condição (founder pergunta ao Itaú, por escrito):** para cada CNPJ e cada modalidade (Pix, boleto, TED), a inclusão por API nasce pendente da alçada do Lucas? Se a API não garantir isso, o caminho é **CNAB SISPAG com autorização bancária obrigatória**, com o mesmo fluxo e só outro transporte.

**Adiado: execução direta só pelo app.** Exige, no mínimo:
- passkey/MFA renovado por liberação;
- executor isolado do Supabase, com credencial por CNPJ e verificação independente da liberação;
- favorecidos permitidos, com alteração confirmada fora do app;
- limites por operação e por dia, e janela de horário;
- alertas externos e botão de bloqueio imediato.

Só volta à mesa com decisão nova do founder.

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

## 4c. Fontes de extrato por conta (levantamento Fable, 2026-11-20)

Hoje o app lê só o **livro do Omie**: `ListarMovimentos` vai para `fin_movimentacoes` e `ListarExtrato` serve só para saldo (`omie-financeiro/index.ts:626-640`). Esse livro serve para comparar, **nunca é a fonte do extrato**.

| Conta | Fonte do extrato na F1b | Depois | Status |
|---|---|---|---|
| Itaú (3 empresas, + "Pix Itaú") | OFX/CNAB do Bankline | API de Extrato Itaú (F4) | arquivo confirmado; API depende do officer |
| BB (Oben) | OFX do portal BB, a confirmar com arquivo real | API Extratos **v2** (mTLS provável). **A v1 sai do ar em 20/11/2026**, e a integração nativa do Omie com o BB pode parar junto | não confirmado |
| Omie.CASH (SC, Oben) | `ListarExtrato` com movimentos, a testar com chamada read-only. Fallback: Excel exportado pela tela | — | export PDF/XLSX confirmado; API não confirmada |
| Justa (Colacor, Oben) | extrato e agenda de recebíveis pela API Justa (portal `api.justa.com.vc`) ou export | — | endpoints não confirmados |
| Adquirentes 950/971 | agenda de recebíveis do adquirente, a levantar | — | não levantado |
| Desconto de duplicatas (B76) | fora da F1b; volume quase zero | — | — |

- **Open Finance do Omie** (Itaú Empresas, D-1): existe, mas o extrato só vira lançamento quando alguém importa e concilia dentro do Omie. Não há API pública conhecida para ler o extrato bruto. **Não serve de fonte para o app**, só como alternativa operacional dentro do Omie.
- **E-mail:** Resend, via `fetch` repetido em várias edges, nenhuma com anexo (`monthly-report/index.ts:328`). A F1b cria um helper em `_shared` e o primeiro envio com anexo ou link.
- A F1b entra por fonte, na ordem: Itaú → BB → Omie.CASH → Justa → adquirentes. A cada fonte o pacote passa a dizer "N de M contas".

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
   - **pagamentos por API, para cada CNPJ e cada modalidade (Pix, boleto, TED):**
     - a inclusão nasce pendente de alçada?
     - o Lucas pode ser o único aprovador?
     - existe credencial só de inclusão?
     - quais os limites e horários?
     - a API faz consulta DICT do titular?
     - qual a chave de idempotência e como consultar depois de um timeout?
2. Baixar no Bankline o extrato da Oben (conta Itaú principal) desde 01/11/2025, em OFX ou CNAB 240, para o piloto.
3. Combinar com a pessoa que baixa à mão a transição para aprovar no app.
4. Perguntar ao contador:
   - até que mês o período está fechado;
   - **o que ele quer receber**: formato (OFX, PDF, Excel), frequência, e-mail destinatário e se aceita link restrito em vez de anexo.

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

5. **Escopo v2 e última chave do pagamento.** O app sugere, o Lucas libera sozinho no app, sem a Jessica, e o app inclui no Itaú. A **confirmação final é no Itaú, com o token** (opção "App + token Itaú", recomendada por mim e pelo Codex). → Vale a F6 como reescrita acima. A 7b.1 continua valendo para o casamento 1:1, só muda quem inclui o pagamento.

## 8. Fica para o builder

Layout da tela, heurística fina de casamento (com testes de propriedade), mapeamento de categoria de tarifa, formato exato do OFX/CNAB que o Bankline exporta (confirmar com arquivo real).
