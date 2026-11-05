#!/bin/zsh
# Publishes web/ to the server named in .env.deploy, which stays out of the repository.
set -euo pipefail

project_root="${0:A:h}"
source "$project_root/.env.deploy"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
rsync -a --exclude test --exclude README.md --exclude .nojekyll --exclude .DS_Store "$project_root/web/" "$stage/"

# A new address per release, so returning visitors can't mix new pages with cached files.
stamp="$(date +%s)"
find "$stage" -type f \( -name '*.html' -o -name '*.js' \) -not -path '*/vendor/*' \
    -exec sed -i '' "s/v=dev/v=$stamp/g" {} +

# The AI proxy goes first, so a new page never calls an old proxy. It stays out of the web root.
ai_stage="$(mktemp -d)"
trap 'rm -rf "$stage" "$ai_stage"' EXIT
cp "$project_root/server/ai_proxy.py" "$project_root/server/hktransport-ai.service" "$ai_stage/"
node --input-type=module -e 'const { PROMPTS } = await import(process.argv[1]); console.log(JSON.stringify(PROMPTS));' \
    "$project_root/web/js/ai.js" > "$ai_stage/prompts.json"
remote=(ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ai_stage" -cf - . | "${remote[@]}" "$DEPLOY_HOST" 'set -e
    release="$(mktemp -d)"; trap "rm -rf $release" EXIT
    tar -xf - -C "$release"
    sudo install -d -m 755 /opt/hktransport-ai
    sudo install -m 644 "$release/ai_proxy.py" "$release/prompts.json" /opt/hktransport-ai/
    sudo install -m 644 "$release/hktransport-ai.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable -q hktransport-ai
    sudo systemctl restart hktransport-ai'

rsync -az --delete -e "$remote" "$stage/" "$DEPLOY_HOST:/var/www/hktransport/"
print "Published $stamp to https://$DEPLOY_DOMAIN/"
