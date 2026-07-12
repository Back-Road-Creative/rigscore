#!/bin/sh
# Positive + negative CONNECT probe. `pidof tinyproxy` proves only that the process is alive, but
# tinyproxy fails OPEN on a filter parse error — a broken allow-list then reads as healthy while the
# fail-CLOSED network is wide open, and a happy-path check cannot see that. So an allow-listed host
# MUST tunnel (200) and a host absent from ./allowlist MUST be refused; if the filter fails open,
# that second leg flips to 200 and this exits non-zero, failing `--wait` at create time. DENY_HOST
# must be a REAL, reachable host: under a fail-open filter it has to actually return 200 (an
# unresolvable host would 502 and hide it). INVARIANT: ALLOW_HOST stays IN ./allowlist, DENY_HOST OUT.
set -eu
ALLOW_HOST="github.com"
DENY_HOST="example.com"

# Speaks CONNECT by hand (busybox `nc`) to read tinyproxy's own status line without a TLS handshake.
# `|| true` keeps `set -e` from aborting on a refusal — the EXPECTED outcome of the negative leg.
probe() {
  printf 'CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n' "$1" "$1" \
    | nc -w 3 127.0.0.1 8888 2>/dev/null | head -n1 || true
}
allow_resp="$(probe "$ALLOW_HOST")"
deny_resp="$(probe "$DENY_HOST")"

case "$allow_resp" in
  *" 200 "*) ;;
  *) echo "healthcheck: allow-listed CONNECT ($ALLOW_HOST) did not tunnel: '$allow_resp'" >&2
     exit 1 ;;
esac
case "$deny_resp" in
  *" 200 "*) echo "healthcheck: non-allow-listed CONNECT ($DENY_HOST) tunneled — filter is fail-open: '$deny_resp'" >&2
     exit 1 ;;
  *) ;;
esac
exit 0
