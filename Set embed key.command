#!/bin/zsh
# Puts the Google Maps Embed key on the server. It is typed here, hidden, and goes straight over SSH.
set -euo pipefail

source "${0:A:h}/.env.deploy"
read -rs "key?Google Maps Embed API key (hidden): "
print
[[ -n "$key" ]] || { print "No key entered."; exit 1; }
print -r -- "GOOGLE_EMBED_KEY=$key" | ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$DEPLOY_HOST" \
    "sudo sh -c 'umask 077; mkdir -p /etc/hktransport; cat > /etc/hktransport/embed.env; systemctl restart hktransport-ai'"
unset key
print "Saved on the server."
