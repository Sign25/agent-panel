#!/usr/bin/env bash
# Fresh install on any VPS: install.sh <domain> [name]
# Writes data/config.json (if absent), a systemd unit for this folder and a Caddy site block.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
domain=${1:?'Укажите домен: deploy/install.sh panel.example.com [название узла]'}
name=${2:-$(hostname)}
port=${PANEL_PORT:-8787}
cd "$root"
[[ $EUID == 0 ]] || { echo 'Запустите от root'; exit 1; }
[[ $domain =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'Некорректный домен'; exit 1; }
[[ -s data/password.json ]] || { echo "Сначала выполните: node $root/password.mjs"; exit 1; }
mkdir -p data && chmod 700 data
if [[ ! -s data/config.json ]]; then
 node -e 'const [origin,nodeName,port]=process.argv.slice(1);require("fs").writeFileSync("data/config.json",JSON.stringify({origin,nodeName,port:Number(port),agents:["claude"],projects:[],language:"ru"},null,2)+"\n",{mode:0o600})' "https://$domain" "$name" "$port"
 echo 'Создан data/config.json: проверьте список агентов и стартовые проекты.'
fi
command -v claude >/dev/null && claude auth status >/dev/null || echo 'Claude Code не найден или не авторизован: агент будет недоступен до входа.'
npm ci --omit=dev --no-audit --no-fund
if grep -q "^$domain" /etc/caddy/Caddyfile; then echo "$domain уже есть в Caddyfile: проверьте вручную"; exit 1; fi
backup="/etc/caddy/Caddyfile.pre-agent-panel.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a /etc/caddy/Caddyfile "$backup"
printf '%s\n' "$backup" > data/caddy-backup-path
candidate=$(mktemp /etc/caddy/Caddyfile.panel.XXXXXX)
trap 'rm -f "$candidate"' EXIT
{ cat "$backup"; printf '\n%s {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:%s\n}\n' "$domain" "$port"; } > "$candidate"
caddy adapt --config "$candidate" --adapter caddyfile --validate >/dev/null
sed -e "s#@ROOT@#$root#g" -e "s#@NODE@#$(command -v node)#g" deploy/agent-panel.service.in > /etc/systemd/system/agent-panel.service
chmod 644 /etc/systemd/system/agent-panel.service
systemctl daemon-reload
systemctl enable --now agent-panel
for i in $(seq 20); do curl --fail --silent "http://127.0.0.1:$port/" >/dev/null && break; sleep 1; done
install -m 644 "$candidate" /etc/caddy/Caddyfile
if ! systemctl reload caddy; then cp -a "$backup" /etc/caddy/Caddyfile; systemctl reload caddy; exit 1; fi
systemctl is-active agent-panel caddy
printf 'Установлено: https://%s · резервная копия Caddyfile: %s\n' "$domain" "$backup"
