#!/bin/zsh
# Puts the MapTiler key on the server, which hands it to the page.
set -euo pipefail

source "${0:A:h}/.env.deploy"
read -rs "key?MapTiler API key (hidden): "
print
[[ -n "$key" ]] || { print "No key entered."; exit 1; }
print -r -- "MAPTILER_KEY=$key" | ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$DEPLOY_HOST" \
    "sudo sh -c 'umask 077; mkdir -p /etc/hktransport; cat > /etc/hktransport/map.env; systemctl restart hktransport-ai'"
unset key
print "Saved on the server."
