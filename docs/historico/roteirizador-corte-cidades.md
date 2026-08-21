# Roteirizador — o LIMIT não estava escondido, o CRITÉRIO estava

> **A classe (2026-08-20):** um `LIMIT` deliberado, escrito no SQL e na constante TS, revisado e
> aprovado — que mesmo assim esconde decisão, porque o problema nunca foi o **tamanho** do corte e
> sim o **eixo** que ordena antes dele. O seletor de cidades de "Visitas em campo" ranqueia por
> *volume de prospects no radar* e corta em 500. A operação real visita cidade por **carteira e
> faturamento**. São eixos ortogonais: a maior fonte de receita que o seletor **não** alcança ocupa a
> posição **917**, e a segunda ocupa a **3.763**.
>
> A regra: **um corte por ranking só é seguro se o eixo do ranking for o mesmo eixo da decisão que
> a tela serve.** Quando não é, aumentar o limite não conserta — só empurra o erro para mais longe.

Origem: pergunta de produto que sobrou fora do escopo do #1821 (que corrigiu as *paginações* —
`carteira_por_municipio` truncando 1.014 clientes de Divinópolis na capa de 1.000 do PostgREST, e
`radar_prospects_para_rota` empatado com ela). Aqueles eram bugs de **transporte**. Este é de
**produto**, e é maior.

## Como foi medido

Prod, 2026-08-20, via `~/.config/afiacao/psql-ro`. `claude_ro` **não tem EXECUTE** nas duas RPCs
(`SECURITY DEFINER` + gate `pode_ver_carteira_completa`), então o corpo de cada uma foi lido com
`pg_get_functiondef` e **reproduzido como SELECT** — mesmos predicados, mesmo `ORDER BY`, mesmo
`LIMIT`. `route_city_norm` também é negada ao `claude_ro`: o corpo dela foi inlinado (NFD → strip
de combining marks → UPPER → remoção do sufixo de UF → colapso de espaços).

## Eixo 1 — `radar_contagem_por_municipio(p_limit: 500)`: **esconde, e é grave**

Universo: **5.457** municípios, **523.183** prospects (`ja_cliente=false AND prospeccao_status <>
'descartado'`). O top-500 cobre 367.441 (70,2%); a 500ª cidade tem **184** prospects.

O corte foi cruzado com três provas independentes de "esta cidade importa", da mais fraca para a
mais forte:

**(a) Carteira cadastrada.** 5.657 clientes não-employee com endereço, 5.655 casados a um município
(99,96% de match), em **277 cidades**. Apenas 125 estão no top-500. **152 cidades com cliente estão
fora**, e nelas vivem **3.061 clientes — 54% da carteira**. O padrão é sistemático: cidade pequena
no radar, densa em carteira. Carmo do Cajuru/MG = 337 clientes e 94 prospects (rank 917); Nova
Serrana/MG = 317 clientes (rank 528, **28 posições** fora do corte); Cláudio/MG = 304 (rank 724).

**(b) Faturamento real.** `venda_items_history`, NF-e de 2025-10-21 a 2026-08-20: R$ 3.304.774.
(As colunas `cliente_cidade`/`cliente_uf` dessa tabela são **100% NULL** nas 6.156 linhas — a
geografia veio por `cliente_cnpj_cpf` → `profiles.document` → `addresses`. `profiles.cnpj` também
está vazia; quem tem dado é `document`.) R$ 118.271 (33 CNPJs, 3,6%) não casaram e estão
**reportados, não imputados**. Do que casou:

| corte | % do faturamento alcançável | cidades faturantes cobertas (de 246) |
|---|---|---|
| **500 (hoje)** | **47,3%** | 108 |
| 750 | 54,1% | 154 |
| 1.000 | 76,2% | 187 |
| 1.500 | 85,1% | 222 |
| **2.000 (teto do SQL)** | **89,1%** | 240 |
| 3.000 | 89,5% | 245 |
| 5.457 (todas) | 100% | 246 |

**R$ 1.679.655 — 52,7% do faturamento — vem de cidade que o seletor não oferece**, em 138 dos 279
CNPJs faturados. As maiores invisíveis: Carmo do Cajuru/MG **R$ 697.044** (21% de tudo, rank 917),
São Félix de Balsas/MA **R$ 334.116** (10%, rank **3.763**), Cláudio/MG R$ 181.306 (724), Mateus
Leme/MG R$ 145.572 (1.336), Itaguara/MG R$ 95.841 (1.642).

Para calibrar: a #1 absoluta em faturamento é **Balsas/MA (R$ 959.197)** e ela **está** no seletor,
no rank 391 — o corte não erra tudo, erra a cauda cara. Por UF o faturamento é **MG 56,9%
(R$ 1,88M) · MA 39,1% (R$ 1,29M) · SP 0,4% (R$ 13.373)**. Dois municípios do Maranhão respondem por
39% da receita e o seletor mostra **5 das 204 cidades do MA**.

A curva é o resultado que decide o desenho: **subir o limite não resolve**. No teto máximo que o
SQL aceita (`LEAST(p_limit, 2000)`) ainda faltam 10,9% do faturamento, e São Félix de Balsas
continua fora por 1.763 posições. A cauda não é ruído — é onde está o dinheiro.

**(c) O roteiro semanal declarado pela própria operação.** `route_schedule` — 24 cidades, todas
`ativo=true`, semeadas em 2026-05-30. É a empresa dizendo por escrito onde vai toda semana.
**19 das 24 estão fora do seletor.** Só Divinópolis (144), Pará de Minas (296), Itaúna (371),
Formiga (413) e São João del Rei (425) aparecem. Ficam de fora Nova Serrana (528), Bom Despacho
(637), Cláudio (724), Carmo do Cajuru (917), Pompéu (957), Pitangui (1.023), Oliveira (1.079),
Piumhi (1.098), Abaeté (1.333), Mateus Leme (1.336), Martinho Campos (1.531), Tiradentes (1.533),
Luz (1.609), Itaguara (1.642), Capitólio (1.954), Carmo da Mata (2.101), Pimenta (2.620), Prados
(556), Santa Cruz de Minas (1.311).

> A ferramenta de planejar visita em campo não consegue selecionar **79% das cidades que a empresa
> declarou visitar toda semana** — e a tabela que sabe disso mora no mesmo banco, já é lida pelo
> client (`useRouteContactList` faz `routeFrom('route_schedule')`), e o seletor não a consulta.

Por UF, a distorção fica explícita: **MG tem 59 das suas 848 cidades no seletor (7%)** — e MG é
5.326 dos 5.657 clientes (94% da carteira). SP: 121/642. MA: 5/204.

**Agravante de UI — a negativa falsa.** `CityMultiSelector` monta um `<Command>` do shadcn cujo
`<CommandInput placeholder="Buscar cidade…">` filtra **client-side a lista já carregada**. O
vendedor digita "Carmo do Cajuru" e lê **"Nenhuma cidade encontrada."** Não é um corte silencioso:
é a tela **afirmando** que a cidade não existe. Pior que ausência de sinal — é sinal errado.
(`filtrarCidadesPorUf` tem o mesmo escopo: escolher "MG" filtra dentro das 500, não busca no banco.)

## Eixo 2 — `radar_prospects_para_rota(p_limit: 1000)`: **não priorizar agora, mas registrar o viés**

O corte existe e é grande: **80** cidades têm >1.000 elegíveis, somando 195.996 prospects; entregues
80.000, **escondidos 115.996** (59%). Só que ele quase não toca a operação real: das 277 cidades da
carteira, apenas **47** passam de 1.000, e nelas há **275 clientes — 4,9%** da carteira. A **mediana
de prospects por cidade-da-carteira é 144**. O teto de 1.000 morde em capital, e é lá que a Colacor
quase não tem carteira. Denominador dado; sem ele o número 115.996 sozinho induziria à obra errada —
e o caso extremo fecha o argumento: **São Paulo tem 25.512 prospects (o maior corte de todos) e
R$ 13.373 de faturamento — 0,4%**. É a cidade onde o teto de 1.000 mais dói e a que menos importa.

Dois achados ficam registrados para quem for mexer:

- **O primeiro termo do `ORDER BY` é inerte.** `prospeccao_status` é monolítico: **523.180**
  `a_contatar` contra **2** `contatado_sem_resposta` e **1** `em_conversa` — e **zero** `descartado`.
  Logo `(prospeccao_status = 'a_contatar') DESC` não desempata nada, e o critério real é
  `data_abertura DESC` puro. A prospecção nunca rodou: a hipótese "esconde empresas antigas que
  nunca foram contatadas" é verdadeira para **toda** a base, porque nenhuma foi contatada.
- **O que sobra ordena pelo avesso do valor comercial.** Em São Paulo (7107): 25.512 elegíveis,
  1.000 entregues (**3,9%**), e o 1.000º abriu em **2026-02-19** — a tela mostra só CNPJ com **≤6
  meses de vida**, numa cidade com empresa aberta desde 1932. **10.165 empresas abertas antes de
  2020** não aparecem em nenhuma sessão, para nenhum vendedor, nunca. Para quem vende afiação e
  tinta a marcenaria, a marcenaria madura é o alvo melhor — e é exatamente a que o corte remove.
- **O aviso de truncamento é honesto; a saída que ele oferece não.** `FieldTargetsSummary` já mostra
  "Mostrando N de M prospects — refine por bairro/filtro" com M **verdadeiro** (soma de `c.total`
  das cidades), no espírito do `truncated` do feed de pedidos. Mas `bairrosDisponiveis =
  bairrosDe(fieldTargetsVivos)` deriva dos alvos **já carregados**: refinar por bairro filtra dentro
  dos 1.000 mais novos, não busca os outros 24.512. Se um bairro tem 800 prospects e só 12 estão
  entre os mais recentes, a tela mostra 12 e o vendedor conclui que o bairro está esgotado.

## Sinal de uso — zero, e isso calibra a resposta

`route_visits` = **0**. `visitas_agendadas` = 0. `route_contact_log` = 0. `route_queue_snapshot` = 0.
`dashboard_visits` = 0. Vivas: `route_schedule` (24, config) e `customer_visit_scores` (6.633,
derivado por job). O roteirizador está no ar e **nunca produziu uma visita registrada** — por isso o
cruzamento com "histórico de rota" que a investigação pediu é **inexequível**: não há histórico.

Não é silêncio novo: `fase-sem-sinal.md` já cataloga a rota do Farmer `/rota/ligacoes` (#1717) com
**estas mesmas 24 cidades** e `route_contact_log`/`route_queue_snapshot` zerados desde a origem. O
que este doc acrescenta é que a superfície **vizinha** — o planner de visitas — compartilha o mesmo
zero, e que desta vez existe um sinal externo (faturamento) que julga o desenho sem depender do uso.

Isso não enfraquece o achado — o dado de faturamento é independente do uso — mas define o tamanho da
obra. Corrigir o eixo do seletor é barato e precisa entrar **antes** do primeiro uso real, porque a
falha se manifesta como negativa falsa. Ordenação por proximidade, paginação sofisticada e scoring
geográfico são fase N+1 e **exigem sinal da fase N** (`fase-sem-sinal.md`).

## Veredito e correção

**Esconde.** O eixo 1 é o problema, e a correção não é paginar nem subir o limite.

1. **A lista do seletor deve ser uma UNIÃO, não um top-N:** top-N por prospects **∪** cidades ativas
   de `route_schedule` **∪** cidades onde a carteira tem cliente. As três fontes já estão no banco e
   `route_schedule` já é lido do client. Só (b) resolve as 19 cidades do roteiro oficial; (b)+(c)
   levam a cobertura de faturamento a 100% por construção, com ~277 linhas a mais.
2. **Trocar o rótulo e a ordenação.** O item hoje exibe `{cidade.total} prospects` — o eixo errado,
   apresentado como se fosse o critério de escolha. Cidade com carteira deve subir e dizer quantos
   **clientes** tem.
3. **Não subir `p_limit` como se fosse a correção.** 2.000 é o teto do SQL e ainda deixa 10,9% do
   faturamento fora; é a mudança que parece resolver e mascara o eixo errado por mais um ano.
4. **Eixo 2 fica como está**, com o viés acima anotado. Se um dia for mexido: remover o termo inerte
   e trocar `data_abertura DESC`, que hoje é um filtro de "CNPJ recém-aberto" disfarçado de prioridade.

## Para remedir (sem refazer o raciocínio)

Os SQLs desta medição são reprodutíveis com `psql-ro` a partir dos blocos acima; os três que
importam: (i) `row_number() OVER (ORDER BY count(*) DESC, municipio_codigo)` sobre `radar_empresas`
filtrada, para obter o rank de cada município; (ii) `venda_items_history` → `profiles.document` →
`addresses` → `radar_municipios`, agregando `valor_total` por faixa de rank; (iii) `route_schedule`
normalizada contra o mesmo rank. Se a resposta de (iii) deixar de ser "19 de 24", o desenho mudou —
confira antes de reabrir a discussão.
