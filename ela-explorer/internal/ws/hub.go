package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"ela-explorer/internal/metrics"

	"nhooyr.io/websocket"
)

// Event types broadcast to clients.
const (
	EventNewBlock     = "newBlock"
	EventNewStats     = "newStats"
	EventMempoolUpdate = "mempoolUpdate"
)

// Message is the wire format for WebSocket events.
type Message struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

// Hub manages WebSocket connections and broadcasts.
type Hub struct {
	mu              sync.RWMutex
	clients         map[*client]bool
	ipCounts        map[string]int
	originPatterns  []string
	maxTotalClients int
	maxClientsPerIP int
}

type client struct {
	conn      *websocket.Conn
	send      chan []byte
	hub       *Hub
	cancel    context.CancelFunc
	closeOnce sync.Once
	ip        string
}

type HubConfig struct {
	CORSOrigins     []string
	MaxTotalClients int
	MaxClientsPerIP int
}

func NewHub(cfg HubConfig) *Hub {
	maxTotal := cfg.MaxTotalClients
	if maxTotal <= 0 {
		maxTotal = 10000
	}
	maxPerIP := cfg.MaxClientsPerIP
	if maxPerIP <= 0 {
		maxPerIP = 20
	}

	var patterns []string
	if len(cfg.CORSOrigins) > 0 {
		patterns = make([]string, 0, len(cfg.CORSOrigins))
		for _, origin := range cfg.CORSOrigins {
			if origin == "*" {
				patterns = append(patterns, "*")
			} else if u, err := url.Parse(origin); err == nil && u.Host != "" {
				patterns = append(patterns, u.Host)
			} else {
				patterns = append(patterns, origin)
			}
		}
	}
	if len(patterns) == 0 {
		patterns = []string{"localhost:*", "127.0.0.1:*"}
	}

	return &Hub{
		clients:         make(map[*client]bool),
		ipCounts:        make(map[string]int),
		originPatterns:  patterns,
		maxTotalClients: maxTotal,
		maxClientsPerIP: maxPerIP,
	}
}

// clientIP returns the real peer IP for rate-limiting and per-IP connection
// caps. We deliberately trust ONLY r.RemoteAddr (post chi middleware.RealIP
// rewrite, so it carries nginx's $remote_addr that nginx set from its trusted
// peer). Reading X-Real-IP / X-Forwarded-For directly here would be
// spoofable — a malicious client could set X-Real-IP to a different value
// on each connection and completely bypass h.maxClientsPerIP. The wrapping
// middleware.RealIP at the /ws entry in api/server.go already resolved the
// headers once, with the trust boundary applied. Don't re-read them here.
func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

// ServeWS handles WebSocket upgrade and manages the connection lifecycle.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)

	h.mu.Lock()
	if len(h.clients) >= h.maxTotalClients {
		h.mu.Unlock()
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	if h.ipCounts[ip] >= h.maxClientsPerIP {
		h.mu.Unlock()
		http.Error(w, "too many connections from this IP", http.StatusTooManyRequests)
		return
	}
	h.mu.Unlock()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.originPatterns,
	})
	if err != nil {
		slog.Warn("websocket accept failed", "error", err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	c := &client{
		conn:   conn,
		send:   make(chan []byte, 256),
		hub:    h,
		cancel: cancel,
		ip:     ip,
	}

	h.mu.Lock()
	h.clients[c] = true
	h.ipCounts[ip]++
	count := len(h.clients)
	h.mu.Unlock()

	metrics.IncWSConnections()
	slog.Info("websocket client connected", "total_clients", count, "ip", ip)

	go c.writePump(ctx)
	c.readPump(ctx)
}

// Broadcast sends an event to all connected clients.
func (h *Hub) Broadcast(event string, data any) {
	msg := Message{Event: event, Data: data}
	payload, err := json.Marshal(msg)
	if err != nil {
		slog.Warn("ws broadcast marshal failed", "error", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.clients {
		select {
		case c.send <- payload:
		default:
			// Client is too slow, disconnect
			go h.removeClient(c)
		}
	}
}

// BroadcastNewBlock emits a newBlock event with all summary fields.
func (h *Hub) BroadcastNewBlock(height int64, hash string, txCount int, timestamp int64, size int, minerInfo, minerAddress string) {
	h.Broadcast(EventNewBlock, map[string]any{
		"height":       height,
		"hash":         hash,
		"txCount":      txCount,
		"timestamp":    timestamp,
		"size":         size,
		"minerinfo":    minerInfo,
		"minerAddress": minerAddress,
	})
}

// BroadcastStats emits periodic stats updates.
func (h *Hub) BroadcastStats(stats map[string]any) {
	h.Broadcast(EventNewStats, stats)
}

// ClientCount returns the number of connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) removeClient(c *client) {
	c.closeOnce.Do(func() {
		h.mu.Lock()
		if _, existed := h.clients[c]; existed {
			delete(h.clients, c)
			close(c.send)
			c.cancel()
			if c.ip != "" {
				h.ipCounts[c.ip]--
				if h.ipCounts[c.ip] <= 0 {
					delete(h.ipCounts, c.ip)
				}
			}
		}
		h.mu.Unlock()

		c.conn.Close(websocket.StatusNormalClosure, "")
		slog.Debug("websocket client disconnected", "remaining", h.ClientCount())
	})
}

func (c *client) readPump(ctx context.Context) {
	defer c.hub.removeClient(c)

	c.conn.SetReadLimit(4096)

	for {
		_, _, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		// We don't process incoming messages from clients;
		// this is a broadcast-only WebSocket.
	}
}

func (c *client) writePump(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			// Ping / keepalive
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
