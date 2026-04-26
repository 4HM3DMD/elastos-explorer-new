package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func (s *Server) serveSitemap(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	b.WriteString("\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)
	b.WriteString("\n")

	staticPages := []struct {
		path       string
		changefreq string
		priority   string
	}{
		{"/", "hourly", "1.0"},
		{"/blocks", "always", "0.9"},
		{"/transactions", "always", "0.9"},
		{"/validators", "daily", "0.8"},
		{"/staking", "daily", "0.7"},
		{"/ranking", "daily", "0.7"},
		{"/governance", "weekly", "0.7"},
		{"/governance/proposals", "daily", "0.7"},
		{"/charts", "daily", "0.6"},
		{"/api-docs", "monthly", "0.4"},
	}

	now := time.Now().UTC().Format("2006-01-02")
	for _, p := range staticPages {
		fmt.Fprintf(&b, "<url><loc>%s%s</loc><lastmod>%s</lastmod><changefreq>%s</changefreq><priority>%s</priority></url>\n",
			seoSiteURL, p.path, now, p.changefreq, p.priority)
	}

	type urlEntry struct {
		loc     string
		lastmod string
	}

	var entries []urlEntry

	// Top addresses by balance (top 1000)
	rows, err := s.db.API.Query(ctx,
		`SELECT address FROM address_balances ORDER BY balance_sela DESC LIMIT 1000`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var addr string
			if rows.Scan(&addr) == nil {
				entries = append(entries, urlEntry{loc: "/address/" + addr, lastmod: now})
			}
		}
	} else {
		slog.Warn("sitemap: failed to query top addresses", "error", err)
	}

	// Recent blocks (last 1000)
	rows2, err := s.db.API.Query(ctx,
		`SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1000`)
	if err == nil {
		defer rows2.Close()
		for rows2.Next() {
			var height int64
			var ts int64
			if rows2.Scan(&height, &ts) == nil {
				mod := time.Unix(ts, 0).UTC().Format("2006-01-02")
				entries = append(entries, urlEntry{loc: fmt.Sprintf("/block/%d", height), lastmod: mod})
			}
		}
	} else {
		slog.Warn("sitemap: failed to query blocks", "error", err)
	}

	// Active proposals
	rows3, err := s.db.API.Query(ctx,
		`SELECT proposal_hash FROM cr_proposals WHERE status NOT IN ('Terminated', 'Canceled', 'Rejected')`)
	if err == nil {
		defer rows3.Close()
		for rows3.Next() {
			var hash string
			if rows3.Scan(&hash) == nil {
				entries = append(entries, urlEntry{loc: "/governance/proposal/" + hash, lastmod: now})
			}
		}
	} else {
		slog.Warn("sitemap: failed to query proposals", "error", err)
	}

	// Active validators
	rows4, err := s.db.API.Query(ctx,
		`SELECT owner_pubkey FROM producers WHERE state = 'Active'`)
	if err == nil {
		defer rows4.Close()
		for rows4.Next() {
			var pk string
			if rows4.Scan(&pk) == nil {
				entries = append(entries, urlEntry{loc: "/validator/" + pk, lastmod: now})
			}
		}
	} else {
		slog.Warn("sitemap: failed to query producers", "error", err)
	}

	for _, e := range entries {
		fmt.Fprintf(&b, "<url><loc>%s%s</loc><lastmod>%s</lastmod></url>\n",
			seoSiteURL, e.loc, e.lastmod)
	}

	b.WriteString("</urlset>\n")

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600, s-maxage=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}
