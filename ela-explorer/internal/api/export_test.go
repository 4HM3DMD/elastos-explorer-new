package api

import (
	"strings"
	"testing"
)

func TestParseExportDateRange_Valid(t *testing.T) {
	from, to, err := parseExportDateRange("2024-01-01", "2024-01-31")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if from >= to {
		t.Errorf("from (%d) should be less than to (%d)", from, to)
	}
	// to should be end-of-day inclusive (23:59:59 UTC) so a query
	// "ending 2024-01-31" still captures rows on Jan 31.
	if (to-from)/3600 < 24*30 {
		t.Errorf("range should span ~31 days, got %d hours", (to-from)/3600)
	}
}

func TestParseExportDateRange_MissingParams(t *testing.T) {
	if _, _, err := parseExportDateRange("", "2024-01-01"); err == nil {
		t.Error("expected error for missing from")
	}
	if _, _, err := parseExportDateRange("2024-01-01", ""); err == nil {
		t.Error("expected error for missing to")
	}
}

func TestParseExportDateRange_InvalidDate(t *testing.T) {
	if _, _, err := parseExportDateRange("not-a-date", "2024-01-01"); err == nil {
		t.Error("expected error for invalid from")
	}
	if _, _, err := parseExportDateRange("2024-01-01", "31/12/2024"); err == nil {
		t.Error("expected error for non-ISO to")
	}
}

func TestParseExportDateRange_Inverted(t *testing.T) {
	if _, _, err := parseExportDateRange("2024-12-31", "2024-01-01"); err == nil {
		t.Error("expected error when to is before from")
	}
}

func TestParseExportDateRange_RangeCap(t *testing.T) {
	// 367 days exceeds the 366-day cap.
	_, _, err := parseExportDateRange("2024-01-01", "2025-01-03")
	if err == nil {
		t.Error("expected error for range > 366 days")
	}
	if !strings.Contains(err.Error(), "366") {
		t.Errorf("error should mention the 366-day cap, got: %v", err)
	}
}

func TestExportFormatFromString(t *testing.T) {
	cases := []struct {
		in   string
		want ExportFormat
	}{
		{"koinly", FormatKoinly},
		{"cointracking", FormatCoinTracking},
		{"raw", FormatRaw},
		{"", FormatKoinly},
		{"unknown", FormatKoinly},
		{"KOINLY", FormatKoinly}, // case-sensitive; falls back rather than rejecting
	}
	for _, c := range cases {
		got := exportFormatFromString(c.in)
		if got != c.want {
			t.Errorf("exportFormatFromString(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSafeFilenameSegment(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"EabAPwWynzzEn8uYyRXGwyvJ4V42CqWuev", "EabAPwWynzzEn8uYyRXGwyvJ4V42CqWuev"},
		{"abc/../def", "abcdef"},
		{"safe-string_123", "safestring123"},
		{"", ""},
		{`"; rm -rf /`, "rmrf"},
	}
	for _, c := range cases {
		got := safeFilenameSegment(c.in)
		if got != c.want {
			t.Errorf("safeFilenameSegment(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestJoinComma(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"a"}, "a"},
		{[]string{"a", "b"}, "a,b"},
		{[]string{"a", "b", "c"}, "a,b,c"},
	}
	for _, c := range cases {
		got := joinComma(c.in)
		if got != c.want {
			t.Errorf("joinComma(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
