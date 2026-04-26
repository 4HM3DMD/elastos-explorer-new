package api

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	seoSiteName          = "Elastos Main Chain Explorer"
	seoSiteURL           = "https://explorer.elastos.io"
	seoDefaultDesc       = "Real-time blockchain explorer for the Elastos (ELA) main chain, secured by Bitcoin merged mining."
	seoDefaultOGImage    = "/og-default.png"
	seoPlaceholderJsonLD = "<!--SEO_JSONLD-->"
)

var (
	seoHTMLTemplate string

	reTitle    = regexp.MustCompile(`<title>[^<]*</title>`)
	reMetaDesc = regexp.MustCompile(`<meta name="description" content="[^"]*"`)
	reCanonical = regexp.MustCompile(`<link rel="canonical" href="[^"]*"`)
	reOGTitle  = regexp.MustCompile(`<meta property="og:title" content="[^"]*"`)
	reOGDesc   = regexp.MustCompile(`<meta property="og:description" content="[^"]*"`)
	reOGURL    = regexp.MustCompile(`<meta property="og:url" content="[^"]*"`)
	reOGImage  = regexp.MustCompile(`<meta property="og:image" content="[^"]*"`)
	reTwTitle  = regexp.MustCompile(`<meta name="twitter:title" content="[^"]*"`)
	reTwDesc   = regexp.MustCompile(`<meta name="twitter:description" content="[^"]*"`)
	reTwImage  = regexp.MustCompile(`<meta name="twitter:image" content="[^"]*"`)

	seoPatterns = []struct {
		re     *regexp.Regexp
		lookup func(s *Server, ctx context.Context, matches []string) seoMeta
	}{
		{regexp.MustCompile(`^/block/(.+)$`), lookupBlock},
		{regexp.MustCompile(`^/tx/([0-9a-fA-F]{64})$`), lookupTx},
		{regexp.MustCompile(`^/address/([A-Za-z0-9]+)$`), lookupAddress},
		{regexp.MustCompile(`^/governance/proposal/([0-9a-fA-F]{64})$`), lookupProposal},
		{regexp.MustCompile(`^/validator/([0-9a-fA-F]+)$`), lookupValidator},
		{regexp.MustCompile(`^/staking/([A-Za-z0-9]+)$`), lookupStaker},
	}
	staticSEO = map[string]seoMeta{
		"/":                     {Title: seoSiteName, Desc: "Real-time explorer for the Elastos (ELA) main chain. Browse blocks, transactions, addresses, validators, staking, and governance on the ELA network."},
		"/blocks":               {Title: "Blocks", Desc: "Browse all blocks on the Elastos (ELA) main chain. Real-time block data including height, hash, miner, transactions, and size."},
		"/transactions":         {Title: "Transactions", Desc: "Browse ELA transactions on the Elastos main chain. Filter by type, view transfer details, and track network activity."},
		"/validators":           {Title: "Validators", Desc: "BPoS validators securing the Elastos (ELA) network. View active, inactive, and illegal validators with their vote counts."},
		"/staking":              {Title: "Staking", Desc: "Top ELA stakers on the Elastos network. View staking positions, locked amounts, voting rights, and unclaimed rewards."},
		"/ranking":              {Title: "Rich List", Desc: "Top ELA holders by balance on the Elastos main chain. View address rankings, balances, and distribution of ELA tokens."},
		"/governance":           {Title: "CR Council", Desc: "Cyber Republic council members governing the Elastos network. View council terms, elected members, and voting data."},
		"/governance/proposals": {Title: "CR Proposals", Desc: "Community proposals for Elastos governance. Track proposal status, council votes, budgets, and implementation progress."},
		"/charts":               {Title: "Charts", Desc: "Network activity charts for Elastos (ELA). Daily transactions, volume, fees, active addresses, and block size trends."},
		"/api-docs":             {Title: "API Documentation", Desc: "REST API documentation for the Elastos main chain explorer. Access blocks, transactions, addresses, supply, and governance data."},
	}
)

type seoMeta struct {
	Title  string
	Desc   string
	JsonLD string
}

func InitSEOTemplate(htmlPath string) error {
	data, err := os.ReadFile(htmlPath)
	if err != nil {
		return fmt.Errorf("seo: read template %s: %w", htmlPath, err)
	}
	seoHTMLTemplate = string(data)
	slog.Info("seo: loaded HTML template", "path", htmlPath, "size", len(data))
	return nil
}

func IsSEOTemplateLoaded() bool {
	return seoHTMLTemplate != ""
}

func (s *Server) serveSEO(w http.ResponseWriter, r *http.Request) {
	if seoHTMLTemplate == "" {
		http.Error(w, "SEO template not loaded", http.StatusInternalServerError)
		return
	}

	path := r.URL.Path
	meta := resolveMeta(s, r.Context(), path)

	fullTitle := meta.Title
	if fullTitle != seoSiteName {
		fullTitle = meta.Title + " - " + seoSiteName
	}
	canonicalURL := seoSiteURL + path
	imageURL := seoSiteURL + seoDefaultOGImage

	escapedTitle := html.EscapeString(fullTitle)
	escapedDesc := html.EscapeString(meta.Desc)
	escapedURL := html.EscapeString(canonicalURL)
	escapedImage := html.EscapeString(imageURL)

	result := seoHTMLTemplate
	result = reTitle.ReplaceAllLiteralString(result, "<title>"+escapedTitle+"</title>")
	result = reMetaDesc.ReplaceAllLiteralString(result, `<meta name="description" content="`+escapedDesc+`"`)
	result = reCanonical.ReplaceAllLiteralString(result, `<link rel="canonical" href="`+escapedURL+`"`)
	result = reOGTitle.ReplaceAllLiteralString(result, `<meta property="og:title" content="`+escapedTitle+`"`)
	result = reOGDesc.ReplaceAllLiteralString(result, `<meta property="og:description" content="`+escapedDesc+`"`)
	result = reOGURL.ReplaceAllLiteralString(result, `<meta property="og:url" content="`+escapedURL+`"`)
	result = reOGImage.ReplaceAllLiteralString(result, `<meta property="og:image" content="`+escapedImage+`"`)
	result = reTwTitle.ReplaceAllLiteralString(result, `<meta name="twitter:title" content="`+escapedTitle+`"`)
	result = reTwDesc.ReplaceAllLiteralString(result, `<meta name="twitter:description" content="`+escapedDesc+`"`)
	result = reTwImage.ReplaceAllLiteralString(result, `<meta name="twitter:image" content="`+escapedImage+`"`)
	if meta.JsonLD != "" {
		result = strings.ReplaceAll(result, seoPlaceholderJsonLD, meta.JsonLD)
	} else {
		result = strings.ReplaceAll(result, seoPlaceholderJsonLD, "")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60, s-maxage=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(result))
}

func resolveMeta(s *Server, ctx context.Context, path string) seoMeta {
	if m, ok := staticSEO[path]; ok {
		return m
	}
	for _, p := range seoPatterns {
		if matches := p.re.FindStringSubmatch(path); matches != nil {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			return p.lookup(s, ctx, matches)
		}
	}
	return seoMeta{Title: seoSiteName, Desc: seoDefaultDesc}
}

func lookupBlock(s *Server, ctx context.Context, matches []string) seoMeta {
	heightOrHash := matches[1]
	var height int64
	var txCount int
	var ts int64

	if h, err := strconv.ParseInt(heightOrHash, 10, 64); err == nil {
		err = s.db.API.QueryRow(ctx,
			`SELECT height, tx_count, timestamp FROM blocks WHERE height = $1`, h,
		).Scan(&height, &txCount, &ts)
		if err != nil {
			return seoMeta{Title: fmt.Sprintf("Block %s", heightOrHash), Desc: "Block details on the Elastos main chain."}
		}
	} else {
		err := s.db.API.QueryRow(ctx,
			`SELECT height, tx_count, timestamp FROM blocks WHERE hash = $1`, heightOrHash,
		).Scan(&height, &txCount, &ts)
		if err != nil {
			return seoMeta{Title: "Block Details", Desc: "Block details on the Elastos main chain."}
		}
	}

	title := fmt.Sprintf("Block #%s", fmtNumber(height))
	desc := fmt.Sprintf("Block %s on the Elastos (ELA) main chain with %d transactions.", fmtNumber(height), txCount)
	jsonLD := fmt.Sprintf(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dataset","name":"Elastos Block %s","description":"%s","url":"%s/block/%s"}</script>`,
		fmtNumber(height), desc, seoSiteURL, heightOrHash)
	return seoMeta{Title: title, Desc: desc, JsonLD: jsonLD}
}

func lookupTx(s *Server, ctx context.Context, matches []string) seoMeta {
	txid := matches[1]
	var blockHeight int64
	var typeName string

	err := s.db.API.QueryRow(ctx,
		`SELECT block_height, type_name FROM transactions WHERE txid = $1`, txid,
	).Scan(&blockHeight, &typeName)
	if err != nil {
		return seoMeta{Title: fmt.Sprintf("Transaction %s...%s", txid[:10], txid[58:]), Desc: "Transaction details on the Elastos main chain."}
	}

	short := txid[:10] + "..." + txid[58:]
	title := fmt.Sprintf("Transaction %s", short)
	desc := fmt.Sprintf("ELA transaction %s in block #%s. Type: %s.", short, fmtNumber(blockHeight), typeName)
	return seoMeta{Title: title, Desc: desc}
}

func lookupAddress(s *Server, ctx context.Context, matches []string) seoMeta {
	addr := matches[1]
	var balanceSela int64
	var txCount int64

	// Real table is `address_balances`, balance column is `balance_sela`
	// (int64 sela, not float ELA). Tx count lives in `address_tx_counts`,
	// joined here so a single query gives us both. The previous version
	// queried a non-existent `addresses` table and silently fell through
	// to the generic fallback on every address-page social share.
	err := s.db.API.QueryRow(ctx, `
		SELECT COALESCE(ab.balance_sela, 0), COALESCE(tc.tx_count, 0)
		FROM address_balances ab
		LEFT JOIN address_tx_counts tc ON tc.address = ab.address
		WHERE ab.address = $1`, addr,
	).Scan(&balanceSela, &txCount)
	if err != nil {
		short := addr
		if len(addr) > 16 {
			short = addr[:10] + "..." + addr[len(addr)-6:]
		}
		return seoMeta{Title: fmt.Sprintf("Address %s", short), Desc: fmt.Sprintf("Elastos address details for %s.", short)}
	}

	short := addr
	if len(addr) > 16 {
		short = addr[:10] + "..." + addr[len(addr)-6:]
	}
	balStr := fmt.Sprintf("%.4f", float64(balanceSela)/1e8)
	title := fmt.Sprintf("Address %s", short)
	desc := fmt.Sprintf("Elastos (ELA) address %s with balance %s ELA. %d transactions.", short, balStr, txCount)
	return seoMeta{Title: title, Desc: desc}
}

func lookupProposal(s *Server, ctx context.Context, matches []string) seoMeta {
	hash := matches[1]
	var title string
	var status string
	var voteCount, rejectCount int

	err := s.db.API.QueryRow(ctx,
		`SELECT COALESCE(title, ''), status, vote_count, reject_count FROM cr_proposals WHERE proposal_hash = $1`, hash,
	).Scan(&title, &status, &voteCount, &rejectCount)
	if err != nil {
		return seoMeta{Title: "Proposal Details", Desc: "CR proposal details on the Elastos network."}
	}

	if title == "" {
		title = "Untitled Proposal"
	}
	seoTitle := title
	desc := fmt.Sprintf("CR proposal on Elastos: %s. Status: %s. %d support, %d reject.", title, status, voteCount, rejectCount)
	return seoMeta{Title: seoTitle, Desc: desc}
}

func lookupValidator(s *Server, ctx context.Context, matches []string) seoMeta {
	pubKey := matches[1]
	var nickname string
	var votesSela int64

	// Two columns names were wrong here: `dpos_v2_votes` doesn't exist
	// (real column is `dposv2_votes_sela`) and `owner_public_key`
	// doesn't exist (real column is `owner_pubkey`). The query failed
	// on every validator-page request, falling through to the generic
	// "Validator Details" SEO fallback. Now reads the actual sela value
	// and converts to ELA via selaToELA() so the meta shows accurate
	// vote totals.
	err := s.db.API.QueryRow(ctx,
		`SELECT nickname, COALESCE(dposv2_votes_sela, 0) FROM producers WHERE owner_pubkey = $1`, pubKey,
	).Scan(&nickname, &votesSela)
	if err != nil {
		return seoMeta{Title: "Validator Details", Desc: "Validator details on the Elastos network."}
	}

	title := fmt.Sprintf("Validator %s", nickname)
	desc := fmt.Sprintf("%s on the Elastos (ELA) network with %s ELA in votes.", nickname, selaToELA(votesSela))
	return seoMeta{Title: title, Desc: desc}
}

func lookupStaker(s *Server, ctx context.Context, matches []string) seoMeta {
	addr := matches[1]
	short := addr
	if len(addr) > 16 {
		short = addr[:10] + "..." + addr[len(addr)-6:]
	}
	return seoMeta{
		Title: fmt.Sprintf("Staking for %s", short),
		Desc:  fmt.Sprintf("Staking positions and voting rights for Elastos (ELA) address %s.", short),
	}
}

func fmtNumber(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
	}
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
