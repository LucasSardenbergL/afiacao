# CSV de base pública BR (RAIS/CNO/Receita/CNPJ) — receituário DuckDB

> Ingestão de CSV de governo brasileiro é um campo minado repetível. Esta nota
> existe pra a próxima base (RAIS, CNO, Cadastro CNPJ da Receita, RAIS-migra,
> CAGED…) **não redescobrir** o que a sessão de 2026-07 levou 6 iterações de
> script DuckDB pra acertar. Vale pra qualquer ingestão ad-hoc dessas bases.

## As 3 que morderam (confirmadas na prática)

1. **Encoding é CP1252 / Latin-1, NUNCA UTF-8.** Acento vira lixo (`mojibake`)
   se você ler como UTF-8. No DuckDB: `encoding='latin-1'`. Se ainda sobrar
   lixo (aspas curvas, travessão, `0x80–0x9F` que o Latin-1 puro não cobre),
   **pré-converta**: `iconv -f WINDOWS-1252 -t UTF-8//TRANSLIT in.csv > out.csv`.
2. **Aspas quebram o parser.** Essas bases costumam **não** usar aspas de forma
   consistente (campo com `"` solto, aspas embutidas sem escape). Ligar o
   quoting padrão faz o parser "engolir" linhas. Desligue: `quote=''`. Só ligue
   `quote='"'` + `escape='"'` se você CONFIRMOU que o arquivo usa aspas direito.
3. **`parallel=false`.** O parser paralelo do DuckDB assume linhas bem-formadas;
   nessas bases há linha com nº de colunas inconsistente e ele quebra de formas
   confusas (erro numa coluna que "não existe"). O parser serial tolera —
   pague a lentidão, ganhe o load.

## As clássicas do domínio (também valem)

4. **Separador é `;`** (ponto-e-vírgula), não vírgula. `delim=';'`. Decimal vem
   com vírgula (`1.234,56`) e data como `DD/MM/AAAA` — trate DEPOIS, à mão.
5. **`all_varchar=true` na carga.** Não deixe o DuckDB inferir tipo: ele
   transforma código com zero à esquerda em número (perde o zero), erra data BR
   e decimal-vírgula. Carregue tudo como texto e **tipe explicitamente** num
   segundo passo.
6. **`ignore_errors=true`** pra uma linha ruim não abortar o load inteiro; se
   precisar auditar o que caiu, `store_rejects=true` (inspecione
   `reject_errors`/`reject_scans`).
7. **Header com acento / nomes sujos** — às vezes vale `header=false` + nomes de
   coluna manuais, especialmente quando o layout vem de um dicionário à parte.

## Receita mínima que funciona

```sql
CREATE TABLE base AS
SELECT * FROM read_csv(
  'ARQUIVO_*.txt',
  delim=';',
  header=true,
  encoding='latin-1',   -- CP1252; se sobrar mojibake, iconv antes
  quote='',             -- desliga quoting (bases BR não usam aspas direito)
  all_varchar=true,     -- tipar DEPOIS, à mão
  parallel=false,       -- parser serial tolera linha malformada
  ignore_errors=true
);
```

Depois disso, `SELECT`/`CAST` explícito para tipar (decimal-vírgula →
`replace(col,',','.')::DOUBLE`, data → `strptime(col,'%d/%m/%Y')`).

> Proveniência: destilado da sessão de 2026-07 (6 versões de script até fechar
> CP1252 + aspas + `parallel=false`); os itens 4–7 são o padrão conhecido dessas
> bases. Ajuste conforme a base real e registre aqui o que divergir.
