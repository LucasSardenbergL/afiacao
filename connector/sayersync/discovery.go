// discovery.go — despeja o schema completo do SayerSystem em um arquivo texto
// legível (sayersystem-schema.txt) para diagnóstico de schema_mismatch.
//
// O arquivo é enviado para o developer quando o conector detecta divergência
// de schema, permitindo ajuste do mapeamento sem acesso à máquina do cliente.
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"time"
)

// discoveryCol descreve uma coluna retornada pelo information_schema.
type discoveryCol struct {
	name     string
	dataType string
	nullable string
	ordinal  int
}

// RunDiscovery consulta information_schema.columns e information_schema.tables,
// grava o resultado em outPath (UTF-8, legível) e retorna o fingerprint SHA-256
// do schema normalizado.
//
// O arquivo é estruturado como:
//
//	=== SCHEMA DO SAYERSYSTEM ===
//	Gerado: 2026-06-10T12:00:00Z
//	Fingerprint: abc123...
//
//	TABLE: produto
//	  id_produto       integer   NOT NULL
//	  descricao        varchar   NOT NULL
//	  data_atualizacao timestamp NULL
//	...
func RunDiscovery(ctx context.Context, db *sql.DB, outPath string) (string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT
			lower(c.table_name)    AS table_name,
			lower(c.column_name)   AS column_name,
			c.data_type            AS data_type,
			c.is_nullable          AS is_nullable,
			c.ordinal_position     AS ordinal_position
		FROM information_schema.columns c
		JOIN information_schema.tables t
			ON t.table_name = c.table_name
			AND t.table_schema = c.table_schema
		WHERE c.table_schema = 'public'
			AND t.table_type = 'BASE TABLE'
		ORDER BY c.table_name, c.ordinal_position
	`)
	if err != nil {
		return "", fmt.Errorf("discovery: erro ao consultar information_schema: %w", err)
	}
	defer rows.Close()

	// Agrupa por tabela preservando a ordem de inserção.
	tableOrder := []string{}
	tableMap := make(map[string][]discoveryCol)

	for rows.Next() {
		var tbl, colName, dataType, nullable string
		var ordinal int
		if err := rows.Scan(&tbl, &colName, &dataType, &nullable, &ordinal); err != nil {
			return "", fmt.Errorf("discovery: erro ao ler linha: %w", err)
		}
		if _, seen := tableMap[tbl]; !seen {
			tableOrder = append(tableOrder, tbl)
		}
		tableMap[tbl] = append(tableMap[tbl], discoveryCol{colName, dataType, nullable, ordinal})
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("discovery: erro ao iterar colunas: %w", err)
	}

	// Gera o fingerprint a partir do conteúdo normalizado.
	fp := fingerprintDiscovery(tableOrder, tableMap)

	// Monta o arquivo de saída.
	var sb strings.Builder
	sb.WriteString("=== SCHEMA DO SAYERSYSTEM ===\n")
	sb.WriteString(fmt.Sprintf("Gerado: %s\n", time.Now().UTC().Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("Fingerprint: %s\n", fp))
	sb.WriteString(fmt.Sprintf("Total de tabelas: %d\n", len(tableOrder)))
	sb.WriteString("\n")

	for _, tbl := range tableOrder {
		sb.WriteString(fmt.Sprintf("TABLE: %s\n", tbl))
		for _, ci := range tableMap[tbl] {
			nullStr := "NULL"
			if strings.EqualFold(ci.nullable, "NO") {
				nullStr = "NOT NULL"
			}
			sb.WriteString(fmt.Sprintf("  %-30s %-20s %s\n", ci.name, ci.dataType, nullStr))
		}
		sb.WriteString("\n")
	}

	if err := os.WriteFile(outPath, []byte(sb.String()), 0644); err != nil {
		return "", fmt.Errorf("discovery: erro ao gravar %s: %w", outPath, err)
	}

	return fp, nil
}

// fingerprintDiscovery computa o SHA-256 do schema normalizado (table+col+type, ordenado).
// Idêntico para o mesmo schema independente da ordem em que as colunas foram retornadas.
func fingerprintDiscovery(tableOrder []string, tableMap map[string][]discoveryCol) string {
	var sb strings.Builder
	for _, tbl := range tableOrder {
		sb.WriteString(tbl)
		sb.WriteByte('|')
		for _, ci := range tableMap[tbl] {
			sb.WriteString(ci.name)
			sb.WriteByte(':')
			sb.WriteString(strings.ToLower(ci.dataType))
			sb.WriteByte(';')
		}
		sb.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return fmt.Sprintf("%x", sum)
}
