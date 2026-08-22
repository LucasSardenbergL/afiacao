set -u
cd "$(git rev-parse --show-toplevel)"
L=.claude/tmp-sessao
run() { echo "### $1"; shift; "$@" > "$L/g-$1.log" 2>&1; echo "EXIT_$1=$?"; }
echo "--- inicio ---"
bunx tsc --noEmit -p tsconfig.app.json > $L/g-typecheck.log 2>&1; echo "EXIT_typecheck=$?"
bun run test:edges                     > $L/g-edges.log    2>&1; echo "EXIT_edges=$?"
bun run edges:typecheck                > $L/g-edgetc.log   2>&1; echo "EXIT_edgetc=$?"
bunx eslint .                          > $L/g-lint.log     2>&1; echo "EXIT_lint=$?"
bunx knip                              > $L/g-knip.log     2>&1; echo "EXIT_knip=$?"
bunx vitest run                        > $L/g-test.log     2>&1; echo "EXIT_test=$?"
echo "--- fim ---"
