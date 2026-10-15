#!/bin/zsh
# Restarts the simulated running sessions in the demo data: livesim.mjs's from a fresh context, then fleetsim.mjs's.
S=${0:A:h}; R=${S:h:h}; D=${CLAUDE_CONFIG_DIR:-$R/.demo-claude}; O=$R/.readme-rec
mkdir -p $O/bin
for n in claude copilot; do [[ -x $O/bin/$n ]] || cc -o $O/bin/$n $S/fake-claude.c; done
pkill -f livesim.mjs; pkill -f "$O/bin/claude"; pkill -f "$O/bin/copilot"
id=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).id)}catch{}' $O/live.out)
[[ -n $id ]] && rm -f $D/projects/*/$id.jsonl(N) $D/marey/live/$id.json
for f in $D/sessions/*.json(N); do [[ $f == */99991.json ]] || rm -f $f; done
(EVERY=${EVERY:-2500} node $S/livesim.mjs > $O/live.out 2>&1 &)
node $S/fleetsim.mjs
sleep 7
