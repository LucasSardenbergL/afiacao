#!/usr/bin/env bash
# classify.sh — FONTE ÚNICA da classificação do Passo 1 da skill lovable-deploy-verify.
# Lê nomes de arquivo (1 por linha) do stdin e diz quais das 3 camadas de deploy
# Lovable (frontend/edge/migration) o conjunto toca. O Passo 1 do SKILL.md usa este
# script; o evals/run.sh testa este script. Uma fonte = sem divergência.
#
# Uso:  git diff --name-only origin/main...HEAD | ./classify.sh
# Saída (3 linhas):  frontend=SIM|não / edge=SIM|não / migration=SIM|não
set -euo pipefail
awk '
  # FRONTEND = precisa de Publish. Não é só src/: qualquer arquivo que altere o
  # bundle servido conta (senão dá falso-negativo "não precisa Publish" quando
  # precisa — ex.: mexer no vite.config ou subir uma dependência).
  /^src\//                  { fe=1 }
  /^index\.html$/           { fe=1 }
  /^vite\.config\./         { fe=1 }
  /^tailwind\.config\./     { fe=1 }
  /^postcss\.config\./      { fe=1 }
  /^components\.json$/      { fe=1 }
  /^package\.json$/         { fe=1 }
  /^bun\.lockb$/            { fe=1 }
  # EDGE = deploy via chat do Lovable (verbatim, só após merge)
  /^supabase\/functions\//  { ef=1 }
  # MIGRATION = SQL Editor (domínio da skill lovable-db-operator)
  /^supabase\/migrations\// { mg=1 }
  END {
    printf "frontend=%s\n",  (fe?"SIM":"não")
    printf "edge=%s\n",      (ef?"SIM":"não")
    printf "migration=%s\n", (mg?"SIM":"não")
  }'
