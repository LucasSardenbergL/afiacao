# Radar: dá para saber se um CNPJ novo sucede um cliente nosso? (viabilidade, medida em 2026-11-04)

> Entrega **só de leitura**: nenhuma migration, edge ou código de produto. Fonte: `psql-ro` (prod
> `fzvklzpomgnyikkfkzai`), todas as consultas com `ON_ERROR_STOP=1` e `exit 0`. Os pares candidatos e a
> amostra conferida à mão ficaram **fora do repo** (scratchpad da sessão), porque têm nome de pessoa
> física e CPF de MEI embutido na razão social. Aqui ficam só contagens e descrições anonimizadas.

## Pergunta do founder

"É possível perceber se uma pessoa fechou uma empresa e abriu outra com outro nome no mesmo endereço,
num endereço parecido, com o mesmo sócio, com o cônjuge ou com um filho? Queria saber se aquele CNPJ novo
é mesmo um cliente novo."

## Resposta curta

**Sim, em parte, e com volume pequeno.** Das ~507 mil empresas ativas do Radar que não são clientes,
**166** têm um vínculo com um cliente nosso que vale mostrar. **66** delas parecem suceder um cliente que
a Receita já registra como baixado ou inapto. Desse total, **73 são FORTES** (precisão de ~80 a 90% na
amostra) e **93 são MÉDIAS** (~80%). Parentesco (cônjuge, filho) **não se detecta como fato**: a Receita
não informa, e o sobrenome sozinho gera falso positivo. O que aparece são casos em que o parente usa o
mesmo endereço ou o mesmo telefone. Isso se mostra como "mesmo endereço", nunca como "parente".

**Recomendação: não construir o selo agora.** A regra "fase N+1 exige sinal da fase N" barra a
construção: no Radar houve **0 contatos humanos em 60 dias** (os 64.299 registros de outubro são descartes
em lote do recorte de CNAE, de 21/10 e 28/10, feitos por 1 autor). O desenho abaixo fica pronto para
quando o piloto der sinal.

## 1. O que a ingestão já carrega (`scripts/radar/carga.ts` → edge `radar-ingest` → `radar_empresas`)

| Dado | Tem? | Observação |
|---|---|---|
| Endereço completo (logradouro, número, complemento, bairro, CEP, município) | ✅ | 569.894 de 570.000 leads com CEP e número |
| Telefone 1 e 2 | ✅ | 553 mil leads. A RFB guarda 8 dígitos e corta o 9 do celular, então a chave de comparação é DDD + últimos 8 dígitos |
| E-mail | ✅ | 511 mil leads. É muito contaminado por e-mail de **contador** (ver §3) |
| Sócios (QSA) | ⚠️ só o **nome** | `socios_nomes` = `string_agg(nome,'; ')`. A carga **descarta** o CPF mascarado (`doc`), a qualificação e a data de entrada. Só 23% dos leads têm sócio, porque o resto é EI/MEI sem QSA |
| Titular de MEI/EI | ✅ (implícito) | 122 mil razões sociais trazem o nome do titular com o CPF completo no fim (`NOME 12345678901`) ou o prefixo da raiz (`12.345.678 NOME`). Esse é o "sócio" de 77% da base |
| Baixadas e inaptas | ⚠️ parcial | O universo prospectável é só `situacao='02'` dentro do recorte de CNAE. Para os **conhecidos** (radar ∪ clientes), a carga grava só a situação (`radar_situacao_cadastral`, 2 lotes, 1,14 mi linhas), sem endereço nem telefone. Quem já estava no Radar e fechou **mantém** a última foto (307 clientes `ja_cliente` com situação ≠ ativa) |

## 2. O lado de comparação (nossos clientes)

- O `ja_cliente` de hoje é **casamento exato de CNPJ** (`radar_recruzar_ja_cliente`): `profiles.document`
  ∪ `omie_clientes_nao_vinculados.cnpj_cpf`, normalizados. Uma raiz diferente nunca casa.
- **3.021** clientes estão dentro do Radar. Deles temos tudo o que a RFB traz: endereço, telefones,
  e-mail, sócios e titular de MEI.
- **15.226** `profiles` têm CNPJ, e 15.009 deles têm telefone. O endereço vem de `addresses` (rua, número,
  complemento, CEP). **Sócio não temos** para quem está fora do recorte.
- `omie_clientes_nao_vinculados` está **vazio** hoje (0 linhas). Os aliases fiscais `@placeholder.local`
  não entram como fonte de sócio nem de endereço.
- Para saber se o cliente sucedido está ativo comercialmente ou inadimplente, a ligação é
  `fin_contas_receber` → `omie_customer_account_map` → `profiles`, porque o `cnpj_cpf` dos títulos vem
  vazio em 100% das 45.696 linhas. Por esse caminho, só **957** clientes com CNPJ têm títulos, e
  `venda_items_history` cobre só a OBEN e só 1 ano. Por isso a parte comercial da medição é grosseira.

## 3. Método e números (prod, 2026-11-04)

Lead = linha de `radar_empresas` com `NOT ja_cliente`, situação ativa e **raiz diferente** da de qualquer
cliente (filial de cliente já é tratada por `radar_irmaos_por_raiz`). Para cada sinal, a chave só conta se
for **exclusiva**, isto é, aparecer em no máximo 2 raízes (o cliente e o lead). Chave repetida em 3 ou
mais raízes é escritório de contabilidade, condomínio ou galeria.

| Sinal (chave exclusiva, ≤2 raízes) | Leads | O que a amostra mostrou |
|---|---:|---|
| Telefone (DDD + 8 últimos) | 253 | Sozinho, acerta ~1 em 3. Quase todo erro é telefone de **contador** cadastrado na RFB para os 2 clientes |
| E-mail (sem domínio de contabilidade) | 279 | Sozinho, é incerto: webmail compartilhado e domínios de consultoria |
| CEP + número | 475 | Ruim **sem** logradouro: o CEP é da cidade inteira (`xxxxx000`) e o número cai em outra rua, ou o prédio é o mesmo e o apartamento é outro |
| CEP + número + **mesmo logradouro e complemento** | 93 | ~5 em 6 certos (mesmo ponto comercial, MEI novo no endereço do antigo) |
| Mesmo nome de pessoa (≥3 palavras, sócio ou titular de MEI) | 152 | Só vale no **mesmo município**: em municípios diferentes, a amostra trouxe homônimos (até de outro estado). No mesmo município, são 32 pares |

Faixas finais. O e-mail e o telefone saem quando o e-mail de qualquer lado tem domínio
`cont|assessor|escritorio|fiscal|mei|partner`:

| Faixa | Regra | Leads | Sucede cliente baixado/inapto |
|---|---|---:|---:|
| **FORTE** | mesma pessoa no mesmo município, **ou** ≥2 sinais independentes exclusivos no MESMO cliente | **73** | 30 |
| **MÉDIA** | endereço completo exclusivo (CEP + número + logradouro + complemento) sozinho | **93** | 36 |
| oculta | telefone sozinho, e-mail sozinho, CEP + número sem logradouro, sobrenome | 400 | — |

**Amostra à mão** (2 rodadas, 42 pares): na FORTE, antes do filtro de contador, 7 de 10 eram vínculo
plausível. Os 2 falsos tinham e-mail e telefone de contabilidade e caem com o filtro. Exemplos típicos
de acerto: um MEI baixado e um MEI novo da mesma pessoa no mesmo endereço; um MEI que virou LTDA com o
titular como sócio; uma indústria cliente e uma empresa nova com o mesmo sócio e a mesma marca. Na MÉDIA,
5 de 6 eram plausíveis (ex.: MEI novo de 2026 no endereço de um MEI inapto, com sobrenome em comum; dois
irmãos no mesmo endereço). O falso era o endereço do escritório contábil usado pelos 2.

**Crédito (money-path):** só **1** lead MÉDIO casa com cliente que tem título em atraso. Com a cobertura
atual de `fin_contas_receber` (2,3 mil clientes), o "sucessor de inadimplente" **não tem volume** para
justificar tocar o crédito agora. Se um dia tiver, entra como pista no fluxo de cadastro e venda, com o
ritual Codex. Não fica num selo do Radar.

## 4. Entrega na ficha (2026-11-04, decisão do founder de construir mesmo sem sinal do piloto)

Depois do parecer, o founder escolheu **construir na ficha**. Ficou assim:

- **Migration `20261104201756_radar_possiveis_vinculos.sql`:** 4 índices em `radar_empresas` (e-mail
  normalizado, CEP, GIN do array de sócios, titular de MEI). Sem eles, a varredura sequencial custa
  **5,6 s** por ficha. As expressões usam só funções nativas, porque índice com função própria exigiria
  EXECUTE de quem grava (a carga). Também traz 2 helpers `private` fechados (`radar_tel_chave` e
  `radar_chave_endereco`) e a RPC `radar_possiveis_vinculos(p_cnpj)` com as regras da §3. Gate
  `cap_radar_prospectar`; cliente só-profiles só com `cap_carteira_ler`; o nome sai **sem** o CPF do MEI.
- **Prova `db/test-radar-possiveis-vinculos.sh`:** 19 asserts e 12 sabotagens, todas vermelhas no seu
  assert. Uma sabotagem (índice com a expressão errada) passou verde na 1ª versão: com
  `enable_seqscan=off`, o planner varre o índice errado inteiro. Por isso os asserts de índice exigem
  `Index Cond`.
- **Ficha:** linha "Já é cliente?" (`RadarVinculosLead`), com "pista forte" ou "pista média", o título
  "Possível sucessor de X (baixada na Receita)" ou "Possível vínculo com X", e a evidência mais "Confira com
  o cliente". Erro ou forma inesperada da RPC não viram "nenhum vínculo".
- **Sensor:** ~~nenhum evento novo. Abrir a ficha já grava `radar_eventos.evento='abriu'` com o CNPJ~~
  **errado** (medido em 2026-11-06: 4 `abriu` humanos em 30 dias, 0 com `cnpj`). Até a migration
  `20261106132259` o `abriu` era só a TELA `/radar` servida, sem CNPJ; desde ela a ficha também grava
  `abriu`, com o CNPJ (ver [radar-abriu-ficha-com-cnpj-2026-11-06.md](radar-abriu-ficha-com-cnpj-2026-11-06.md)).
  O vínculo é determinístico, então "fichas abertas com vínculo" é a query abaixo.
- **Ensaio em prod (`db:aplicar --ensaio`):** rodou inteiro, a postcondição passou com os dados reais e
  fez ROLLBACK.

### Desenho original (mantido como referência)

- **Onde:** só na **ficha** (`RadarDetailSheet`), via RPC sob demanda `radar_possiveis_vinculos(p_cnpj)`,
  no mesmo molde de `radar_telefone_compartilhado`: `cap_radar_prospectar`, `SECURITY DEFINER`, REVOKE
  `PUBLIC` e `anon`. Não precisa de edge, de mudança na carga nem de coluna nova. A lista fica para
  depois, porque exigiria pré-computar uma coluna mais 1 writer (mais um job).
- **Texto:** "Possível vínculo com cliente X" (ou "possível sucessor", se X está baixado ou inapto na
  RFB), com a **evidência** que casou ("mesmo telefone", "mesmo endereço completo", "mesmo titular no
  mesmo município"). **Nunca** mostrar CPF, **nunca** dizer "parente", nunca persistir o vínculo como
  fato. É calculado na leitura e some quando o dado muda.
- **Sensor junto:** evento `radar.vinculo_visto` no ledger `radar_eventos` mais a ação do vendedor
  (descartou como "já é cliente" ou seguiu).
- **Se um dia quiser recall maior:** guardar na carga o CPF mascarado e a qualificação do QSA (hoje
  descartados em `carga.ts`). Isso só depois de a ficha provar uso.

## Quando medir de novo ("quando" é query)

```sql
-- A ficha com vínculo é aberta? Denominador: FICHAS abertas por humano (`abriu` COM cnpj; cnpj NULL é a tela).
-- 1 linha por titular, CNPJ e dia. Só conta a partir do apply da 20261106132259 (antes, nenhuma ficha gravava).
select count(*) fichas, count(distinct cnpj) leads, count(distinct user_id) titulares,
       min(ocorrido_em)::date, max(ocorrido_em)::date
  from radar_eventos
 where evento = 'abriu' and origem = 'humano' and cnpj is not null and ocorrido_em > now() - interval '30 days';
```

```sql
-- Numerador: quais dessas fichas têm selo de vínculo. O núcleo é private e o claude_ro não o executa: rode pelo
-- conector do Lovable (mcp__lovable__query_database). p_carteira=true = o que um gestor veria (nome do cliente).
with abertas as (
  select distinct cnpj from radar_eventos
   where evento = 'abriu' and origem = 'humano' and cnpj is not null and ocorrido_em > now() - interval '30 days')
select (select count(*) from abertas) fichas_abertas,
       count(distinct n.lead_cnpj) com_vinculo,
       count(distinct n.lead_cnpj) filter (where n.forca = 'forte') com_vinculo_forte
  from private.radar_vinculos_nucleo((select array_agg(cnpj) from abertas), true) n;
```


```sql
-- O piloto deu sinal? (≥1 contato HUMANO, fora descarte em lote, nos últimos 30 dias, com denominador)
select count(*) filter (where acao <> 'descartado') humanos,
       count(distinct criado_por) filter (where acao <> 'descartado') autores,
       count(*) total
  from radar_contatos where created_at > now() - interval '30 days';
```

Com `humanos > 0` e pelo menos 1 vendedor entre os `autores`, a ficha com o vínculo vira a fase N+1
legítima.
