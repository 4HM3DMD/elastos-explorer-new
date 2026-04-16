package cache

import (
	"strconv"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
)

// TTLCache wraps an LRU cache with per-entry TTL expiration.
type TTLCache[K comparable, V any] struct {
	lru *lru.Cache[K, ttlEntry[V]]
	ttl time.Duration
}

type ttlEntry[V any] struct {
	value     V
	expiresAt time.Time
}

func NewTTLCache[K comparable, V any](size int, ttl time.Duration) *TTLCache[K, V] {
	if size < 1 {
		size = 1024
	}
	c, err := lru.New[K, ttlEntry[V]](size)
	if err != nil {
		panic("cache: failed to create TTL LRU cache: " + err.Error())
	}
	cache := &TTLCache[K, V]{lru: c, ttl: ttl}
	go cache.cleanupLoop()
	return cache
}

// cleanupLoop periodically evicts expired entries so they don't occupy LRU slots.
func (c *TTLCache[K, V]) cleanupLoop() {
	ticker := time.NewTicker(c.ttl * 2)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		for _, key := range c.lru.Keys() {
			entry, ok := c.lru.Peek(key)
			if ok && now.After(entry.expiresAt) {
				c.lru.Remove(key)
			}
		}
	}
}

func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	entry, ok := c.lru.Get(key)
	if !ok {
		var zero V
		return zero, false
	}
	if time.Now().After(entry.expiresAt) {
		c.lru.Remove(key)
		var zero V
		return zero, false
	}
	return entry.value, true
}

func (c *TTLCache[K, V]) Set(key K, value V) {
	c.lru.Add(key, ttlEntry[V]{value: value, expiresAt: time.Now().Add(c.ttl)})
}

func (c *TTLCache[K, V]) Remove(key K) {
	c.lru.Remove(key)
}

func (c *TTLCache[K, V]) Len() int {
	return c.lru.Len()
}

// UTXOEntry holds the resolved address, value, and asset for a transaction output.
type UTXOEntry struct {
	Address string
	Value   int64 // sela
	AssetID string
}

// UTXOCache is a bounded LRU cache mapping "txid:n" -> UTXOEntry.
// Used by the syncer to resolve vin references without DB lookups.
type UTXOCache struct {
	cache *lru.Cache[string, UTXOEntry]
	mu    sync.RWMutex
}

func NewUTXOCache(maxEntries int) *UTXOCache {
	if maxEntries < 1 {
		maxEntries = 2_000_000
	}
	c, err := lru.New[string, UTXOEntry](maxEntries)
	if err != nil {
		panic("cache: failed to create UTXO LRU cache: " + err.Error())
	}
	return &UTXOCache{cache: c}
}

func UTXOKey(txid string, n int) string {
	return txid + ":" + itoa(n)
}

func (u *UTXOCache) Get(txid string, n int) (UTXOEntry, bool) {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.cache.Get(UTXOKey(txid, n))
}

func (u *UTXOCache) Set(txid string, n int, entry UTXOEntry) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.cache.Add(UTXOKey(txid, n), entry)
}

func (u *UTXOCache) Remove(txid string, n int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.cache.Remove(UTXOKey(txid, n))
}

// RemoveByTxID evicts all entries with the given txid prefix.
// This is O(n) over cache keys, which is acceptable for reorg scenarios
// where n is bounded by cache capacity and reorgs are rare (depth-limited).
func (u *UTXOCache) RemoveByTxID(txid string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	prefix := txid + ":"
	keys := u.cache.Keys()
	for _, k := range keys {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			u.cache.Remove(k)
		}
	}
}

func (u *UTXOCache) Len() int {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.cache.Len()
}

func itoa(n int) string {
	if n >= 0 && n < 10 {
		return string(rune('0' + n))
	}
	return strconv.Itoa(n)
}
