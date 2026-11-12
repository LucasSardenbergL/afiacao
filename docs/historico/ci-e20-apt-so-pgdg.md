# `apt-get update` só do PGDG no step "PostgreSQL 17 (PGDG)" (E20, plano v9)

**Data:** 2026-11-11 · **Escopo:** `.github/workflows/ci.yml` (step do `provas-sql`), `scripts/lab-retry-pgdg/` · sem deploy.

## Incidente

Das 13:47 às 16:50 UTC de 2026-11-11 (runs **43032304371** a **43061738486**, 33 runs), o `azure.archive.ubuntu.com` ficou sem DNS. O `apt-get update` do step varria **todas** as fontes:

- esperava ~200 s por parte e saía **0** com `W: Failed to fetch … Temporary failure resolving`, e o `tentar` não via nada;
- a mediana do step foi de **11–12 s para 209–213 s**, nas 16 partes (≈ 53 runner-min a mais por run). Nenhum vermelho.

O mirror voltou sozinho às ~16:50 (43062331253 já em 14 s), mas a exposição a uma fonte que o job não usa continuava.

**Medido no log dos runs lentos:** o install só puxa `postgresql-client-17`, `postgresql-17` e `postgresql-17-pgvector`, todos do PGDG. As dependências do Ubuntu já vêm na imagem (ubuntu-24.04, 20261101.360.1). Os 33 runs lentos instalaram com o índice do Ubuntu **falhando**, e esse caminho já estava provado na prática.

## O que mudou

- O update lê só `pgdg.list` (`Dir::Etc::sourcelist`, `sourceparts=-`). Junto vão:
  - `--error-on=any`: aviso do PGDG vira falha e vai ao retry;
  - `APT::Get::List-Cleanup=0`: sem ele o apt **apaga** os índices das outras fontes;
  - `Acquire::Retries=0`: o retry é só do `tentar`, nada de dois laços aninhados.
- **Fallback delimitado:** se o install falhar com só o índice do PGDG (imagem nova que pede dependência do Ubuntu), o step atualiza as fontes do Ubuntu **uma vez**, com teto de 240 s e fail-closed, e reinstala sob o `tentar`.
- **Orçamento:** `timeout` em cada chamada de apt e `timeout-minutes: 8` no step, que é o teto que vale. Estourar reprova o job, que é obrigatório.

## Provas

| | step "PostgreSQL 17 (PGDG)", por parte |
|---|---|
| antes, mirror sem DNS (33 runs, 43035081419 → 43061738486) | mediana **209–213 s** |
| antes, mirror sadio (ex.: 43063627843) | mediana 12 s |
| **depois, mirror do Ubuntu SEM ROTA** (run 43072093459, `/etc/hosts` → 10.255.255.1) | **14/16 em 10–14 s**, sem fallback e só os 3 pacotes do PGDG |

As 2 partes restantes do experimento (105 s e 278 s, esta vermelha) foram o `curl` da **chave** em `www.postgresql.org`, com `(56)` após ~90 s por tentativa. É a camada que o E20 não toca: no mesmo minuto, o run 43072008725 (outro PR, com o step da main) teve o mesmo `(56)` e `OK na tentativa 2/3`. Foi falha do servidor, não do desenho. Se isso se repetir, é um item próprio, com denominador; não entra aqui.

**Lab** (`scripts/lab-retry-pgdg/`):
- os dublês separam o update do PGDG, o das fontes do Ubuntu e o install;
- C0 exige as fontes do Ubuntu **intocadas**; C9 exige `--error-on=any`, `sourceparts=-`, `List-Cleanup=0` e `timeout` em toda chamada; C10 exige que o fallback reprove com o exit do apt, sem multiplicar a espera;
- resultado: **41 ok**;
- falsificação (controle verde na mesma invocação, locales C e pt_BR): **22/22**, com as sabotagens S6–S10 do E20 entre elas.

O lab prova o **fluxo**, não a resolução de dependência. Quem prova a resolução é a instalação real das 16 partes.
