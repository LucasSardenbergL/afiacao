package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
)

// Testes contra um PostgreSQL 17 REAL: rodam via `bash connector/sayersync/test-pg17.sh`, que sobe
// o banco e exige a marca de PASS de cada um. Sem SAYERSYNC_PG17_URL o teste PULA — e o script
// trata o pulo como falha (ausência de dado ≠ aprovação).

func pg17(t *testing.T) string {
	t.Helper()
	url := os.Getenv("SAYERSYNC_PG17_URL")
	if url == "" {
		t.Skip("SAYERSYNC_PG17_URL ausente — rode via test-pg17.sh")
	}
	return url
}

func TestPG17_ValidateDescobreVendasItem(t *testing.T) {
	ctx := context.Background()
	db, err := Connect(ctx, pg17(t))
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer db.Close()

	var slots []string
	for i := 1; i <= 6; i++ {
		slots = append(slots, fmt.Sprintf("corante%d integer, qtd%d numeric", i, i))
	}
	ddl := "CREATE TABLE public.vendas_item (id bigint PRIMARY KEY, data_dosagem timestamptz, " +
		strings.Join(slots, ", ") + ")"
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS public.vendas_item; "+ddl); err != nil {
		t.Fatalf("DDL: %v", err)
	}

	rm, diff, err := Validate(ctx, db)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	est := rm.Isoladas["vendas_item"]
	if !est.OK || est.Colunas["qtd6ml"] != "qtd6" || est.Colunas["data_dosagem"] != "data_dosagem" {
		t.Fatalf("com a tabela, vendas_item deveria resolver pelo information_schema real: %+v", est)
	}
	if _, ok := diff.Missing["vendas_item"]; ok {
		t.Fatal("entidade isolada não entra em diff.Missing")
	}

	if _, err := db.ExecContext(ctx, "DROP TABLE public.vendas_item"); err != nil {
		t.Fatalf("DROP: %v", err)
	}
	rm2, diff2, err := Validate(ctx, db)
	if err != nil {
		t.Fatalf("Validate sem a tabela: %v", err)
	}
	if est2 := rm2.Isoladas["vendas_item"]; est2.OK || est2.Tabela != "" {
		t.Fatalf("sem a tabela, vendas_item fica desligada: %+v", est2)
	}
	if _, ok := diff2.Missing["vendas_item"]; ok {
		t.Fatal("sem a tabela, vendas_item continua fora de diff.Missing")
	}
}
