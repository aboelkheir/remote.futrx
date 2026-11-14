#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
TEMPLATE="$TESTS_DIR/../templates/Caddyfile.tmpl"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

site_block() {
    awk -v site="$1" '
        $0 == site " {" { in_block = 1 }
        in_block {
            print
            opens += gsub(/\{/, "{")
            closes += gsub(/\}/, "}")
            if (opens > 0 && opens == closes) exit
        }
    ' "$TEMPLATE"
}

launcher_block="$(site_block 'code.${HOSTNAME}')"
[ -n "$launcher_block" ] || fail 'shared code hostname block is missing'
printf '%s\n' "$launcher_block" | grep -Fq 'on_demand' || \
    fail 'shared code hostname does not use the on-demand TLS policy'
printf '%s\n' "$launcher_block" | grep -Fq 'forward_auth 127.0.0.1:${SERVICE_PORT}' || \
    fail 'shared code hostname does not require authentication'
printf '%s\n' "$launcher_block" | grep -Fq 'root * ${INSTALL_DIR}/infra/launcher' || \
    fail 'shared code hostname does not serve the launcher'

for site in '*.${HOSTNAME}' '*.code.${HOSTNAME}' '*.dev.${HOSTNAME}'; do
    block="$(site_block "$site")"
    [ -n "$block" ] || fail "$site block is missing"
    printf '%s\n' "$block" | grep -Fq 'tls {' || \
        fail "$site is not assigned an explicit TLS policy"
    printf '%s\n' "$block" | grep -Fq 'on_demand' || \
        fail "$site does not use the on-demand TLS policy"
done

echo 'Caddy template TLS policy tests passed'
