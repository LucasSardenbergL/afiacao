// sync.go — ciclo de sincronização SayerSystem → tint-sync-agent.
//
// RunCycle executa um único ciclo completo:
//  1. Conecta ao PostgreSQL local
//  2. Valida o schema (fail-closed se divergir)
//  3. Para cada entidade, extrai o delta desde o HWM - 5min e envia em lotes ≤1000
//  4. Diariamente: envia um keys-snapshot de todas as fórmulas
//  5. Todo domingo de madrugada: full re-scan (ignora HWM)
//  6. Envia heartbeat ao final
//
// RunLoop chama RunCycle em loop com intervalo configurável (para o serviço).
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5 + §6.1
package main

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// hwmMargin é a margem subtraída do HWM antes da query de delta.
// Garante que registros gravados próximos ao HWM anterior não sejam perdidos
// por variações de clock entre o conector e o PG de origem (§11 P1-D).
const hwmMargin = 5 * time.Minute

// batchSize é o tamanho máximo de registros por POST ao servidor.
const batchSize = 1000

// ──────────────────────────────────────────────────────────────
// Extractor — interface para injeção de dependência em testes
// ──────────────────────────────────────────────────────────────

// Extractor abstrai o acesso ao PostgreSQL local para permitir testes sem banco real.
type Extractor interface {
	// Extract retorna as linhas da entidade com data_atualizacao > hwm.
	// maxDA é o MAX(data_atualizacao) observado no resultado (relógio da ORIGEM).
	Extract(ctx context.Context, entity string, hwm time.Time) (rows []map[string]any, maxDA time.Time, err error)

	// ExtractAllFormulasForSnapshot retorna os campos necessários para o keys-snapshot
	// de TODAS as fórmulas (formula + formulaperson), sem filtro de HWM.
	// Os valores são IDs CRUS da origem — sendKeysSnapshot traduz via Lookups.
	ExtractAllFormulasForSnapshot(ctx context.Context) (formulas []formulaKey, err error)

	// LoadLookups carrega os lookups de identidade canônica (1× por ciclo).
	// Ver doc do tipo Lookups.
	LoadLookups(ctx context.Context) (*Lookups, error)

	// ExtractFormulaChildItems retorna os itens da tabela filha formula_item,
	// agregados por id_formula (= PK da fórmula no pai). hasOrdem indica se a
	// coluna "ordem" existe na origem. Só usado no shape child.
	ExtractFormulaChildItems(ctx context.Context, hasOrdem bool) (map[string][]map[string]any, error)

	// OriginNow retorna o now() do PostgreSQL de origem (para comparações de data).
	OriginNow(ctx context.Context) (time.Time, error)
}

// formulaKey é a chave de uma fórmula para o keys-snapshot.
// IDEmb é extraído da origem mas NÃO entra na chave do snapshot (F3): a identidade
// da fórmula fonte é (cor_id, cod_produto, id_base, personalizada) sem embalagem —
// o servidor expande para N embalagens vendáveis. Mantido só para diagnóstico.
type formulaKey struct {
	CorID         string
	CodProduto    string
	IDBase        string
	IDEmb         string
	Personalizada bool
}

// ──────────────────────────────────────────────────────────────
// Lookups — identidade canônica enviada ao app
// ──────────────────────────────────────────────────────────────

// corInfo carrega a identidade de uma cor para os payloads de fórmula.
type corInfo struct{ CorID, Nome, SubIdent string }

// Lookups é a identidade canônica enviada ao app — TEM que casar com o que o
// CSV-import histórico gravou. VALIDADO contra os dados de PRODUÇÃO (query do
// founder) E contra o GABARITO oficial (export do SayerSystem, 42 CSVs/485k
// linhas, 2026-06-12):
//
//	produto    → codigo VERBATIM      ("JO05.7796")
//	base       → id NUMÉRICO          (gabarito id_base=91 cru; código W só na descrição)
//	embalagem  → id NUMÉRICO          (gabarito id_embalagem=1/2/3/38 cru)
//	corante    → CODIGO verbatim      (CORANTES.CSV codigo=1..16; slots traduzem FK id→codigo)
//	cor padrão → padraocor.codigo VERBATIM — o " - BS" (Base Solvente) JÁ VEM
//	             DENTRO do codigo ("001B - BS", "01 - ACRIL BS"); NUNCA sufixar
//	             (duplicaria, bug v0.1.4/5) e NUNCA trimar (chave é byte-a-byte)
//	cor person → personcor.codigo_cor VERBATIM (espaço no fim preservado: "0105 IVE ")
//	subcolecao → codigo (fallback id; gabarito = "1")
//
// Carregado UMA vez por ciclo (tabelas pequenas, full scan ok).
type Lookups struct {
	ProdutoCod   map[string]string  // produto.id → codigo (fallback: o próprio id)
	BaseIdent    map[string]string  // base.id → id (identidade É o id numérico; mapa id→id explícito)
	EmbIdent     map[string]string  // embalagem.id → id (identidade É o id numérico)
	EmbVolumeML  map[string]float64 // embalagem.id → volume em ML (já convertido de litros)
	CoranteIdent map[string]string  // corante.id → id (identidade É o id numérico)
	CorPadrao    map[string]corInfo // padraocor.id → {codigo||id, descricao, subcolecao.codigo||id via id_subcolecao}
	CorPerson    map[string]corInfo // personcor.id → {codigo_cor||id, descricao||codigo_cor, ""}
}

// newLookups cria um Lookups com todos os maps inicializados.
func newLookups() *Lookups {
	return &Lookups{
		ProdutoCod:   make(map[string]string),
		BaseIdent:    make(map[string]string),
		EmbIdent:     make(map[string]string),
		EmbVolumeML:  make(map[string]float64),
		CoranteIdent: make(map[string]string),
		CorPadrao:    make(map[string]corInfo),
		CorPerson:    make(map[string]corInfo),
	}
}

// identOr traduz um id cru para a identidade canônica do lookup; sem entrada
// (ou entrada vazia) → fallback no próprio id cru (nunca dropa por falta de lookup).
func identOr(m map[string]string, raw string) string {
	if v, ok := m[raw]; ok && v != "" {
		return v
	}
	return raw
}

// litrosLimiar separa litros de ml no volume da embalagem: a origem grava o
// "conteudo" em LITROS (founder confirmou "0.810 L"); nenhuma embalagem real de
// tinta tem 100+ litros, então valor ≤100 é litro (×1000) e >100 assume ml já.
const litrosLimiar = 100.0

// composeCorPadrao monta a identidade e o nome de uma cor PADRÃO.
// O GABARITO de 12/06 (export oficial do SayerSystem, 42 CSVs/485k linhas) provou:
// o export emite padraocor.codigo e descricao VERBATIM — o " - BS" (Base Solvente,
// founder) já vem DENTRO do codigo ("001B - BS", "01 - ACRIL BS"); compor/sufixar
// aqui DUPLICARIA ("… - BS - BS", bug das v0.1.4/5). E NUNCA trimar identidade:
// a era-CSV preservou espaços nas pontas (ex.: personcor "0105 IVE ") — a chave
// oficial é byte-a-byte. codigo vazio/só-espaço → id cru (diverge visível na
// reconciliação, nunca chuta identidade). nome é display (não entra na chave).
func composeCorPadrao(codigo, descricao, id string) (corID, nome string) {
	corID = codigo
	if strings.TrimSpace(corID) == "" {
		corID = id
	}
	nome = descricao
	if strings.TrimSpace(nome) == "" {
		nome = ""
	}
	return corID, nome
}

// normalizaVolumeML converte o volume da origem para ml.
// Retorna assumiuML=true quando o valor veio acima do limiar (já estava em ml) —
// o caller loga um aviso 1× por ciclo nesse caso.
func normalizaVolumeML(v float64) (ml float64, assumiuML bool) {
	if v > 0 && v <= litrosLimiar {
		return math.Round(v * 1000), false
	}
	return v, true
}

// ──────────────────────────────────────────────────────────────
// pgExtractor — implementação real via PG
// ──────────────────────────────────────────────────────────────

// pgExtractor implementa Extractor usando o banco PG real.
type pgExtractor struct {
	db *sql.DB
	rm *ResolvedMapping
}

func (p *pgExtractor) Extract(ctx context.Context, entity string, hwm time.Time) ([]map[string]any, time.Time, error) {
	return ExtractDelta(ctx, p.db, p.rm, entity, hwm)
}

func (p *pgExtractor) ExtractAllFormulasForSnapshot(ctx context.Context) ([]formulaKey, error) {
	return extractAllFormulasForSnapshot(ctx, p.db, p.rm)
}

// LoadLookups carrega os lookups de identidade (1 SELECT por tabela; tabelas
// pequenas, full scan ok). Os SELECTs usam os nomes FÍSICOS resolvidos (rm.Tables
// + rm.Resolved) — nunca nomes hardcoded (lição dos nomes fantasia).
func (p *pgExtractor) LoadLookups(ctx context.Context) (*Lookups, error) {
	lk := newLookups()

	// produto: id → codigo (fallback id) — prod confirma codigo ("JO05.7796").
	if err := p.loadIdentLookup(ctx, "produto", "id_produto", lk.ProdutoCod); err != nil {
		return nil, err
	}
	// base: identidade É o id numérico (gabarito: coluna id_base=91 crua; o
	// código W vive só na descrição) → mapa id→id explícito (mapa vazio +
	// fallback do identOr daria o MESMO valor, mas leria como bug).
	if err := p.loadIDAsIdent(ctx, "base", "id_base", lk.BaseIdent); err != nil {
		return nil, err
	}
	// corantes: identidade = id NUMÉRICO (1..16). ⚠️ A RECONCILIAÇÃO de prod
	// (12/06, staging × oficial) PROVOU: o app tem id_corante "1".."16" e 0 dos
	// "WP01" da v0.1.6 casavam. A coluna "codigo" do CORANTES.CSV do gabarito É o
	// banco corante.id (o export renomeia id→codigo); o banco corante.codigo é
	// "WP01" = só descrição. Os slots formula.corante1..6 são FK→corante.id, então
	// CoranteIdent id→id deixa o slot cru = a identidade certa (como na v0.1.5).
	if err := p.loadIDAsIdent(ctx, "corantes", "id_corante", lk.CoranteIdent); err != nil {
		return nil, err
	}

	// embalagens: identidade = id numérico (prod: "1"/"38") + volume litros→ml.
	if err := p.loadEmbalagens(ctx, lk); err != nil {
		return nil, err
	}

	// subcolecao: id → codigo (interno; vira o SubIdent das cores padrão).
	subIdent := make(map[string]string)
	if err := p.loadIdentLookup(ctx, "subcolecao", "id_subcolecao", subIdent); err != nil {
		return nil, err
	}

	// padracor e personcor: cor → identidade completa (CorID/Nome/SubIdent).
	if err := p.loadCorPadrao(ctx, subIdent, lk); err != nil {
		return nil, err
	}
	if err := p.loadCorPerson(ctx, lk); err != nil {
		return nil, err
	}

	return lk, nil
}

// selectExprText monta a expressão de SELECT de uma coluna lógica: o nome real
// castado para text, ou NULL::text quando a coluna (opcional) não resolveu —
// mantém o número de colunas do scan estável.
func selectExprText(resolved map[string]string, logic string) string {
	if real, ok := resolved[logic]; ok {
		return quoteIdent(real) + `::text`
	}
	return `NULL::text`
}

// loadIdentLookup popula out com id → codigo (fallback: o próprio id) de uma
// entidade. Entidade/colunas ausentes do schema → lookup fica vazio (os
// mapeadores caem no fallback de id cru; nunca falha o ciclo por isso).
func (p *pgExtractor) loadIdentLookup(ctx context.Context, entity, idLogic string, out map[string]string) error {
	resolved, ok := p.rm.Resolved[entity]
	if !ok {
		return nil
	}
	idCol, ok := resolved[idLogic]
	if !ok {
		return nil
	}
	query := fmt.Sprintf(`SELECT %s::text, %s FROM %s`,
		quoteIdent(idCol), selectExprText(resolved, "codigo"), quoteIdent(p.rm.TableFor(entity)))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("LoadLookups %s: %w", entity, err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var codigo sql.NullString
		if err := rows.Scan(&id, &codigo); err != nil {
			return fmt.Errorf("LoadLookups %s scan: %w", entity, err)
		}
		// VERBATIM (sem trim) — identidade é byte-a-byte com a era-CSV.
		ident := codigo.String
		if !codigo.Valid || strings.TrimSpace(ident) == "" {
			ident = id
		}
		out[id] = ident
	}
	return rows.Err()
}

// loadIDAsIdent popula out com id → id (identidade = o próprio id numérico,
// confirmado contra prod p/ base/corante/embalagem). Entidade/coluna ausente do
// schema → lookup vazio (fallback do identOr devolve o cru; nunca falha o ciclo).
func (p *pgExtractor) loadIDAsIdent(ctx context.Context, entity, idLogic string, out map[string]string) error {
	resolved, ok := p.rm.Resolved[entity]
	if !ok {
		return nil
	}
	idCol, ok := resolved[idLogic]
	if !ok {
		return nil
	}
	query := fmt.Sprintf(`SELECT %s::text FROM %s`,
		quoteIdent(idCol), quoteIdent(p.rm.TableFor(entity)))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("LoadLookups %s: %w", entity, err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("LoadLookups %s scan: %w", entity, err)
		}
		out[id] = id
	}
	return rows.Err()
}

// loadEmbalagens popula EmbIdent (id → id; identidade da embalagem É o id
// numérico, confirmado em prod) e EmbVolumeML (id → ml).
// O volume da origem vem em LITROS (coluna "conteudo", ex: 0.810) → normalizaVolumeML.
func (p *pgExtractor) loadEmbalagens(ctx context.Context, lk *Lookups) error {
	resolved, ok := p.rm.Resolved["embalagens"]
	if !ok {
		return nil
	}
	idCol, ok := resolved["id_emb"]
	if !ok {
		return nil
	}
	query := fmt.Sprintf(`SELECT %s::text, %s FROM %s`,
		quoteIdent(idCol),
		selectExprText(resolved, "volume_ml"),
		quoteIdent(p.rm.TableFor("embalagens")))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("LoadLookups embalagens: %w", err)
	}
	defer rows.Close()
	avisouML := false
	for rows.Next() {
		var id string
		var vol sql.NullString
		if err := rows.Scan(&id, &vol); err != nil {
			return fmt.Errorf("LoadLookups embalagens scan: %w", err)
		}
		lk.EmbIdent[id] = id
		// Volume: só entra no map quando parseável e > 0 (volume 0 quebraria a
		// regra de 3 da expansão no servidor — melhor omitir).
		if vol.Valid {
			if v, ok := parseFloatStr(vol.String); ok && v > 0 {
				ml, assumiuML := normalizaVolumeML(v)
				if assumiuML && !avisouML {
					logger.Warnf("LoadLookups embalagens: volume %v > %v — assumindo que a origem já está em ml (esperado: litros)", v, litrosLimiar)
					avisouML = true
				}
				lk.EmbVolumeML[id] = ml
			}
		}
	}
	return rows.Err()
}

// loadCorPadrao popula CorPadrao: padraocor.id → {codigo||id, descricao,
// subcolecao.codigo||id via id_subcolecao}.
func (p *pgExtractor) loadCorPadrao(ctx context.Context, subIdent map[string]string, lk *Lookups) error {
	resolved, ok := p.rm.Resolved["padracor"]
	if !ok {
		return nil
	}
	idCol, ok := resolved["id_padraocor"]
	if !ok {
		return nil
	}
	query := fmt.Sprintf(`SELECT %s::text, %s, %s, %s FROM %s`,
		quoteIdent(idCol),
		selectExprText(resolved, "codigo"),
		selectExprText(resolved, "descricao"),
		selectExprText(resolved, "id_subcolecao"),
		quoteIdent(p.rm.TableFor("padracor")))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("LoadLookups padracor: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var codigo, desc, sub sql.NullString
		if err := rows.Scan(&id, &codigo, &desc, &sub); err != nil {
			return fmt.Errorf("LoadLookups padracor scan: %w", err)
		}
		corID, nome := composeCorPadrao(codigo.String, desc.String, id)
		info := corInfo{CorID: corID, Nome: nome}
		if subKey := strings.TrimSpace(sub.String); subKey != "" {
			// codigo||id da subcolecao; FK órfã (sem linha) → mantém o id cru.
			info.SubIdent = identOr(subIdent, subKey)
		}
		lk.CorPadrao[id] = info
	}
	return rows.Err()
}

// loadCorPerson popula CorPerson: personcor.id → {codigo_cor||id, descricao||codigo_cor, ""}.
func (p *pgExtractor) loadCorPerson(ctx context.Context, lk *Lookups) error {
	resolved, ok := p.rm.Resolved["personcor"]
	if !ok {
		return nil
	}
	idCol, ok := resolved["id_padraocor"]
	if !ok {
		return nil
	}
	query := fmt.Sprintf(`SELECT %s::text, %s, %s FROM %s`,
		quoteIdent(idCol),
		selectExprText(resolved, "codigo"),
		selectExprText(resolved, "descricao"),
		quoteIdent(p.rm.TableFor("personcor")))
	rows, err := p.db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("LoadLookups personcor: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var codigo, desc sql.NullString
		if err := rows.Scan(&id, &codigo, &desc); err != nil {
			return fmt.Errorf("LoadLookups personcor scan: %w", err)
		}
		// VERBATIM (sem trim): o gabarito provou que codigo_cor preserva espaço
		// no fim ("0105 IVE ") e a chave oficial da era-CSV é byte-a-byte.
		cod := codigo.String
		corID := cod
		if strings.TrimSpace(corID) == "" {
			corID = id
		}
		nome := desc.String
		if strings.TrimSpace(nome) == "" {
			nome = cod
		}
		lk.CorPerson[id] = corInfo{CorID: corID, Nome: nome}
	}
	return rows.Err()
}

func (p *pgExtractor) ExtractFormulaChildItems(ctx context.Context, hasOrdem bool) (map[string][]map[string]any, error) {
	return ExtractFormulaChildItems(ctx, p.db, hasOrdem)
}

func (p *pgExtractor) OriginNow(ctx context.Context) (time.Time, error) {
	var t time.Time
	row := p.db.QueryRowContext(ctx, `SELECT now()`)
	if err := row.Scan(&t); err != nil {
		return time.Time{}, fmt.Errorf("OriginNow: %w", err)
	}
	return t, nil
}

// buildSnapshotQuery monta o SELECT do keys-snapshot de uma entidade de fórmula
// usando os nomes REAIS resolvidos (rm.Tables/rm.Resolved). Quando a coluna
// "liberado" resolveu (formula no schema real), filtra COALESCE(liberado,true)=true
// — a chave do snapshot tem que casar com os payloads, que dropam bloqueadas.
// Função pura (testável sem banco).
func buildSnapshotQuery(rm *ResolvedMapping, entity string) (string, error) {
	resolved, ok := rm.Resolved[entity]
	if !ok {
		return "", fmt.Errorf("buildSnapshotQuery: entidade %q não presente no mapeamento", entity)
	}
	var faltam []string
	for _, logic := range []string{"id_padraocor", "id_produto", "id_base", "id_emb"} {
		if _, ok := resolved[logic]; !ok {
			faltam = append(faltam, logic)
		}
	}
	if len(faltam) > 0 {
		return "", fmt.Errorf("buildSnapshotQuery %s: colunas não resolvidas: %s", entity, strings.Join(faltam, ","))
	}
	q := fmt.Sprintf(`SELECT %s::text, %s::text, %s::text, %s::text FROM %s`,
		quoteIdent(resolved["id_padraocor"]),
		quoteIdent(resolved["id_produto"]),
		quoteIdent(resolved["id_base"]),
		quoteIdent(resolved["id_emb"]),
		quoteIdent(rm.TableFor(entity)),
	)
	if libCol, ok := resolved["liberado"]; ok {
		q += fmt.Sprintf(` WHERE COALESCE(%s, true) = true`, quoteIdent(libCol))
	}
	q += fmt.Sprintf(` ORDER BY %s`, quoteIdent(resolved["id_padraocor"]))
	return q, nil
}

// extractAllFormulasForSnapshot extrai as chaves de TODAS as fórmulas (formula +
// formulaperson) para o keys-snapshot. Sem filtro de HWM (snapshot completo).
// Retorna IDs CRUS da origem — a tradução para identidade canônica acontece em
// sendKeysSnapshot (via Lookups), igualzinho aos payloads de fórmula.
func extractAllFormulasForSnapshot(ctx context.Context, db *sql.DB, rm *ResolvedMapping) ([]formulaKey, error) {
	var out []formulaKey
	for _, src := range []struct {
		entity        string
		personalizada bool
	}{
		{"formula", false},
		{"formulaperson", true},
	} {
		if _, ok := rm.Resolved[src.entity]; !ok {
			continue // tabela ausente neste schema → pula (os required já falharam no Validate)
		}
		query, err := buildSnapshotQuery(rm, src.entity)
		if err != nil {
			return nil, fmt.Errorf("extractAllFormulasForSnapshot: %w", err)
		}
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			return nil, fmt.Errorf("extractAllFormulasForSnapshot %s: %w", src.entity, err)
		}
		for rows.Next() {
			var cor, prod, base, emb sql.NullString
			if err := rows.Scan(&cor, &prod, &base, &emb); err != nil {
				rows.Close()
				return nil, fmt.Errorf("extractAllFormulasForSnapshot %s scan: %w", src.entity, err)
			}
			out = append(out, formulaKey{
				CorID:         cor.String,
				CodProduto:    prod.String,
				IDBase:        base.String,
				IDEmb:         emb.String,
				Personalizada: src.personalizada,
			})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, fmt.Errorf("extractAllFormulasForSnapshot %s: %w", src.entity, err)
		}
	}
	return out, nil
}

// ──────────────────────────────────────────────────────────────
// RunCycle — ciclo de sync principal
// ──────────────────────────────────────────────────────────────

// RunCycle executa um ciclo completo de sync.
// Se o schema divergir, grava sayersystem-schema.txt e envia heartbeat com schema_mismatch.
//
// Retorna true SOMENTE se o ciclo foi totalmente bem-sucedido (conectou, schema OK e
// nenhuma entidade/keys-snapshot falhou). Falha de conexão, schema-mismatch ou qualquer
// entidade com erro → false (F7: o `once` propaga isso como exit code != 0).
func RunCycle(ctx context.Context, cfg *Config) bool {
	// Carrega estado persistido.
	st, err := LoadState()
	if err != nil {
		logger.Errorf("RunCycle: falha ao carregar state: %v", err)
		st = &State{HWM: make(map[string]string)}
	}

	// Carrega o cache de hashes de conteúdo das fórmulas (mata o loop de re-envio:
	// a FORMULA tem data NULL → HWM travado → sem isto re-enviava 485k/ciclo).
	hc, hcErr := LoadHashCache()
	if hcErr != nil {
		logger.Errorf("RunCycle: falha ao carregar hash-cache: %v — seguindo com cache vazio (full resend)", hcErr)
		hc = newHashCache()
	}

	// Conecta ao PG.
	db, err := Connect(ctx, cfg.PGConn)
	if err != nil {
		logger.Errorf("RunCycle: falha ao conectar ao PG: %v", err)
		sendHeartbeatBestEffort(ctx, cfg, st, false, "", "")
		return false
	}
	defer db.Close()

	// Valida schema.
	rm, diff, err := Validate(ctx, db)
	if err != nil {
		logger.Errorf("RunCycle: erro ao validar schema: %v", err)
		sendHeartbeatBestEffort(ctx, cfg, st, true, "", "")
		return false
	}
	if !diff.OK {
		mismatchStr := formatSchemaDiff(diff)
		logger.Warnf("RunCycle: schema diverge — não sincroniza. %s", mismatchStr)

		// Grava sayersystem-schema.txt para ajuste do mapeamento.
		outPath := filepath.Join(exeDir(), "sayersystem-schema.txt")
		if _, discErr := RunDiscovery(ctx, db, outPath); discErr != nil {
			logger.Errorf("RunCycle: falha ao gravar schema: %v", discErr)
		}

		// Heartbeat com schema_mismatch.
		token, _ := cfg.Token()
		if token != "" {
			cli := NewClient(cfg.AppURL, token, cfg.StoreCode)
			hb := buildHeartbeat(st, true, Fingerprint(rm), mismatchStr)
			if hbErr := cli.Heartbeat(ctx, hb); hbErr != nil {
				logger.Warnf("RunCycle: falha ao enviar heartbeat de schema_mismatch: %v", hbErr)
			}
		}
		return false // schema-mismatch = ciclo NÃO bem-sucedido
	}

	fp := Fingerprint(rm)
	logger.Infof("RunCycle: schema OK — fp=%s shape=%s", fp, rm.FormulaShape)

	// Obtém now() do PG de origem (para comparações de data).
	ex := &pgExtractor{db: db, rm: rm}
	originNow, nowErr := ex.OriginNow(ctx)
	if nowErr != nil {
		logger.Warnf("RunCycle: falha ao obter now() da origem, usando hora local: %v", nowErr)
		originNow = time.Now()
	}

	// Determina se é necessário full re-scan (todo domingo, uma vez por semana).
	needFullRescan := shouldFullRescan(st, originNow)
	if needFullRescan {
		logger.Infof("RunCycle: iniciando full re-scan semanal (domingo)")
		clearAllHWM(st)
	}

	// Executa ciclo de sync por entidade. `failed` lista as entidades que erraram (F7).
	// lk são os lookups de identidade carregados 1× pelo ciclo (nil em falha fatal).
	counts, failed, lk, fatalErr := runEntityCycles(ctx, cfg, ex, rm, st, hc)
	if fatalErr != nil {
		// Erro fatal (ex: sem token, lookups indisponíveis) — não dá pra sincronizar nada.
		logger.Errorf("RunCycle: erro fatal no ciclo de entidades: %v", fatalErr)
		failed = append(failed, "fatal")
	}

	// Persiste o hash-cache ANTES do keys-snapshot (Codex review 5ª passada): a poda
	// das chaves sumidas tem que estar DURÁVEL em disco antes de o servidor deletar
	// essas fórmulas (via snapshot). Senão um crash entre o snapshot e o save deixaria
	// um hash órfão no hashes.json que pularia a fórmula se ela voltasse idêntica —
	// catálogo stale. Se o save falha, NÃO envia o snapshot (não deleta no servidor
	// com o cache dessincronizado). No-op quando nada mudou.
	hashCacheSaved := true
	if hcSaveErr := SaveHashCache(hc); hcSaveErr != nil {
		logger.Errorf("RunCycle: falha ao salvar hash-cache: %v", hcSaveErr)
		failed = append(failed, "hash_cache")
		hashCacheSaved = false
	}

	// Keys-snapshot diário. Falha aqui também conta como falha de ciclo (F7).
	if shouldKeysSnapshot(st, originNow) {
		if !hashCacheSaved {
			// Cache não persistiu → não deletar no servidor (a poda pode estar só em
			// memória; re-tenta no próximo ciclo, LastKeysSnapshot não avança).
			logger.Warnf("RunCycle: keys-snapshot PULADO — hash-cache não persistiu (evita deletar com cache órfão)")
			failed = append(failed, "keys_snapshot")
		} else if lk == nil {
			// Sem lookups não dá pra montar a identidade das chaves — pular (re-tenta
			// no próximo ciclo; LastKeysSnapshot não avança).
			logger.Warnf("RunCycle: keys-snapshot pulado — lookups de identidade indisponíveis")
			failed = append(failed, "keys_snapshot")
		} else if snapErr := sendKeysSnapshot(ctx, cfg, ex, originNow, lk); snapErr != nil {
			logger.Errorf("RunCycle: falha no keys-snapshot: %v", snapErr)
			failed = append(failed, "keys_snapshot")
		} else {
			st.LastKeysSnapshot = originNow.Format(time.RFC3339)
		}
	}

	success := len(failed) == 0

	// F7: marca o full re-scan como concluído SOMENTE se TODAS as entidades passaram.
	// Antes marcava mesmo com erro parcial → a rede de segurança semanal se perdia
	// silenciosamente quando uma entidade falhava no domingo.
	if needFullRescan {
		if success {
			st.LastFullRescan = originNow.Format(time.RFC3339)
		} else {
			logger.Warnf("RunCycle: full re-scan NÃO marcado como concluído — falhas em: %v (re-tenta no próximo domingo)", failed)
		}
	}

	// Persiste estado. (O hash-cache já foi persistido acima, antes do keys-snapshot.)
	if saveErr := SaveState(st); saveErr != nil {
		logger.Errorf("RunCycle: falha ao salvar state: %v", saveErr)
		success = false
	}

	// Heartbeat final — carrega contadores E as entidades que falharam (F7).
	token, _ := cfg.Token()
	if token != "" {
		cli := NewClient(cfg.AppURL, token, cfg.StoreCode)
		hb := buildHeartbeat(st, true, fp, "")
		hb.LastCycleCounts = counts
		hb.LastCycleErrors = failed
		if hbErr := cli.Heartbeat(ctx, hb); hbErr != nil {
			logger.Warnf("RunCycle: falha ao enviar heartbeat: %v", hbErr)
		}
	}

	if success {
		logger.Infof("RunCycle: concluído com sucesso — %v", counts)
	} else {
		logger.Warnf("RunCycle: concluído COM FALHAS em %v — %v", failed, counts)
	}
	return success
}

// runEntityCycles itera sobre todas as entidades e envia os deltas ao servidor.
// Retorna os contadores de registros enviados por entidade + os Lookups carregados
// (para o keys-snapshot reusar a MESMA identidade; nil quando a falha foi fatal).
func runEntityCycles(
	ctx context.Context,
	cfg *Config,
	ex Extractor,
	rm *ResolvedMapping,
	st *State,
	hc *HashCache,
) (counts map[string]int, failed []string, lk *Lookups, err error) {
	token, tErr := cfg.Token()
	if tErr != nil || token == "" {
		// Sem token é falha FATAL do ciclo (não dá pra enviar nada).
		return nil, nil, nil, fmt.Errorf("runEntityCycles: falha ao obter token: %v", tErr)
	}
	cli := NewClient(cfg.AppURL, token, cfg.StoreCode)

	// Lookups de identidade canônica: carregados UMA vez por ciclo. Sem eles não
	// dá pra enviar nada coerente com o CSV-import histórico → falha FATAL.
	lk, lkErr := ex.LoadLookups(ctx)
	if lkErr != nil {
		return nil, nil, nil, fmt.Errorf("runEntityCycles: falha ao carregar lookups de identidade: %w", lkErr)
	}

	counts = make(map[string]int)

	// record agrega a falha de uma entidade (F7): em vez de só logar e seguir,
	// o nome da entidade entra em `failed` → vira o campo `errors` do heartbeat,
	// bloqueia o LastFullRescan e faz o `once` sair com código != 0.
	record := func(entity string, e error) {
		if e == nil {
			return
		}
		logger.Warnf("sync %s: %v", entity, e)
		failed = append(failed, entity)
	}

	// ──────────────────────────────────────────────────────────────
	// Catálogos: produto, base, embalagens, produto_base_embalagem,
	//            corantes (merged com preco_corante), preco_baseemb
	// ──────────────────────────────────────────────────────────────

	// produto → campo "produtos" no payload /catalogs
	record("produto", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "produto", "produtos", mapProduto))
	// base → "bases"
	record("base", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "base", "bases", mapBase))
	// embalagens → "embalagens"
	record("embalagens", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "embalagens", "embalagens", mapEmbalagem))
	// produto_base_embalagem → "skus" (FKs traduzidas para a identidade canônica)
	skuMiss := &missCounter{}
	record("produto_base_embalagem", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "produto_base_embalagem", "skus", mapSkuWith(lk, skuMiss)))
	skuMiss.logIfAny("produto_base_embalagem")
	// corantes merged com preco_corante
	record("corantes", syncCorantes(ctx, ex, cli, st, counts, rm))
	// preco_baseemb → "precos_base"
	record("preco_baseemb", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "preco_baseemb", "precos_base", mapPrecoBaseEmb))

	// ──────────────────────────────────────────────────────────────
	// Auxiliares de fórmulas: padracor, colecao, subcolecao
	// ──────────────────────────────────────────────────────────────

	record("padracor", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "padracor", "padracores", mapPadracor))
	record("colecao", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "colecao", "colecoes", mapColecao))
	record("subcolecao", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "subcolecao", "subcolecoes", mapSubcolecao))

	// ──────────────────────────────────────────────────────────────
	// Fórmulas: formula (personalizada=false), personcor (lookup),
	//           formulaperson (personalizada=true)
	// Ordem do spec §5.3: ..., subcolecao, formula, personcor, formulaperson
	// ──────────────────────────────────────────────────────────────

	record("formula", syncFormulas(ctx, ex, cli, st, counts, rm, false, lk, hc))
	record("personcor", syncSimpleEntity(ctx, ex, cli, st, counts, rm, "personcor", "personcores", mapPersoncor))
	record("formulaperson", syncFormulas(ctx, ex, cli, st, counts, rm, true, lk, hc))

	return counts, failed, lk, nil
}

// missCounter agrega FKs sem entrada no lookup para logar UM warning por entidade
// (evita spam linha-a-linha; o fallback envia o id cru da origem).
type missCounter struct{ n int }

func (mc *missCounter) miss() { mc.n++ }

func (mc *missCounter) logIfAny(entity string) {
	if mc.n > 0 {
		logger.Warnf("sync %s: %d FK(s) sem entrada no lookup de identidade — enviado o id cru como fallback", entity, mc.n)
	}
}

// ──────────────────────────────────────────────────────────────
// syncSimpleEntity — entidade simples com mapeador de linha
// ──────────────────────────────────────────────────────────────

// rowMapper converte uma linha do PG para o contrato do servidor.
type rowMapper func(row map[string]any) map[string]any

// syncSimpleEntity extrai o delta de `entity`, mapeia cada linha com `mapper`,
// e envia em lotes ao servidor via POST /catalogs com payload {entityField: [...]}.
// HWM avança somente após todos os lotes de uma entidade terem sido aceitos (2xx).
func syncSimpleEntity(
	ctx context.Context,
	ex Extractor,
	cli *Client,
	st *State,
	counts map[string]int,
	rm *ResolvedMapping,
	entity, entityField string,
	mapper rowMapper,
) error {
	// Verifica se a entidade existe no mapeamento resolvido.
	if _, ok := rm.Resolved[entity]; !ok {
		logger.Infof("syncSimpleEntity: entidade %q não presente no schema, pulando", entity)
		return nil
	}

	hwm := hwmFromState(st, entity)
	rows, maxDA, err := ex.Extract(ctx, entity, hwm)
	if err != nil {
		return fmt.Errorf("syncSimpleEntity %s: extract: %w", entity, err)
	}
	if len(rows) == 0 {
		return nil
	}

	// Mapeia as linhas para o contrato do servidor.
	mapped := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if m := mapper(row); m != nil {
			mapped = append(mapped, m)
		}
	}
	if len(mapped) == 0 {
		advanceHWM(st, entity, maxDA)
		return nil
	}

	// Envia em lotes.
	if err := sendInBatches(ctx, cli, "/catalogs", entityField, mapped, entity, st, maxDA); err != nil {
		return err
	}

	counts[entity] += len(mapped)
	return nil
}

// sendInBatches envia `items` em lotes de ≤batchSize ao servidor.
// HWM só avança após TODOS os lotes serem aceitos.
func sendInBatches(
	ctx context.Context,
	cli *Client,
	path, entityField string,
	items []map[string]any,
	entity string,
	st *State,
	maxDA time.Time,
) error {
	total := len(items)
	for start := 0; start < total; start += batchSize {
		end := start + batchSize
		if end > total {
			end = total
		}
		batch := items[start:end]

		payload := map[string]any{
			entityField: batch,
		}
		idempKey := uuid.New().String()

		ar, err := cli.Post(ctx, path, payload, idempKey)
		if err != nil {
			return fmt.Errorf("sendInBatches %s lote %d-%d: %w", entity, start, end, err)
		}
		if ar != nil && ar.ErrorCount > 0 {
			logger.Warnf("sendInBatches %s: %d erro(s) de item no lote %d-%d", entity, ar.ErrorCount, start, end)
		}
	}

	// HWM avança somente após todos os lotes aceitos.
	advanceHWM(st, entity, maxDA)
	return nil
}

// ──────────────────────────────────────────────────────────────
// syncCorantes — merge corantes + preco_corante
// ──────────────────────────────────────────────────────────────

// syncCorantes extrai corantes e preco_corante, constrói um map de preços por id_corante,
// enriquece as linhas de corante com custo/volume_ml e envia via /catalogs.
// Ambas as entidades precisam atualizar antes que o HWM avance.
//
// preco_corante NÃO existe no banco real (v0.1.4) — quando ausente do schema,
// segue só com os corantes (que já carregam volume_ml próprio), SEM erro.
func syncCorantes(
	ctx context.Context,
	ex Extractor,
	cli *Client,
	st *State,
	counts map[string]int,
	rm *ResolvedMapping,
) error {
	// Extrai corantes.
	hwmCor := hwmFromState(st, "corantes")
	rowsCor, maxDACor, err := ex.Extract(ctx, "corantes", hwmCor)
	if err != nil {
		return fmt.Errorf("syncCorantes: extract corantes: %w", err)
	}

	// Extrai preco_corante (lookup de custo/volume por id_corante) — SÓ quando a
	// tabela existe no schema (espelha o guard do syncSimpleEntity).
	var rowsPreco []map[string]any
	var maxDAPreco time.Time
	if _, temPreco := rm.Resolved["preco_corante"]; temPreco {
		hwmPreco := hwmFromState(st, "preco_corante")
		rowsPreco, maxDAPreco, err = ex.Extract(ctx, "preco_corante", hwmPreco)
		if err != nil {
			return fmt.Errorf("syncCorantes: extract preco_corante: %w", err)
		}
	} else {
		logger.Infof("syncCorantes: preco_corante não presente no schema, seguindo só com corantes")
	}

	// Constrói lookup de preços: id_corante → {custo, volume_ml} + flags de presença.
	// F6: custo/volume só entram no payload quando o valor REALMENTE existe (parseável);
	// numeric do PG chega como string → toFloat64OK. Ausente ≠ 0 (não apaga preço bom
	// no servidor, que lê o último valor NÃO-NULL).
	type precoInfo struct {
		custo       float64
		hasCusto    bool
		volumeML    float64
		hasVolumeML bool
	}
	precoMap := make(map[string]precoInfo, len(rowsPreco))
	for _, row := range rowsPreco {
		id := toString(row["id_corante"])
		if id == "" {
			continue
		}
		custo, hasCusto := toFloat64OK(row["custo"])
		vol, hasVol := toFloat64OK(row["volume_ml"])
		precoMap[id] = precoInfo{
			custo:       custo,
			hasCusto:    hasCusto,
			volumeML:    vol,
			hasVolumeML: hasVol,
		}
	}

	// Se não há delta em nenhuma das duas entidades, pula.
	if len(rowsCor) == 0 && len(rowsPreco) == 0 {
		return nil
	}

	// Mescla os dois deltas: leva os corantes do delta + os que só têm preço atualizado.
	// Para os corantes no delta: enriquece com preço (se disponível).
	// Para preco_corante que não estão no delta de corantes: não temos a descrição,
	// então enviamos só o que está no delta de corantes enriquecido.
	merged := make([]map[string]any, 0, len(rowsCor))
	for _, row := range rowsCor {
		id := toString(row["id_corante"])
		m := mapCorante(row)
		if m == nil {
			continue
		}
		// F6: só adiciona a chave quando o valor existe (não envia null/zero por falta de dado).
		if p, ok := precoMap[id]; ok {
			if p.hasCusto {
				m["custo"] = p.custo
			}
			if p.hasVolumeML {
				m["volume_ml"] = p.volumeML
			}
		}
		merged = append(merged, m)
	}

	// Lote de corantes do delta de preco_corante que NÃO estão no delta de corantes.
	// Para esses, precisamos enviar a atualização de preço mesmo sem a linha de corante.
	corInDelta := make(map[string]bool, len(rowsCor))
	for _, row := range rowsCor {
		corInDelta[toString(row["id_corante"])] = true
	}
	for _, row := range rowsPreco {
		id := toString(row["id_corante"])
		if corInDelta[id] {
			continue // já incluído acima
		}
		if id == "" {
			continue
		}
		// Envia somente o id + preços presentes (servidor faz upsert parcial).
		// F6: omite custo/volume ausentes em vez de mandar null/zero.
		p := precoMap[id]
		row := map[string]any{"id_corante_sayersystem": id}
		if p.hasCusto {
			row["custo"] = p.custo
		}
		if p.hasVolumeML {
			row["volume_ml"] = p.volumeML
		}
		merged = append(merged, row)
	}

	if len(merged) == 0 {
		advanceHWM(st, "corantes", maxDACor)
		advanceHWM(st, "preco_corante", maxDAPreco)
		return nil
	}

	if err := sendInBatchesRaw(ctx, cli, "/catalogs", "corantes", merged, func() {
		advanceHWM(st, "corantes", maxDACor)
		advanceHWM(st, "preco_corante", maxDAPreco)
	}); err != nil {
		return err
	}

	counts["corantes"] += len(merged)
	return nil
}

// sendInBatchesRaw envia `items` em lotes, chamando `onSuccess` somente após TODOS aceitos.
func sendInBatchesRaw(
	ctx context.Context,
	cli *Client,
	path, entityField string,
	items []map[string]any,
	onSuccess func(),
) error {
	total := len(items)
	for start := 0; start < total; start += batchSize {
		end := start + batchSize
		if end > total {
			end = total
		}
		batch := items[start:end]
		payload := map[string]any{entityField: batch}
		idempKey := uuid.New().String()

		ar, err := cli.Post(ctx, path, payload, idempKey)
		if err != nil {
			return fmt.Errorf("sendInBatchesRaw %s lote %d-%d: %w", entityField, start, end, err)
		}
		if ar != nil && ar.ErrorCount > 0 {
			logger.Warnf("sendInBatchesRaw %s: %d erro(s) no lote %d-%d", entityField, ar.ErrorCount, start, end)
		}
	}
	onSuccess()
	return nil
}

// ──────────────────────────────────────────────────────────────
// syncFormulas — formula e formulaperson
// ──────────────────────────────────────────────────────────────

// syncFormulas extrai e envia fórmulas (padrão ou personalizada).
// Para shape=child: busca os itens da tabela filha formula_item.
// Para shape=flat: aggregateFlatFormulaItems já foi aplicado pelo ExtractDelta.
// lk são os lookups de identidade carregados 1× pelo ciclo (runEntityCycles).
func syncFormulas(
	ctx context.Context,
	ex Extractor,
	cli *Client,
	st *State,
	counts map[string]int,
	rm *ResolvedMapping,
	personalizada bool,
	lk *Lookups,
	hc *HashCache,
) error {
	entity := "formula"
	if personalizada {
		entity = "formulaperson"
	}

	if _, ok := rm.Resolved[entity]; !ok {
		logger.Infof("syncFormulas: entidade %q não presente no schema, pulando", entity)
		return nil
	}

	hwm := hwmFromState(st, entity)
	// O hash-cache substitui o HWM SÓ quando ele está travado em zero (a FORMULA, com
	// data NULL). Com HWM funcional, o delta por timestamp já é a verdade e o
	// hash-filter/poda são bypassados — senão um delete+recreate de conteúdo idêntico
	// seria pulado e ficaria ausente no servidor (Codex review 4ª passada).
	applyHashFilter := hwm.IsZero()
	rows, maxDA, err := ex.Extract(ctx, entity, hwm)
	if err != nil {
		return fmt.Errorf("syncFormulas %s: extract: %w", entity, err)
	}
	if len(rows) == 0 {
		// Full-scan que voltou VAZIO (entidade esvaziou na origem) ainda precisa
		// PODAR: as chaves órfãs têm que sair do cache, senão fórmulas recriadas com
		// o mesmo conteúdo seriam puladas pelo hash antigo (Codex review P2).
		if applyHashFilter {
			pruneFormulaHashes(hc, map[string]struct{}{}, personalizada)
		}
		return nil
	}

	// Para shape=child: enriquece com itens da tabela filha.
	var childItems map[string][]map[string]any
	pkResolved := false
	if rm.FormulaShape == FormulaShapeChild {
		// F5: a junção é pela PK da fórmula (= formula_item.id_formula), NÃO pelo id_padraocor.
		// id_padraocor é a COR (1 cor → N fórmulas), então juntar por ele traria itens errados
		// ou nenhum. A PK foi resolvida no mapeamento (formula_pk via candidatos id_formula|id|codigo).
		_, pkResolved = rm.Resolved[entity]["formula_pk"]
		if !pkResolved {
			logger.Warnf("syncFormulas %s: shape=child mas a PK da fórmula (formula_pk) não resolveu — "+
				"itens NÃO serão anexados; rode 'discovery' e ajuste os candidatos de formula_pk", entity)
		}
		childItems, err = ex.ExtractFormulaChildItems(ctx, rm.ChildHasOrdem)
		if err != nil {
			return fmt.Errorf("syncFormulas %s: ExtractFormulaChildItems: %w", entity, err)
		}
	}

	// Mapeia cada linha para o payload do servidor, computa o hash de CONTEÚDO e
	// envia SÓ as fórmulas com hash novo/alterado. É isto que mata o loop de 485k:
	// a FORMULA tem data_atualizacao NULL → o HWM nunca avança → a extração traz
	// tudo sempre, mas o hash-cache corta o re-envio do que não mudou.
	// bloqueadas (liberado=false) são contadas À PARTE de dropped (campo faltante) —
	// bloqueio é estado normal do catálogo, drop é dado quebrado.
	dropped := 0
	bloqueadas := 0
	liveKeys := make(map[string]struct{}, len(rows)) // chaves vistas nesta extração (p/ poda)
	changed := make([]formulaToSend, 0, len(rows))
	for _, row := range rows {
		if formulaBloqueada(row) {
			bloqueadas++
			continue
		}
		m := mapFormula(row, personalizada, lk)
		if m == nil {
			dropped++
			continue
		}
		// Para shape=child: injeta os itens, juntando pela PK da fórmula (F5).
		if rm.FormulaShape == FormulaShapeChild {
			idFormula := toString(row["formula_pk"]) // chave de junção = PK da fórmula
			if items, ok := childItems[idFormula]; ok {
				m["itens"] = items
			} else {
				m["itens"] = []map[string]any{}
			}
		}
		// Para shape=flat: os itens já estão em row["itens"] (aggregateFlatFormulaItems).
		if _, hasItens := m["itens"]; !hasItens {
			if itens, ok := row["itens"]; ok {
				m["itens"] = itens
			}
		}
		// Traduz o id_corante cru de cada item para a identidade canônica (codigo).
		if itens, ok := m["itens"].([]map[string]any); ok {
			m["itens"] = traduzItensCorante(itens, lk)
		}

		// Hash sobre o payload FINAL (após tradução dos itens) — é o que de fato é
		// POSTado e o que muda o catálogo (Codex #2).
		key := formulaCacheKey(m)
		liveKeys[key] = struct{}{}
		hash := formulaContentHash(m)
		if applyHashFilter {
			if old, ok := hc.Get(key); ok && old == hash {
				continue // full-scan: conteúdo inalterado → não re-envia
			}
		}
		changed = append(changed, formulaToSend{payload: m, key: key, hash: hash})
	}
	if bloqueadas > 0 {
		logger.Infof("syncFormulas %s: %d fórmula(s) bloqueada(s) (liberado=false) não enviada(s)", entity, bloqueadas)
	}
	if dropped > 0 {
		logger.Warnf("syncFormulas %s: %d linha(s) descartada(s) por campos obrigatórios ausentes (cor_id/cod_produto/id_base/id_embalagem)", entity, dropped)
	}

	// Poda (Codex #7/#8): só em full-scan (hwm zero — SEMPRE o caso da FORMULA, cuja
	// data é NULL). Remove do cache as chaves DESTA entidade (mesmo `personalizada`)
	// ausentes da extração: fórmulas removidas da origem e bloqueadas saem do cache
	// (recriar/desbloquear força re-envio). Não podar em delta parcial removeria
	// chaves vivas, por isso o gate applyHashFilter (== hwm.IsZero()).
	if applyHashFilter {
		pruneFormulaHashes(hc, liveKeys, personalizada)
	}

	if len(changed) == 0 {
		advanceHWM(st, entity, maxDA)
		return nil
	}

	if err := sendFormulasInBatches(ctx, cli, changed, entity, st, maxDA, hc); err != nil {
		return err
	}

	counts[entity] += len(changed)
	return nil
}

// formulaToSend acopla o payload de uma fórmula ao seu (key, hash) — o hash só é
// gravado no cache APÓS o servidor aceitar o item.
type formulaToSend struct {
	payload map[string]any
	key     string
	hash    string
}

// sendFormulasInBatches envia as fórmulas mudadas em lotes ≤batchSize e grava no
// cache o hash de cada item ACEITO. Itens rejeitados pela edge (Errors[].Index) NÃO
// são cacheados → re-tentam no próximo ciclo (Codex #5: senão um item permanentemente
// quebrado nunca convergiria e o lote inteiro re-enviaria pra sempre).
//
// O cache é gravado por LOTE aceito (incremental, não tudo-ou-nada como o HWM): na
// primeira execução são ~485 lotes; se um falhar no meio, os já aceitos ficam
// cacheados e o próximo ciclo retoma de onde parou.
func sendFormulasInBatches(
	ctx context.Context,
	cli *Client,
	items []formulaToSend,
	entity string,
	st *State,
	maxDA time.Time,
	hc *HashCache,
) error {
	total := len(items)
	allAccepted := true
	notCached := 0
	for start := 0; start < total; start += batchSize {
		end := start + batchSize
		if end > total {
			end = total
		}
		batch := items[start:end]

		payload := make([]map[string]any, len(batch))
		for i, it := range batch {
			payload[i] = it.payload
		}
		idempKey := uuid.New().String()

		ar, err := cli.Post(ctx, "/formulas", map[string]any{"formulas": payload}, idempKey)
		if err != nil {
			return fmt.Errorf("sendFormulasInBatches %s lote %d-%d: %w", entity, start, end, err)
		}

		// Só cacheia o lote se a edge CONFIRMOU explicitamente: ok:true E sem erro de
		// item. Falha FECHADA também em ok:false / corpo vazio-ou-malformado (o Client
		// desserializa para um ar zerado, OK=false) e em Errors não-vazio mesmo com
		// ErrorCount=0 — precisão > recall: nunca marcar como enviado sem confirmação
		// (Codex review). O servidor não diz de forma confiável QUAIS itens falharam
		// (Index pode vir ausente=0), então o lote inteiro re-tenta. Erro é raro:
		// mapFormula já dropa campo obrigatório ausente antes do envio.
		if ar == nil || !ar.OK || ar.ErrorCount > 0 || len(ar.Errors) > 0 {
			allAccepted = false
			notCached += len(batch)
			okv := ar != nil && ar.OK
			nerr := 0
			if ar != nil {
				if nerr = ar.ErrorCount; nerr == 0 {
					nerr = len(ar.Errors)
				}
			}
			logger.Warnf("sendFormulasInBatches %s: lote %d-%d NÃO cacheado (ok=%v, %d erro(s) de item) — re-tenta no próximo ciclo", entity, start, end, okv, nerr)
			continue
		}
		for _, it := range batch {
			hc.Set(it.key, it.hash)
		}
	}

	// Só avança o HWM se TODOS os lotes foram aceitos (Codex review P2). Com erro,
	// não avançar deixa o delta re-trazer as linhas no próximo ciclo (o hash-cache
	// filtra as já enviadas; só as não-cacheadas re-enviam). Para a FORMULA, maxDA é
	// zero (data NULL) e advanceHWM já é no-op — isto blinda formulaperson/fontes com
	// data, onde um HWM avançado pularia as linhas rejeitadas até o full rescan.
	if allAccepted {
		advanceHWM(st, entity, maxDA)
		return nil
	}

	// Visibilidade (Codex review P1): item rejeitado vira FALHA de ciclo — a entidade
	// entra em LastCycleErrors do heartbeat e bloqueia o LastFullRescan, em vez de
	// re-tentar em silêncio para sempre. Os lotes aceitos já foram cacheados; os com
	// erro re-tentam. Erro de item é raro (mapFormula filtra os de campo obrigatório
	// ausente antes do envio), então isto sinaliza um problema real a investigar.
	return fmt.Errorf("sendFormulasInBatches %s: %d fórmula(s) não confirmada(s) pela edge — não cacheada(s), re-tenta no próximo ciclo", entity, notCached)
}

// traduzItensCorante traduz o id_corante CRU (id numérico da origem) de cada item
// para a identidade canônica (corante.codigo) via lookup; sem entrada → mantém cru.
func traduzItensCorante(itens []map[string]any, lk *Lookups) []map[string]any {
	if lk == nil {
		return itens
	}
	for _, it := range itens {
		raw := toString(it["id_corante"])
		if raw == "" {
			continue
		}
		it["id_corante"] = identOr(lk.CoranteIdent, raw)
	}
	return itens
}

// ──────────────────────────────────────────────────────────────
// Keys-snapshot
// ──────────────────────────────────────────────────────────────

// snapshotChunkSize é o tamanho máximo de linhas por chunk do keys-snapshot.
const snapshotChunkSize = 50000

// shouldKeysSnapshot retorna true se o keys-snapshot diário deve ser enviado.
// Compara a data (YYYY-MM-DD) do último snapshot com a data da origem.
func shouldKeysSnapshot(st *State, originNow time.Time) bool {
	if st.LastKeysSnapshot == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, st.LastKeysSnapshot)
	if err != nil {
		return true // data inválida → re-envia
	}
	lastDate := last.In(originNow.Location()).Format("2006-01-02")
	nowDate := originNow.Format("2006-01-02")
	return lastDate != nowDate
}

// shouldFullRescan retorna true se o full re-scan semanal deve ocorrer.
// Critério: dia é domingo (weekday==Sunday) E a semana ISO do último re-scan
// é diferente da semana atual.
func shouldFullRescan(st *State, originNow time.Time) bool {
	if originNow.Weekday() != time.Sunday {
		return false
	}
	if st.LastFullRescan == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, st.LastFullRescan)
	if err != nil {
		return true
	}
	_, lastWeek := last.ISOWeek()
	_, nowWeek := originNow.ISOWeek()
	lastYear, _ := last.ISOWeek()
	nowYear, _ := originNow.ISOWeek()
	return lastWeek != nowWeek || lastYear != nowYear
}

// clearAllHWM zera todos os HWMs do state (força full re-scan de todas as entidades).
func clearAllHWM(st *State) {
	st.HWM = make(map[string]string)
}

// sendKeysSnapshot envia um snapshot completo de todas as chaves de fórmulas.
//
// F3 (mudança de CONTRATO coordenada com o servidor): a chave é a IDENTIDADE DA
// FÓRMULA FONTE, SEM embalagem — "cor_id|cod_produto|id_base|personalizada" (4 partes).
// O servidor expande UMA fórmula fonte em N embalagens vendáveis (cada uma vira uma
// linha oficial com id_embalagem diferente); uma chave por-embalagem JAMAIS casaria
// com a fonte → a deleção por blast-radius abortaria (ou desativaria a loja inteira).
// O servidor (corrigido em paralelo) deriva a mesma chave de 4 partes das linhas oficiais.
//
// F2: o payload inclui `entity:"formulas"` + `snapshot_id` (uuid v4, MESMO valor em
// todos os chunks do mesmo snapshot diário) — campos que a edge EXIGE (400 sem eles).
//
// ⚠️ A chave do snapshot TEM que usar a MESMA identidade dos payloads de fórmula
// (mapFormula): os ids CRUS da extração são traduzidos aqui via Lookups (cor →
// CorPerson/CorPadrao conforme a fonte, produto → ProdutoCod, base → BaseIdent).
// Sem isso a deleção por snapshot nunca casa — ou desativa a loja inteira (o
// blast-radius do servidor segura, mas não dependa dele).
//
// Enviado em chunks de ≤50000 linhas.
func sendKeysSnapshot(
	ctx context.Context,
	cfg *Config,
	ex Extractor,
	originNow time.Time,
	lk *Lookups,
) error {
	token, err := cfg.Token()
	if err != nil || token == "" {
		return fmt.Errorf("sendKeysSnapshot: token indisponível")
	}
	cli := NewClient(cfg.AppURL, token, cfg.StoreCode)

	// Obtém todas as fórmulas.
	keys, err := ex.ExtractAllFormulasForSnapshot(ctx)
	if err != nil {
		return fmt.Errorf("sendKeysSnapshot: extract: %w", err)
	}

	// Serializa as chaves como strings "cor_id|cod_produto|id_base|personalizada"
	// (4 partes — SEM embalagem; ver F3 acima), traduzindo os ids crus para a
	// identidade canônica. Deduplica: a mesma fórmula fonte pode aparecer em várias
	// linhas de embalagem na origem, mas a chave colapsa.
	seen := make(map[string]struct{}, len(keys))
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		personStr := "false"
		corID := k.CorID
		if k.Personalizada {
			personStr = "true"
			if info, ok := lk.CorPerson[k.CorID]; ok && info.CorID != "" {
				corID = info.CorID
			}
		} else if info, ok := lk.CorPadrao[k.CorID]; ok && info.CorID != "" {
			corID = info.CorID
		}
		line := fmt.Sprintf("%s|%s|%s|%s",
			corID,
			identOr(lk.ProdutoCod, k.CodProduto),
			identOr(lk.BaseIdent, k.IDBase),
			personStr,
		)
		if _, dup := seen[line]; dup {
			continue
		}
		seen[line] = struct{}{}
		lines = append(lines, line)
	}

	// snapshot_id: 1 uuid por snapshot diário, IGUAL em todos os chunks (a edge agrupa
	// os chunks por snapshot_id pra montar o conjunto completo antes de aplicar a deleção).
	snapshotID := uuid.New().String()

	// Obtém o generated_at do PG de origem (não do clock do conector).
	generatedAt := originNow.Format(time.RFC3339)

	// Envia em chunks.
	totalChunks := int(math.Ceil(float64(len(lines)) / float64(snapshotChunkSize)))
	if totalChunks == 0 {
		totalChunks = 1
	}

	for chunkIdx := 0; chunkIdx < totalChunks; chunkIdx++ {
		start := chunkIdx * snapshotChunkSize
		end := start + snapshotChunkSize
		if end > len(lines) {
			end = len(lines)
		}
		// keys precisa ser um array JSON (nunca null) mesmo no snapshot vazio —
		// a edge valida Array.isArray(keys).
		chunk := []string{}
		if start < len(lines) {
			chunk = lines[start:end]
		}

		isLast := chunkIdx == totalChunks-1
		payload := map[string]any{
			"entity":        "formulas",
			"snapshot_id":   snapshotID,
			"generated_at":  generatedAt,
			"chunk_index":   chunkIdx,
			"total_chunks":  totalChunks,
			"is_last_chunk": isLast,
			"keys":          chunk,
		}

		idempKey := uuid.New().String()
		ar, postErr := cli.Post(ctx, "/keys-snapshot", payload, idempKey)
		if postErr != nil {
			return fmt.Errorf("sendKeysSnapshot chunk %d/%d: %w", chunkIdx+1, totalChunks, postErr)
		}
		if ar != nil && !ar.OK && ar.ErrorCount > 0 {
			logger.Warnf("sendKeysSnapshot chunk %d/%d: %d erro(s)", chunkIdx+1, totalChunks, ar.ErrorCount)
		}
		logger.Infof("sendKeysSnapshot: chunk %d/%d enviado (%d chaves, snapshot_id=%s)", chunkIdx+1, totalChunks, len(chunk), snapshotID)
	}

	return nil
}

// ──────────────────────────────────────────────────────────────
// Mapeadores de linha (PG row → contrato do servidor)
// ──────────────────────────────────────────────────────────────

// Identidade canônica nos mapeadores: codigo-first (codigo da própria row quando
// resolvido; fallback no id numérico) — TEM que casar com o CSV-import histórico.
// Os switches de identidade vivem aqui + nos Lookups (1 lugar pra virar 1-linha
// se a checagem com dados de prod contradisser).

func mapProduto(row map[string]any) map[string]any {
	id := toString(row["id_produto"])
	if id == "" {
		return nil
	}
	// Identidade: codigo VERBATIM quando presente (sem trim — byte-a-byte com a
	// era-CSV); só-espaço/vazio → id.
	ident := toString(row["codigo"])
	if strings.TrimSpace(ident) == "" {
		ident = id
	}
	// ⚠️ NÃO mandar campo que a staging não tem: a edge espalha TODOS os campos
	// do item no INSERT de tint_staging_produtos (cod_produto/descricao/raw_data...);
	// um campo extra ("ativo") derruba o LOTE INTEIRO com erro de coluna — visto em
	// CAMPO (12/06): "sendInBatches produto: 20 erro(s) de item no lote 0-20".
	return map[string]any{
		"cod_produto": ident,
		"descricao":   toString(row["descricao"]),
	}
}

func mapBase(row map[string]any) map[string]any {
	id := toString(row["id_base"])
	if id == "" {
		return nil
	}
	// Identidade da base = id NUMÉRICO (prod: id_base_sayersystem="90"; o código
	// W — ex. WJOB.7796 — vive só na descrição). NÃO usar codigo aqui.
	return map[string]any{
		"id_base_sayersystem": id,
		"descricao":           toString(row["descricao"]),
	}
}

func mapEmbalagem(row map[string]any) map[string]any {
	id := toString(row["id_emb"])
	if id == "" {
		return nil
	}
	// Identidade da embalagem = id NUMÉRICO (prod: id_embalagem_sayersystem="1"/
	// "38"; a descrição — "QT (0.810 L)" — é só display). NÃO usar descricao aqui.
	m := map[string]any{
		"id_embalagem_sayersystem": id,
		"descricao":                toString(row["descricao"]),
	}
	// volume (numeric→string): só envia se parseável e > 0. Ausente ≠ 0 — 0 quebraria
	// a regra de 3 da expansão no servidor (divisão pelo volume da embalagem).
	// A origem grava em LITROS (coluna conteudo) → normalizaVolumeML converte.
	if vol, ok := toFloat64OK(row["volume_ml"]); ok && vol > 0 {
		ml, _ := normalizaVolumeML(vol)
		m["volume_ml"] = ml
	}
	return m
}

// mapSkuWith retorna o mapeador de produto_base_embalagem com os 3 FKs traduzidos
// para a identidade canônica via Lookups. FK sem entrada no lookup → id cru
// (fallback) + 1 warning AGREGADO por entidade via missCounter (nil = sem contagem).
func mapSkuWith(lk *Lookups, miss *missCounter) rowMapper {
	return func(row map[string]any) map[string]any {
		prod := toString(row["id_produto"])
		base := toString(row["id_base"])
		emb := toString(row["id_emb"])
		if prod == "" || base == "" || emb == "" {
			return nil
		}
		return map[string]any{
			"cod_produto":  lookupOrMiss(lk.ProdutoCod, prod, miss),
			"id_base":      lookupOrMiss(lk.BaseIdent, base, miss),
			"id_embalagem": lookupOrMiss(lk.EmbIdent, emb, miss),
		}
	}
}

// lookupOrMiss é o identOr que conta o miss (para o warning agregado).
func lookupOrMiss(m map[string]string, raw string, miss *missCounter) string {
	if v, ok := m[raw]; ok && v != "" {
		return v
	}
	if miss != nil {
		miss.miss()
	}
	return raw
}

func mapCorante(row map[string]any) map[string]any {
	id := toString(row["id_corante"])
	if id == "" {
		return nil
	}
	// Identidade do corante = id NUMÉRICO (1..16). ⚠️ A RECONCILIAÇÃO de prod
	// (12/06) PROVOU: o app tem id_corante "1".."16" e 0 dos "WP01" (corante.codigo)
	// casavam. O número (corante.id) é o que o CSV-import gravou e o que os slots
	// formula.corante1..6 referenciam. corante.codigo ("WP01") é só descrição.
	m := map[string]any{
		"id_corante_sayersystem": id,
		"descricao":              toString(row["descricao"]),
	}
	// corante.volume_ml da origem JÁ está em ML — NÃO converter (≠ embalagem).
	if vol, ok := toFloat64OK(row["volume_ml"]); ok && vol > 0 {
		m["volume_ml"] = vol
	}
	return m
}

func mapPrecoBaseEmb(row map[string]any) map[string]any {
	prod := toString(row["id_produto"])
	base := toString(row["id_base"])
	emb := toString(row["id_emb"])
	if prod == "" || base == "" || emb == "" {
		return nil
	}
	m := map[string]any{
		"cod_produto":  prod,
		"id_base":      base,
		"id_embalagem": emb,
	}
	// custo/imposto/margem (numeric→string): só envia o que é parseável.
	// Ausente ≠ 0 — degradação honesta de preço (servidor → preco_final NULL).
	if custo, ok := toFloat64OK(row["custo"]); ok {
		m["custo"] = custo
	}
	if imp, ok := toFloat64OK(row["imposto"]); ok {
		m["imposto_pct"] = imp
	}
	if mrg, ok := toFloat64OK(row["margem"]); ok {
		m["margem_pct"] = mrg
	}
	return m
}

func mapPadracor(row map[string]any) map[string]any {
	id := toString(row["id_padraocor"])
	if id == "" {
		return nil
	}
	// MESMA composição do cor_id das fórmulas (codigo+" - BS"; sem codigo → id
	// cru) — identidade da cor tem que ser uma só em todos os payloads.
	ident, nome := composeCorPadrao(toString(row["codigo"]), toString(row["descricao"]), id)
	m := map[string]any{
		"id_padraocor": ident,
	}
	if nome != "" {
		m["descricao"] = nome
	} else {
		m["descricao"] = toString(row["descricao"])
	}
	return m
}

func mapColecao(row map[string]any) map[string]any {
	id := toString(row["id_colecao"])
	if id == "" {
		return nil
	}
	ident := toString(row["codigo"])
	if ident == "" {
		ident = id
	}
	return map[string]any{
		"id_colecao": ident,
		"descricao":  toString(row["descricao"]),
	}
}

func mapSubcolecao(row map[string]any) map[string]any {
	id := toString(row["id_subcolecao"])
	if id == "" {
		return nil
	}
	ident := toString(row["codigo"])
	if ident == "" {
		ident = id
	}
	return map[string]any{
		"id_subcolecao": ident,
		// id_colecao segue CRU (não há lookup de colecao nos Lookups; tradução
		// codigo||id da coleção não é trivial aqui — v0.1.4 se precisar).
		"id_colecao": toString(row["id_colecao"]),
		"descricao":  toString(row["descricao"]),
	}
}

func mapPersoncor(row map[string]any) map[string]any {
	id := toString(row["id_padraocor"])
	if id == "" {
		return nil
	}
	// Identidade: codigo_cor VERBATIM (gabarito preserva espaço no fim:
	// "0105 IVE " — NUNCA trimar; chave é byte-a-byte) || id quando só-espaço.
	ident := toString(row["codigo"])
	if strings.TrimSpace(ident) == "" {
		ident = id
	}
	desc := toString(row["descricao"])
	if strings.TrimSpace(desc) == "" {
		desc = ident
	}
	return map[string]any{
		"id_padraocor": ident,
		"descricao":    desc,
	}
}

// toBoolOK converte um valor do PG em bool. O driver entrega bool nativo; cobre
// também string/[]byte ("f"/"false"/"t"/"true") defensivamente.
// Retorna (valor, true) quando conversível; (false, false) caso contrário.
func toBoolOK(v any) (bool, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case *bool:
		if b != nil {
			return *b, true
		}
	case string:
		return parseBoolStr(b)
	case []byte:
		return parseBoolStr(string(b))
	}
	return false, false
}

// parseBoolStr interpreta as grafias booleanas do Postgres ("t"/"f"/"true"/"false").
func parseBoolStr(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "t", "true":
		return true, true
	case "f", "false":
		return false, true
	}
	return false, false
}

// formulaBloqueada reporta se a linha tem liberado=false EXPLÍCITO (fórmula
// bloqueada no SayerSystem → não enviar). Coluna ausente/nil/não-parseável =
// liberada (não dropar por falta de dado).
func formulaBloqueada(row map[string]any) bool {
	v, ok := row["liberado"]
	if !ok || v == nil {
		return false
	}
	if b, bok := toBoolOK(v); bok && !b {
		return true
	}
	return false
}

// mapFormula converte uma linha de fórmula para o contrato do servidor, traduzindo
// os ids crus da origem para a identidade canônica via Lookups (fallback: id cru —
// nunca dropa por falta de lookup). A cor personalizada resolve em lk.CorPerson e a
// padrão em lk.CorPadrao (maps SEPARADOS: padraocor.id e personcor.id podem colidir).
// Retorna nil se: campo obrigatório ausente (dropped) OU liberado=false (bloqueada —
// o caller distingue via formulaBloqueada ANTES de chamar, para contar à parte).
func mapFormula(row map[string]any, personalizada bool, lk *Lookups) map[string]any {
	corRaw := toString(row["id_padraocor"])
	prodRaw := toString(row["id_produto"])
	baseRaw := toString(row["id_base"])
	embRaw := toString(row["id_emb"])

	// Campos obrigatórios — drop+log se ausentes (edge function os rejeita).
	if corRaw == "" || prodRaw == "" || baseRaw == "" || embRaw == "" {
		return nil
	}

	// liberado=false → não envia (guard interno; o caller conta como bloqueada).
	if formulaBloqueada(row) {
		return nil
	}

	// Cor: lookup SEPARADO por tipo (personalizada × padrão).
	var info corInfo
	var okInfo bool
	if personalizada {
		info, okInfo = lk.CorPerson[corRaw]
	} else {
		info, okInfo = lk.CorPadrao[corRaw]
	}
	corID := corRaw
	if okInfo && info.CorID != "" {
		corID = info.CorID
	}

	m := map[string]any{
		"cor_id":        corID,
		"cod_produto":   identOr(lk.ProdutoCod, prodRaw),
		"id_base":       identOr(lk.BaseIdent, baseRaw),
		"id_embalagem":  identOr(lk.EmbIdent, embRaw),
		"personalizada": personalizada,
	}

	// nome_cor: resolve via lookup; ausente se não encontrado (degradação honesta).
	if okInfo && info.Nome != "" {
		m["nome_cor"] = info.Nome
	}

	// volume_final_ml: resolve via lookup de embalagens (já convertido para ml).
	if vol, ok := lk.EmbVolumeML[embRaw]; ok {
		m["volume_final_ml"] = vol
	}

	// subcolecao: SÓ cor padrão (vem da COR via lookup — padraocor.id_subcolecao;
	// a tabela formula real não tem a coluna).
	if !personalizada && okInfo && info.SubIdent != "" {
		m["subcolecao"] = info.SubIdent
	}

	return m
}

// ──────────────────────────────────────────────────────────────
// HWM helpers
// ──────────────────────────────────────────────────────────────

// hwmFromState retorna o HWM de uma entidade, subtraindo a margem de 5min.
// Se não houver HWM (nunca sincronizado), retorna zero-time (full scan).
func hwmFromState(st *State, entity string) time.Time {
	raw := st.HWM[entity]
	if raw == "" {
		return time.Time{} // zero-time = full scan
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	// Aplica a margem de 5min (§11 P1-D).
	t = t.Add(-hwmMargin)
	if t.Before(time.Time{}) {
		return time.Time{}
	}
	return t
}

// advanceHWM avança o HWM de uma entidade para maxDA (se maxDA for posterior ao atual).
func advanceHWM(st *State, entity string, maxDA time.Time) {
	if maxDA.IsZero() {
		return
	}
	current := st.HWM[entity]
	if current != "" {
		ct, err := time.Parse(time.RFC3339Nano, current)
		if err == nil && !maxDA.After(ct) {
			return // não regride
		}
	}
	st.HWM[entity] = maxDA.UTC().Format(time.RFC3339Nano)
}

// ──────────────────────────────────────────────────────────────
// Heartbeat helpers
// ──────────────────────────────────────────────────────────────

// buildHeartbeat constrói o HeartbeatPayload para envio.
func buildHeartbeat(st *State, dbOK bool, fp, mismatch string) HeartbeatPayload {
	hostname, _ := os.Hostname()
	return HeartbeatPayload{
		AgentVersion:      Version,
		Hostname:          hostname,
		DBConnected:       dbOK,
		SchemaFingerprint: fp,
		SchemaMismatch:    mismatch,
	}
}

// sendHeartbeatBestEffort tenta enviar um heartbeat; ignora falha (best-effort).
func sendHeartbeatBestEffort(ctx context.Context, cfg *Config, st *State, dbOK bool, fp, mismatch string) {
	token, err := cfg.Token()
	if err != nil || token == "" {
		return
	}
	cli := NewClient(cfg.AppURL, token, cfg.StoreCode)
	hb := buildHeartbeat(st, dbOK, fp, mismatch)
	if hbErr := cli.Heartbeat(ctx, hb); hbErr != nil {
		logger.Warnf("sendHeartbeatBestEffort: %v", hbErr)
	}
}

// ──────────────────────────────────────────────────────────────
// SchemaDiff formatter
// ──────────────────────────────────────────────────────────────

// formatSchemaDiff formata o SchemaDiff em uma string legível para heartbeat/log.
func formatSchemaDiff(diff *SchemaDiff) string {
	if diff == nil {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("schema_mismatch: ")
	if diff.OK {
		sb.WriteString("ok")
		return sb.String()
	}
	for tbl, cols := range diff.Missing {
		sb.WriteString(fmt.Sprintf("tabela=%s colunas_ausentes=%s; ", tbl, strings.Join(cols, ",")))
	}
	return sb.String()
}

// ──────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────

// toString converte um valor do PG para string.
func toString(v any) string {
	if v == nil {
		return ""
	}
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	}
}

// toIntStr converte int ou string para string (para IDs).
func toIntStr(v any) string {
	if v == nil {
		return ""
	}
	switch n := v.(type) {
	case int64:
		return strconv.FormatInt(n, 10)
	case int32:
		return strconv.FormatInt(int64(n), 10)
	case int:
		return strconv.Itoa(n)
	case float64:
		return strconv.FormatInt(int64(n), 10)
	}
	return toString(v)
}

// RunLoop chama RunCycle em loop com o intervalo configurado.
// Usado pelo serviço Windows.
func RunLoop(ctx context.Context, cfg *Config) {
	interval := time.Duration(cfg.IntervaloMin) * time.Minute
	logger.Infof("RunLoop: iniciando loop (intervalo=%v)", interval)
	for {
		select {
		case <-ctx.Done():
			logger.Info("RunLoop: encerrando")
			return
		default:
		}
		RunCycle(ctx, cfg)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
