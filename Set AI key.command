#!/bin/zsh
# Puts the DeepSeek key on the server. It is typed here, hidden, and goes straight over SSH.
set -euo pipefail

source "${0:A:h}/.env.deploy"
read -rs "key?DeepSeek API key (hidden): "
print
[[ -n "$key" ]] || { print "No key entered."; exit 1; }
print -r -- "DEEPSEEK_API_KEY=$key" | ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$DEPLOY_HOST" \
    "sudo sh -c 'umask 077; mkdir -p /etc/hktransport; cat > /etc/hktransport/ai.env; systemctl restart hktransport-ai'"
unset key
print "Saved on the server."
