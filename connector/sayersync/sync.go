// sync.go — ciclo de sincronização SayerSystem → tint-sync-agent.
//
// RunCycle executa um único ciclo completo:
//  1. Conecta ao PostgreSQL local
//  2. Valida o schema (fail-closed se divergir)
//  3. Para cada entidade, extrai o delta desde o HWM - 5min e envia em lotes ≤1000
//  4. Diariamente: envia um keys-snapshot de todas as fórmulas
//  5. Toda segunda-feira de madrugada: full re-scan (ignora HWM)
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
	ExtractAllFormulasForSnapshot(ctx context.Context) (formulas []formulaKey, err error)

	// OriginNow retorna o now() do PostgreSQL de origem (para comparações de data).
	OriginNow(ctx context.Context) (time.Time, error)
}

// formulaKey é a chave de uma fórmula para o keys-snapshot.
type formulaKey struct {
	CorID        string
	CodProduto   string
	IDBase       string
	IDEmb        string
	Personalizada bool
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
	return extractAllFormulasForSnapshot(ctx, p.db)
}

func (p *pgExtractor) OriginNow(ctx context.Context) (time.Time, error) {
	var t time.Time
	row := p.db.QueryRowContext(ctx, `SELECT now()`)
	if err := row.Scan(&t); err != nil {
		return time.Time{}, fmt.Errorf("OriginNow: %w", err)
	}
	return t, nil
}

// extractAllFormulasForSnapshot extrai as chaves de TODAS as fórmulas (formula + formulaperson)
// para o keys-snapshot. Sem filtro de HWM (snapshot completo).
func extractAllFormulasForSnapshot(ctx context.Context, db *sql.DB) ([]formulaKey, error) {
	// formula = padrão (personalizada = false)
	rows1, err := db.QueryContext(ctx, `
		SELECT id_padraocor::text, id_produto::text, id_base::text, id_emb::text
		FROM formula
		ORDER BY id_padraocor
	`)
	if err != nil {
		return nil, fmt.Errorf("extractAllFormulasForSnapshot formula: %w", err)
	}
	defer rows1.Close()

	var out []formulaKey
	for rows1.Next() {
		var cor, prod, base, emb string
		if err := rows1.Scan(&cor, &prod, &base, &emb); err != nil {
			return nil, err
		}
		out = append(out, formulaKey{CorID: cor, CodProduto: prod, IDBase: base, IDEmb: emb, Personalizada: false})
	}
	if err := rows1.Err(); err != nil {
		return nil, err
	}

	// formulaperson = personalizada (personalizada = true)
	rows2, err := db.QueryContext(ctx, `
		SELECT id_padraocor::text, id_produto::text, id_base::text, id_emb::text
		FROM formulaperson
		ORDER BY id_padraocor
	`)
	if err != nil {
		return nil, fmt.Errorf("extractAllFormulasForSnapshot formulaperson: %w", err)
	}
	defer rows2.Close()

	for rows2.Next() {
		var cor, prod, base, emb string
		if err := rows2.Scan(&cor, &prod, &base, &emb); err != nil {
			return nil, err
		}
		out = append(out, formulaKey{CorID: cor, CodProduto: prod, IDBase: base, IDEmb: emb, Personalizada: true})
	}
	return out, rows2.Err()
}

// ──────────────────────────────────────────────────────────────
// RunCycle — ciclo de sync principal
// ──────────────────────────────────────────────────────────────

// RunCycle executa um ciclo completo de sync.
// Se o schema divergir, grava sayersystem-schema.txt e envia heartbeat com schema_mismatch.
func RunCycle(ctx context.Context, cfg *Config) {
	// Carrega estado persistido.
	st, err := LoadState()
	if err != nil {
		logger.Errorf("RunCycle: falha ao carregar state: %v", err)
		st = &State{HWM: make(map[string]string)}
	}

	// Conecta ao PG.
	db, err := Connect(ctx, cfg.PGConn)
	if err != nil {
		logger.Errorf("RunCycle: falha ao conectar ao PG: %v", err)
		sendHeartbeatBestEffort(ctx, cfg, st, false, "", "")
		return
	}
	defer db.Close()

	// Valida schema.
	rm, diff, err := Validate(ctx, db)
	if err != nil {
		logger.Errorf("RunCycle: erro ao validar schema: %v", err)
		sendHeartbeatBestEffort(ctx, cfg, st, true, "", "")
		return
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
		return
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

	// Determina se é necessário full re-scan (toda segunda-feira, uma vez por semana).
	needFullRescan := shouldFullRescan(st, originNow)
	if needFullRescan {
		logger.Infof("RunCycle: iniciando full re-scan semanal (segunda-feira)")
		clearAllHWM(st)
	}

	// Executa ciclo de sync por entidade.
	counts, syncErr := runEntityCycles(ctx, cfg, ex, rm, st, db)
	if syncErr != nil {
		logger.Errorf("RunCycle: erro durante sync de entidades: %v", syncErr)
	}

	// Marca full re-scan como concluído (mesmo com erros parciais — o HWM foi zerado).
	if needFullRescan {
		st.LastFullRescan = originNow.Format(time.RFC3339)
	}

	// Keys-snapshot diário.
	if shouldKeysSnapshot(st, originNow) {
		if snapErr := sendKeysSnapshot(ctx, cfg, ex, originNow); snapErr != nil {
			logger.Errorf("RunCycle: falha no keys-snapshot: %v", snapErr)
		} else {
			st.LastKeysSnapshot = originNow.Format(time.RFC3339)
		}
	}

	// Persiste estado.
	if saveErr := SaveState(st); saveErr != nil {
		logger.Errorf("RunCycle: falha ao salvar state: %v", saveErr)
	}

	// Heartbeat final.
	token, _ := cfg.Token()
	if token != "" {
		cli := NewClient(cfg.AppURL, token, cfg.StoreCode)
		hb := buildHeartbeat(st, true, fp, "")
		hb.LastCycleCounts = counts
		if hbErr := cli.Heartbeat(ctx, hb); hbErr != nil {
			logger.Warnf("RunCycle: falha ao enviar heartbeat: %v", hbErr)
		}
	}

	logger.Infof("RunCycle: concluído — %v", counts)
}

// runEntityCycles itera sobre todas as entidades e envia os deltas ao servidor.
// Retorna os contadores de registros enviados por entidade.
func runEntityCycles(
	ctx context.Context,
	cfg *Config,
	ex Extractor,
	rm *ResolvedMapping,
	st *State,
	db *sql.DB,
) (map[string]int, error) {
	token, err := cfg.Token()
	if err != nil || token == "" {
		return nil, fmt.Errorf("runEntityCycles: falha ao obter token: %v", err)
	}
	cli := NewClient(cfg.AppURL, token, cfg.StoreCode)

	counts := make(map[string]int)

	// ──────────────────────────────────────────────────────────────
	// Catálogos: produto, base, embalagens, produto_base_embalagem,
	//            corantes (merged com preco_corante), preco_baseemb
	// ──────────────────────────────────────────────────────────────

	// produto → campo "produtos" no payload /catalogs
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "produto", "produtos", mapProduto); err != nil {
		logger.Warnf("sync produto: %v", err)
	}

	// base → "bases"
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "base", "bases", mapBase); err != nil {
		logger.Warnf("sync base: %v", err)
	}

	// embalagens → "embalagens"
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "embalagens", "embalagens", mapEmbalagem); err != nil {
		logger.Warnf("sync embalagens: %v", err)
	}

	// produto_base_embalagem → "skus"
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "produto_base_embalagem", "skus", mapSku); err != nil {
		logger.Warnf("sync produto_base_embalagem: %v", err)
	}

	// corantes merged com preco_corante → "corantes" + "precos_base" serão separados abaixo
	if err := syncCorantes(ctx, ex, cli, st, counts, rm); err != nil {
		logger.Warnf("sync corantes: %v", err)
	}

	// preco_baseemb → "precos_base"
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "preco_baseemb", "precos_base", mapPrecoBaseEmb); err != nil {
		logger.Warnf("sync preco_baseemb: %v", err)
	}

	// ──────────────────────────────────────────────────────────────
	// Auxiliares de fórmulas: padracor, colecao, subcolecao
	// (padracor / personcor são LOOKUP pelas fórmulas — enviados como catálogo de cores)
	// ──────────────────────────────────────────────────────────────

	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "padracor", "padracores", mapPadracor); err != nil {
		logger.Warnf("sync padracor: %v", err)
	}

	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "colecao", "colecoes", mapColecao); err != nil {
		logger.Warnf("sync colecao: %v", err)
	}

	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "subcolecao", "subcolecoes", mapSubcolecao); err != nil {
		logger.Warnf("sync subcolecao: %v", err)
	}

	// ──────────────────────────────────────────────────────────────
	// Fórmulas: formula (personalizada=false) + personcor (lookup)
	//           formulaperson (personalizada=true)
	// ──────────────────────────────────────────────────────────────

	// personcor: lookup de nomes para fórmulas personalizadas
	if err := syncSimpleEntity(ctx, ex, cli, st, counts, rm, "personcor", "personcores", mapPersoncor); err != nil {
		logger.Warnf("sync personcor: %v", err)
	}

	// formula (padrão)
	if err := syncFormulas(ctx, ex, cli, st, counts, rm, db, false); err != nil {
		logger.Warnf("sync formula: %v", err)
	}

	// formulaperson (personalizada)
	if err := syncFormulas(ctx, ex, cli, st, counts, rm, db, true); err != nil {
		logger.Warnf("sync formulaperson: %v", err)
	}

	return counts, nil
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

	// Extrai preco_corante (lookup de custo/volume por id_corante).
	hwmPreco := hwmFromState(st, "preco_corante")
	rowsPreco, maxDAPreco, err := ex.Extract(ctx, "preco_corante", hwmPreco)
	if err != nil {
		return fmt.Errorf("syncCorantes: extract preco_corante: %w", err)
	}

	// Constrói lookup de preços: id_corante → {custo, volume_ml}
	type precoInfo struct {
		custo    float64
		volumeML float64
	}
	precoMap := make(map[string]precoInfo, len(rowsPreco))
	for _, row := range rowsPreco {
		id := toString(row["id_corante"])
		if id == "" {
			continue
		}
		precoMap[id] = precoInfo{
			custo:    toFloat64(row["custo"]),
			volumeML: toFloat64(row["volume_ml"]),
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
		if p, ok := precoMap[id]; ok {
			m["custo"] = p.custo
			m["volume_ml"] = p.volumeML
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
		// Envia somente o id + preços (servidor faz upsert parcial).
		p := precoMap[id]
		merged = append(merged, map[string]any{
			"id_corante": id,
			"custo":      p.custo,
			"volume_ml":  p.volumeML,
		})
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
func syncFormulas(
	ctx context.Context,
	ex Extractor,
	cli *Client,
	st *State,
	counts map[string]int,
	rm *ResolvedMapping,
	db *sql.DB,
	personalizada bool,
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
	rows, maxDA, err := ex.Extract(ctx, entity, hwm)
	if err != nil {
		return fmt.Errorf("syncFormulas %s: extract: %w", entity, err)
	}
	if len(rows) == 0 {
		return nil
	}

	// Para shape=child: enriquece com itens da tabela filha.
	var childItems map[string][]map[string]any
	if rm.FormulaShape == FormulaShapeChild {
		childItems, err = ExtractFormulaChildItems(ctx, db)
		if err != nil {
			return fmt.Errorf("syncFormulas %s: ExtractFormulaChildItems: %w", entity, err)
		}
	}

	// Mapeia linhas para o contrato do servidor.
	mapped := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		m := mapFormula(row, personalizada)
		if m == nil {
			continue
		}
		// Para shape=child: injeta os itens.
		if rm.FormulaShape == FormulaShapeChild {
			idFormula := toString(row["id_padraocor"]) // chave de junção
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
		mapped = append(mapped, m)
	}
	if len(mapped) == 0 {
		advanceHWM(st, entity, maxDA)
		return nil
	}

	if err := sendInBatches(ctx, cli, "/formulas", "formulas", mapped, entity, st, maxDA); err != nil {
		return err
	}

	counts[entity] += len(mapped)
	return nil
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
// Critério: dia é segunda-feira (weekday==Monday) E a semana ISO do último re-scan
// é diferente da semana atual.
func shouldFullRescan(st *State, originNow time.Time) bool {
	if originNow.Weekday() != time.Monday {
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
// Formato de cada linha: "cor_id|cod_produto|id_base|id_emb|personalizada".
// Enviado em chunks de ≤50000 linhas.
func sendKeysSnapshot(
	ctx context.Context,
	cfg *Config,
	ex Extractor,
	originNow time.Time,
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

	// Serializa as chaves como strings "cor_id|cod_produto|id_base|id_emb|personalizada".
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		personStr := "false"
		if k.Personalizada {
			personStr = "true"
		}
		lines = append(lines, fmt.Sprintf("%s|%s|%s|%s|%s",
			k.CorID, k.CodProduto, k.IDBase, k.IDEmb, personStr))
	}

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
		var chunk []string
		if start < len(lines) {
			chunk = lines[start:end]
		}

		isLast := chunkIdx == totalChunks-1
		payload := map[string]any{
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
		logger.Infof("sendKeysSnapshot: chunk %d/%d enviado (%d chaves)", chunkIdx+1, totalChunks, len(chunk))
	}

	return nil
}

// ──────────────────────────────────────────────────────────────
// Mapeadores de linha (PG row → contrato do servidor)
// ──────────────────────────────────────────────────────────────

func mapProduto(row map[string]any) map[string]any {
	id := toString(row["id_produto"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_produto": id,
		"descricao":  toString(row["descricao"]),
	}
}

func mapBase(row map[string]any) map[string]any {
	id := toString(row["id_base"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_base":   id,
		"descricao": toString(row["descricao"]),
	}
}

func mapEmbalagem(row map[string]any) map[string]any {
	id := toString(row["id_emb"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_emb":    id,
		"descricao": toString(row["descricao"]),
		"volume_ml": toFloat64(row["volume_ml"]),
	}
}

func mapSku(row map[string]any) map[string]any {
	prod := toString(row["id_produto"])
	base := toString(row["id_base"])
	emb := toString(row["id_emb"])
	if prod == "" || base == "" || emb == "" {
		return nil
	}
	return map[string]any{
		"id_produto": prod,
		"id_base":    base,
		"id_emb":     emb,
	}
}

func mapCorante(row map[string]any) map[string]any {
	id := toString(row["id_corante"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_corante": id,
		"descricao":  toString(row["descricao"]),
	}
}

func mapPrecoBaseEmb(row map[string]any) map[string]any {
	prod := toString(row["id_produto"])
	base := toString(row["id_base"])
	emb := toString(row["id_emb"])
	if prod == "" || base == "" || emb == "" {
		return nil
	}
	return map[string]any{
		"id_produto": prod,
		"id_base":    base,
		"id_emb":     emb,
		"custo":      toFloat64(row["custo"]),
		"imposto":    toFloat64(row["imposto"]),
		"margem":     toFloat64(row["margem"]),
	}
}

func mapPadracor(row map[string]any) map[string]any {
	id := toString(row["id_padraocor"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_padraocor": id,
		"descricao":    toString(row["descricao"]),
	}
}

func mapColecao(row map[string]any) map[string]any {
	id := toString(row["id_colecao"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_colecao": id,
		"descricao":  toString(row["descricao"]),
	}
}

func mapSubcolecao(row map[string]any) map[string]any {
	id := toString(row["id_subcolecao"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_subcolecao": id,
		"id_colecao":    toString(row["id_colecao"]),
		"descricao":     toString(row["descricao"]),
	}
}

func mapPersoncor(row map[string]any) map[string]any {
	id := toString(row["id_padraocor"])
	if id == "" {
		return nil
	}
	return map[string]any{
		"id_padraocor": id,
		"descricao":    toString(row["descricao"]),
	}
}

func mapFormula(row map[string]any, personalizada bool) map[string]any {
	cor := toString(row["id_padraocor"])
	if cor == "" {
		return nil
	}
	m := map[string]any{
		"id_padraocor":  cor,
		"id_produto":    toString(row["id_produto"]),
		"id_base":       toString(row["id_base"]),
		"id_emb":        toString(row["id_emb"]),
		"personalizada": personalizada,
	}
	if sub := toString(row["id_subcolecao"]); sub != "" {
		m["id_subcolecao"] = sub
	}
	if emb := toString(row["id_embalagem"]); emb != "" {
		m["id_embalagem"] = emb
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
