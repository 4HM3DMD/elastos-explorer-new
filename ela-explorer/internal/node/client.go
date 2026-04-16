package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type Client struct {
	url      string
	user     string
	pass     string
	client   *http.Client
	reqID    atomic.Int64

	// Circuit breaker
	mu            sync.Mutex
	failures      int
	lastFailure   time.Time
	circuitOpen   bool
	halfOpenProbe atomic.Bool
	maxFailures   int
	resetTimeout  time.Duration
}

func NewClient(url, user, pass string) *Client {
	return &Client{
		url:  url,
		user: user,
		pass: pass,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		maxFailures:  5,
		resetTimeout: 10 * time.Second,
	}
}

// callObject sends an RPC request with named (object) params instead of positional array.
func (c *Client) callObject(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	return c.callRaw(ctx, method, params)
}

func (c *Client) call(ctx context.Context, method string, params ...any) (json.RawMessage, error) {
	var p any
	if len(params) == 0 || params == nil {
		p = map[string]any{}
	} else if len(params) == 1 {
		if m, ok := params[0].(map[string]any); ok {
			p = m
		} else {
			p = params
		}
	} else {
		p = params
	}
	return c.callRaw(ctx, method, p)
}

func (c *Client) callRaw(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c.isCircuitOpen() {
		return nil, fmt.Errorf("circuit breaker open for ELA node RPC")
	}

	id := c.reqID.Add(1)
	reqBody := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal RPC request: %w", err)
	}

	var lastErr error
	retryDelays := []time.Duration{100 * time.Millisecond, 500 * time.Millisecond, 2 * time.Second}

	for attempt := 0; attempt <= len(retryDelays); attempt++ {
		if attempt > 0 {
			delay := retryDelays[attempt-1]
			jitter := time.Duration(rand.Int63n(int64(delay / 4)))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay + jitter):
			}
		}

		result, err := c.doRequest(ctx, body)
		if err == nil {
			c.recordSuccess()
			return result, nil
		}
		lastErr = err

		var rpcErr *RPCError
		if errors.As(err, &rpcErr) && rpcErr.IsNotFound() {
			return nil, err
		}

		slog.Warn("RPC call failed, retrying",
			"method", method,
			"attempt", attempt+1,
			"error", err,
		)
	}

	c.recordFailure()
	return nil, fmt.Errorf("RPC %s failed after retries: %w", method, lastErr)
}

func (c *Client) doRequest(ctx context.Context, body []byte) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.user != "" {
		req.SetBasicAuth(c.user, c.pass)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50*1024*1024)) // 50MB max
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody[:min(len(respBody), 200)]))
	}

	var rpcResp RPCResponse
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	if rpcResp.Error != nil {
		return nil, rpcResp.Error
	}

	return rpcResp.Result, nil
}

// Circuit breaker methods

func (c *Client) isCircuitOpen() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.circuitOpen {
		return false
	}
	if time.Since(c.lastFailure) > c.resetTimeout {
		// Half-open: allow exactly one probe request via CAS
		if c.halfOpenProbe.CompareAndSwap(false, true) {
			return false
		}
		return true
	}
	return true
}

func (c *Client) recordSuccess() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures = 0
	c.circuitOpen = false
	c.halfOpenProbe.Store(false)
}

func (c *Client) recordFailure() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures++
	c.lastFailure = time.Now()
	c.halfOpenProbe.Store(false)
	if c.failures >= c.maxFailures {
		c.circuitOpen = true
		slog.Error("circuit breaker OPEN for ELA node RPC", "failures", c.failures)
	}
}

// --- Public RPC Methods ---

func (c *Client) GetBlockCount(ctx context.Context) (int64, error) {
	result, err := c.call(ctx, "getblockcount")
	if err != nil {
		return 0, err
	}
	var height int64
	if err := json.Unmarshal(result, &height); err != nil {
		return 0, fmt.Errorf("parse getblockcount: %w", err)
	}
	return height, nil
}

func (c *Client) GetBlockByHeight(ctx context.Context, height int64) (*BlockInfo, error) {
	result, err := c.call(ctx, "getblockbyheight", height)
	if err != nil {
		return nil, err
	}
	var block BlockInfo
	if err := json.Unmarshal(result, &block); err != nil {
		return nil, fmt.Errorf("parse getblockbyheight(%d): %w", height, err)
	}
	return &block, nil
}

func (c *Client) GetBlockHash(ctx context.Context, height int64) (string, error) {
	result, err := c.call(ctx, "getblockhash", height)
	if err != nil {
		return "", err
	}
	var hash string
	if err := json.Unmarshal(result, &hash); err != nil {
		return "", fmt.Errorf("parse getblockhash: %w", err)
	}
	return hash, nil
}

func (c *Client) GetRawTransaction(ctx context.Context, txid string) (*TransactionInfo, error) {
	result, err := c.call(ctx, "getrawtransaction", txid, true)
	if err != nil {
		return nil, err
	}
	var tx TransactionInfo
	if err := json.Unmarshal(result, &tx); err != nil {
		return nil, fmt.Errorf("parse getrawtransaction: %w", err)
	}
	return &tx, nil
}

func (c *Client) GetConfirmByHeight(ctx context.Context, height int64) (*ConfirmInfo, error) {
	result, err := c.callObject(ctx, "getconfirmbyheight", map[string]any{
		"height":     height,
		"verboselvl": 1,
	})
	if err != nil {
		return nil, err
	}
	var confirm ConfirmInfo
	if err := json.Unmarshal(result, &confirm); err != nil {
		return nil, fmt.Errorf("parse getconfirmbyheight: %w", err)
	}
	return &confirm, nil
}

func (c *Client) ListProducers(ctx context.Context, start, limit int, state string) (*ProducersResponse, error) {
	params := map[string]any{"start": start, "limit": limit}
	if state != "" {
		params["state"] = state
	}
	result, err := c.call(ctx, "listproducers", params)
	if err != nil {
		return nil, err
	}
	var resp ProducersResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse listproducers: %w", err)
	}
	return &resp, nil
}

func (c *Client) GetArbitersInfo(ctx context.Context) (*ArbitersInfo, error) {
	result, err := c.call(ctx, "getarbitersinfo")
	if err != nil {
		return nil, err
	}
	var info ArbitersInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return nil, fmt.Errorf("parse getarbitersinfo: %w", err)
	}
	return &info, nil
}

func (c *Client) GetDPosV2Info(ctx context.Context) (*DPosV2Info, error) {
	result, err := c.call(ctx, "getdposv2info")
	if err != nil {
		return nil, err
	}
	var info DPosV2Info
	if err := json.Unmarshal(result, &info); err != nil {
		return nil, fmt.Errorf("parse getdposv2info: %w", err)
	}
	return &info, nil
}

func (c *Client) GetMiningInfo(ctx context.Context) (*MiningInfo, error) {
	result, err := c.call(ctx, "getmininginfo")
	if err != nil {
		return nil, err
	}
	var info MiningInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return nil, fmt.Errorf("parse getmininginfo: %w", err)
	}
	return &info, nil
}

func (c *Client) GetCRRelatedStage(ctx context.Context) (*CRRelatedStageResponse, error) {
	result, err := c.call(ctx, "getcrrelatedstage")
	if err != nil {
		return nil, err
	}
	var resp CRRelatedStageResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse getcrrelatedstage: %w", err)
	}
	return &resp, nil
}

func (c *Client) ListCurrentCRs(ctx context.Context) (*CRMembersResponse, error) {
	result, err := c.call(ctx, "listcurrentcrs", map[string]any{"state": "all"})
	if err != nil {
		return nil, err
	}
	var resp CRMembersResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse listcurrentcrs: %w", err)
	}
	return &resp, nil
}

func (c *Client) ListCRCandidates(ctx context.Context, start, limit int, state string) (*CRCandidatesResponse, error) {
	params := map[string]any{"start": start, "limit": limit}
	if state != "" {
		params["state"] = state
	}
	result, err := c.call(ctx, "listcrcandidates", params)
	if err != nil {
		return nil, err
	}
	var resp CRCandidatesResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse listcrcandidates: %w", err)
	}
	return &resp, nil
}

func (c *Client) ListCRProposalBaseState(ctx context.Context, start, limit int, state string) (*ProposalBaseStateResponse, error) {
	result, err := c.callObject(ctx, "listcrproposalbasestate", map[string]any{
		"start": start, "limit": limit, "state": state,
	})
	if err != nil {
		return nil, err
	}
	var resp ProposalBaseStateResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse listcrproposalbasestate: %w", err)
	}
	return &resp, nil
}

func (c *Client) GetCRProposalState(ctx context.Context, proposalHash string) (*ProposalStateResponse, error) {
	result, err := c.callObject(ctx, "getcrproposalstate", map[string]any{"proposalhash": proposalHash})
	if err != nil {
		return nil, err
	}
	var resp ProposalStateResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("parse getcrproposalstate: %w", err)
	}
	return &resp, nil
}

// GetProposalDraftData fetches the hex-encoded draft data ZIP for a proposal.
// The caller must hex-decode, unzip, and read proposal.json from the archive.
func (c *Client) GetProposalDraftData(ctx context.Context, draftHash string) (string, error) {
	result, err := c.callObject(ctx, "getproposaldraftdata", map[string]any{"drafthash": draftHash})
	if err != nil {
		return "", err
	}
	var hex string
	if err := json.Unmarshal(result, &hex); err != nil {
		return "", fmt.Errorf("parse getproposaldraftdata: %w", err)
	}
	return hex, nil
}

func (c *Client) GetReceivedByAddress(ctx context.Context, address string) (string, error) {
	result, err := c.call(ctx, "getreceivedbyaddress", address)
	if err != nil {
		return "", err
	}
	var balance string
	if err := json.Unmarshal(result, &balance); err != nil {
		return "", fmt.Errorf("parse getreceivedbyaddress: %w", err)
	}
	return balance, nil
}

func (c *Client) GetTransactionPool(ctx context.Context) ([]TransactionInfo, error) {
	result, err := c.call(ctx, "getrawmempool", map[string]any{"state": "all"})
	if err != nil {
		return nil, err
	}
	var txs []TransactionInfo
	if err := json.Unmarshal(result, &txs); err != nil {
		// Some node versions return string txids instead of full objects
		var txids []string
		if err2 := json.Unmarshal(result, &txids); err2 == nil {
			for _, id := range txids {
				txs = append(txs, TransactionInfo{TxID: id})
			}
			return txs, nil
		}
		return nil, fmt.Errorf("parse getrawmempool: %w", err)
	}
	return txs, nil
}

func (c *Client) GetConnectionCount(ctx context.Context) (int, error) {
	result, err := c.call(ctx, "getconnectioncount")
	if err != nil {
		return 0, err
	}
	var count int
	if err := json.Unmarshal(result, &count); err != nil {
		return 0, fmt.Errorf("parse getconnectioncount: %w", err)
	}
	return count, nil
}

func (c *Client) GetAllDetailedDPoSV2Votes(ctx context.Context, start, limit int) ([]DetailedDPoSV2Vote, error) {
	result, err := c.call(ctx, "getalldetaileddposv2votes", map[string]any{
		"start": start, "limit": limit,
	})
	if err != nil {
		return nil, err
	}
	var votes []DetailedDPoSV2Vote
	if err := json.Unmarshal(result, &votes); err != nil {
		return nil, fmt.Errorf("parse getalldetaileddposv2votes: %w", err)
	}
	return votes, nil
}

func (c *Client) DPosV2RewardInfo(ctx context.Context, address string) (*DPoSV2RewardInfo, error) {
	var params map[string]any
	if address != "" {
		params = map[string]any{"address": address}
	}
	result, err := c.call(ctx, "dposv2rewardinfo", params)
	if err != nil {
		return nil, err
	}
	var info DPoSV2RewardInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return nil, fmt.Errorf("parse dposv2rewardinfo: %w", err)
	}
	return &info, nil
}

func (c *Client) GetAllDPoSV2RewardInfo(ctx context.Context) ([]DPoSV2RewardInfo, error) {
	result, err := c.call(ctx, "dposv2rewardinfo")
	if err != nil {
		return nil, err
	}
	var infos []DPoSV2RewardInfo
	if err := json.Unmarshal(result, &infos); err != nil {
		return nil, fmt.Errorf("parse dposv2rewardinfo (all): %w", err)
	}
	return infos, nil
}

func (c *Client) SendRawTransaction(ctx context.Context, rawTx string) (string, error) {
	result, err := c.call(ctx, "sendrawtransaction", rawTx)
	if err != nil {
		return "", err
	}
	var txid string
	if err := json.Unmarshal(result, &txid); err != nil {
		return "", fmt.Errorf("parse sendrawtransaction: %w", err)
	}
	return txid, nil
}

func (c *Client) GetNodeState(ctx context.Context) (*NodeState, error) {
	result, err := c.call(ctx, "getnodestate")
	if err != nil {
		return nil, err
	}
	var state NodeState
	if err := json.Unmarshal(result, &state); err != nil {
		return nil, fmt.Errorf("parse getnodestate: %w", err)
	}
	return &state, nil
}

// CallRaw exposes raw RPC calls for the wallet proxy endpoint.
func (c *Client) CallRaw(ctx context.Context, method string, params ...any) (json.RawMessage, error) {
	return c.call(ctx, method, params...)
}
