# Radar sucessor, passo 3: vale usar o CPF mascarado do sócio? (medição, 2026-11-06)

> Entrega **só de medição**: nenhuma migration, edge ou código de produto. Passos 1 e 2 em
> `radar-abriu-ficha-com-cnpj-2026-11-06.md` e `credito-aviso-vinculo-vencido-2026-11-06.md`; viabilidade em
> `radar-sucessor-viabilidade-2026-11-04.md`. Os pares e a amostra (com nome de pessoa e CPF parcial) ficaram só no
> scratchpad da sessão e foram **apagados** depois da revisão. Aqui ficam contagens e descrições anonimizadas.

## Fonte e método

- **QSA:** dump RFB `2026-10` (o mesmo lote vigente em `radar_empresas`), `Socios0..9.zip`, saneado como a carga faz
  (iconv `-c` + descarte de linha com aspas ímpares, que deu 0 linhas). São **28,5 mi** linhas e **17,0 mi** raízes. Das
  linhas, **27,7 mi são PF, e 100% delas têm máscara no formato `***dddddd**`.**
- **Prod (psql-ro, `exit 0`):** `radar_empresas` (573.021 linhas, 3.021 `ja_cliente`), `profiles` com CNPJ (15.226
  documentos) e os clientes com título `ATRASADO` em aberto pelo caminho `account_map` (188 documentos).
- **Regra atual** = cópia literal do sinal `pessoa` de `private.radar_vinculos_base` (20261106205557): nome com ≥3
  palavras `[A-Z]`, vindo do QSA ou do titular de MEI, aparece em ≤2 raízes do Radar, e o cliente **no Radar** fica no
  **mesmo município**.
- **Regra nova** = nome normalizado (sem acento, espaços colapsados) **e** CPF mascarado iguais, com a chave em ≤2
  raízes do universo (Radar ∪ clientes), **sem município** e com o cliente **dentro ou fora** do recorte. Do lado MEI,
  a máscara vem do CPF da razão social (dígitos 4 a 9). A fórmula foi validada no dado: com 4-9, **550** MEIs casam um
  QSA de outra raiz; com 3-8, **0**.
- Granularidade: par (CNPJ do lead, raiz do cliente). O sujeito é não-cliente (prospecção), salvo onde está dito
  crédito.

## Números

| | Pares | Leads |
|---|---:|---:|
| Regra atual | 30 | 30 |
| Regra nova (só a chave) | 140 | 130 |
| As duas | 22 | 22 |
| **Só a nova (ganho bruto)** | **118** | **108** |
| Só a atual | 8 | 8 |

**De onde vem o ganho bruto:** 108 dos 118 pares têm o cliente **fora do recorte**. É o achado principal: **11.994
das 15.004 raízes de cliente (80%) estão fora do Radar**, e para elas a regra atual não tem sócio nenhum. Os outros
10 pares são com clientes do Radar: 8 em outro município da mesma UF e 2 em outra UF. No mesmo município, o ganho foi
**0**, porque ali a regra atual já pegava tudo.

**Revisão à mão** (estratificada, sem nome de pessoa nem CPF na tela):
- **Clientes do Radar (os 10 pares, todos revisados):** todos plausíveis. É o mesmo grupo (vários administradores em
  comum em filiais de 2 estados) ou o mesmo dono com a mesma marca. **1 deles é devedor.**
- **Clientes fora do recorte, regra crua (20 de 108):** contaminada. Diretores e conselheiros de S.A. grande
  (qualificações 08 e 10, chave presente em 15 a 30 empresas no país) e síndico de condomínio aparecem como "mesmo
  sócio". A exclusividade "≤2 raízes **no nosso universo**" não vê o resto do país.
- **Com 2 filtros** (a chave em **≤3 empresas no país inteiro** e qualificação de dono, `05/22/49/65`, nos dois lados;
  titular de MEI conta como dono), sobram **40 pares fora do recorte** e mantêm-se os 10 do Radar. Revisão dos 40:
  ~18 com a marca ou o nome comercial batendo, ~20 com o mesmo dono e outro negócio (vínculo de dono plausível) e ~2
  duvidosos (grupo multinacional, franquia). **A identidade da pessoa é plausível em ≥90%.** Sucessão de fato
  (empresa nova no lugar da velha) é só uma fração, por isso o texto tem de ser **"mesmo sócio (CPF parcial
  igual)"**, sempre como pista.

**Ganho líquido com os filtros:** **+50 leads** com pista forte. A regra atual tem 30 e o total de vínculos visíveis
hoje é ~166 leads.

**Crédito:** a regra nova acrescenta **2 pares** com devedor (1 com sujeito não-cliente). A regra atual dá 3.

**Perdas (só na atual, 8):** 7 não têm máscara num dos lados, como o MEI no formato `12.345.678 NOME`, que não traz o
CPF. A 8ª tem a chave fora da exclusividade nova. **Nenhum** par atual tem CPF parcial conflitante. Mesmo assim, há
5.570 nomes (≥3 palavras) com mais de 1 máscara no universo, 3.733 deles em exatas 2 raízes: são homônimos que a
regra só por nome poderia casar. ⇒ se construir, a regra atual **fica** (união) e ganha a guarda "máscaras dos dois
lados e diferentes ⇒ não casa por nome".

**Custo:** a tabela teria **~206 mil linhas** (203 mil PF com máscara; 14,7 mil das raízes de cliente fora do
recorte; nome com 23,8 caracteres em média). A estimativa é de ~20 MB de heap mais ~20 MB de índices, a medir no
PG17 se seguir. Não há download novo, porque a carga já baixa e varre Socios. O DuckDB leva ~27 s para ler o QSA do
país e <2 s para a regra. A transmissão seria ~42 POSTs de 5 mil linhas. O filtro nacional exige 1 coluna
`n_raizes_pais`, calculada na carga.

## Uso (o sinal da fase N, prod, 2026-11-06)

| Sensor | 30 dias |
|---|---:|
| Fichas do Radar abertas por humano (`abriu` com CNPJ) | 3 fichas, 3 leads, **1 titular** |
| Avisos de crédito por vínculo servidos (`credito.vinculo_aviso_servido`) | **0** |
| Contatos humanos no Radar (fora descarte em lote) | **0** de 64.299 |

## Parecer

A regra nova tem **ganho real de qualidade**: +50 leads com pista forte, e cobre os 80% de clientes fora do recorte.
Mas **só depois dos 2 filtros**. Crua, ela importa falso positivo de diretor e conselheiro de S.A. O ganho de crédito
é marginal (+2 pares). O **uso** da superfície que mostraria o ganho é praticamente nulo (1 titular, 0 avisos, 0
contatos). Construir agora é fase N+1 sem sinal da fase N, e o custo inclui **guardar dado pessoal** (nome + CPF
parcial de ~200 mil sócios) com o dever LGPD que vem junto. Decisão de construir ou esperar: do founder.

## Se for construir (desenho já medido)

`radar_socios(raiz, tipo, nome_normalizado, cpf_mascarado, qualificacao, data_entrada, n_raizes_pais, lote)`, só do
servidor. Entram só PF com máscara válida, das raízes do Radar ∪ clientes. Sinal `pessoa` nova =
nome + máscara, `n_raizes_pais ≤ 3`, qualificação de dono nos dois lados. A guarda de máscara conflitante entra na
regra por nome. Edição só em `private.radar_vinculos_base`. Scripts da medição (sem dado):
pasta de notas da sessão (`radar-socios-medicao-sql/`).

## Quando medir de novo ("quando" é query)

As 3 queries de uso acima estão em `radar-sucessor-viabilidade-2026-11-04.md` §"Quando medir de novo" e em
`credito-aviso-vinculo-vencido-2026-11-06.md` §"Quando medir". Gatilho para construir: ≥1 vendedor com fichas
abertas **e** ≥1 aviso de crédito servido ou contato humano no Radar, com denominador.
