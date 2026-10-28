package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

// Giro de corante, Task 10: vendas_item é ISOLADA — schema dela ausente/incompleto, ou o relógio
// da origem indisponível, desliga SÓ a entidade; o catálogo (preço do balcão) segue. Os testes
// passam pela resolução REAL (resolveMapping) — só a consulta ao information_schema é contornada.

func schemaComVendasItem() map[string]map[string]bool {
	s := realSchemaFixture()
	vi := map[string]bool{"id": true, "data_dosagem": true}
	for i := 1; i <= 6; i++ {
		vi[fmt.Sprintf("corante%d", i)] = true
		vi[fmt.Sprintf("qtd%d", i)] = true
	}
	s["vendas_item"] = vi
	return s
}

func TestResolveMapping_VendasItemCompletaFicaOK(t *testing.T) {
	rm, diff := resolveMapping(schemaComVendasItem())
	if !diff.OK {
		t.Fatalf("catálogo deveria passar: missing=%v", diff.Missing)
	}
	est := rm.Isoladas["vendas_item"]
	if !est.OK || est.Tabela != "vendas_item" || est.Colunas["qtd3ml"] != "qtd3" || est.Colunas["data_dosagem"] != "data_dosagem" {
		t.Fatalf("vendas_item completa deveria resolver: %+v", est)
	}
	if _, ok := rm.Resolved["vendas_item"]; ok {
		t.Fatal("entidade isolada não entra no Resolved do catálogo (nem no fingerprint)")
	}
}

func TestResolveMapping_VendasItemAusenteNaoDerrubaCatalogo(t *testing.T) {
	casos := map[string]func(map[string]map[string]bool){
		"sem a tabela": func(s map[string]map[string]bool) { delete(s, "vendas_item") },
		"sem os slots qtd": func(s map[string]map[string]bool) {
			for i := 1; i <= 6; i++ {
				delete(s["vendas_item"], fmt.Sprintf("qtd%d", i))
			}
		},
		"sem a data":            func(s map[string]map[string]bool) { delete(s["vendas_item"], "data_dosagem") },
		"um slot de corante só": func(s map[string]map[string]bool) { delete(s["vendas_item"], "corante6") },
	}
	for nome, estraga := range casos {
		t.Run(nome, func(t *testing.T) {
			s := schemaComVendasItem()
			estraga(s)
			rm, diff := resolveMapping(s)
			if !diff.OK {
				t.Fatalf("%s: o catálogo NÃO pode cair; missing=%v", nome, diff.Missing)
			}
			if _, ok := diff.Missing["vendas_item"]; ok {
				t.Fatalf("%s: vendas_item não entra em diff.Missing", nome)
			}
			if est := rm.Isoladas["vendas_item"]; est.OK || len(est.Faltando) == 0 {
				t.Fatalf("%s: vendas_item deveria ficar desligada com o que falta listado: %+v", nome, est)
			}
		})
	}
}

// ─── RunCycle pelas seams ───

type cicloFalso struct {
	srv *captureServer
	cfg *Config
	ex  *fakeExtractor
}

// prepararCiclo troca só conexão, information_schema e extrator; o resto do RunCycle é real.
func prepararCiclo(t *testing.T, schema map[string]map[string]bool) *cicloFalso {
	t.Helper()
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)

	ex := newFakeExtractor()
	ex.rows["produto"] = []map[string]any{{"id_produto": "P1", "descricao": "Tinta"}}
	ex.maxDA["produto"] = time.Now()

	antes := [3]any{conectar, validar, novoExtractor}
	conectar = func(context.Context, string) (*sql.DB, error) {
		// sql.Open é preguiçoso: nada conecta, e o Close do defer funciona.
		return sql.Open("pgx", "postgres://ninguem@127.0.0.1:1/nada")
	}
	validar = func(context.Context, *sql.DB) (*ResolvedMapping, *SchemaDiff, error) {
		rm, diff := resolveMapping(schema)
		return rm, diff, nil
	}
	novoExtractor = func(*sql.DB, *ResolvedMapping) Extractor { return ex }
	t.Cleanup(func() {
		conectar = antes[0].(func(context.Context, string) (*sql.DB, error))
		validar = antes[1].(func(context.Context, *sql.DB) (*ResolvedMapping, *SchemaDiff, error))
		novoExtractor = antes[2].(func(*sql.DB, *ResolvedMapping) Extractor)
	})
	// State/hash-cache vão para o diretório do binário de teste (temporário do go test).
	return &cicloFalso{srv: srv, ex: ex, cfg: &Config{AppURL: ts.URL, StoreCode: "M01", TokenPlainDev: "tok"}}
}

func (c *cicloFalso) errosDoHeartbeat(t *testing.T) []string {
	t.Helper()
	var ultimo map[string]any
	for _, r := range c.srv.requests {
		if r.Path == "/heartbeat" {
			ultimo = r.Body
		}
	}
	if ultimo == nil {
		t.Fatal("nenhum heartbeat capturado")
	}
	b, _ := json.Marshal(ultimo["last_cycle_errors"])
	var erros []string
	_ = json.Unmarshal(b, &erros)
	return erros
}

func TestRunCycle_VendasItemQuebradoCatalogoSegue(t *testing.T) {
	s := schemaComVendasItem()
	delete(s, "vendas_item")
	c := prepararCiclo(t, s)

	RunCycle(context.Background(), c.cfg)

	if c.srv.countPathPrefix("/catalogs") == 0 {
		t.Fatal("o catálogo tem de seguir com vendas_item quebrada")
	}
	if erros := c.errosDoHeartbeat(t); !slices.Contains(erros, "vendas_item") {
		t.Fatalf("vendas_item quebrada tem de aparecer no heartbeat, veio %v", erros)
	}
	if c.srv.countPathPrefix("/preparations") != 0 {
		t.Fatal("vendas_item quebrada não pode chamar /preparations*")
	}
}

func TestRunCycle_VendasItemOkSemFalhaIsolada(t *testing.T) {
	c := prepararCiclo(t, schemaComVendasItem())
	RunCycle(context.Background(), c.cfg)
	if erros := c.errosDoHeartbeat(t); slices.Contains(erros, "vendas_item") {
		t.Fatalf("com schema e relógio OK, vendas_item não falha: %v", erros)
	}
}

func TestRunCycle_SemOriginNowPreparacoesNaoRodam(t *testing.T) {
	c := prepararCiclo(t, schemaComVendasItem())
	c.ex.originNowErr = errors.New("origem fora")

	RunCycle(context.Background(), c.cfg)

	if c.srv.countPathPrefix("/preparations") != 0 {
		t.Fatal("sem o relógio da origem, nenhum POST a /preparations*")
	}
	if erros := c.errosDoHeartbeat(t); !slices.Contains(erros, "vendas_item") {
		t.Fatalf("sem relógio da origem, vendas_item falha no ciclo: %v", erros)
	}
	if c.srv.countPathPrefix("/catalogs") == 0 {
		t.Fatal("o catálogo segue com time.Now() (comportamento atual)")
	}
}
