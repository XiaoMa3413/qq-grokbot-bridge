#!/usr/bin/env bash
# usage: [IMAGE=/abs/a.png] reply.sh c2c|group <openid|group_openid> <msg_id|-> <content...|->
cd "$(dirname "$0")"; [ $# -lt 4 ] && [ -z "$IMAGE" -o $# -lt 3 ] && { echo "usage: $0 c2c|group <openid> <msg_id|-> <content>"; exit 1; }
t=$1; o=$2; m=$3; shift 3
k=$([ "$t" = c2c ] && echo openid || echo group_openid)
body=$(node -e 'const [t,k,o,m,c]=process.argv.slice(1);const b={type:t,[k]:o};if(c&&c!=="-")b.content=c;if(process.env.IMAGE)b.image=process.env.IMAGE;if(m!=="-")b.msg_id=m;console.log(JSON.stringify(b))' "$t" "$k" "$o" "$m" "$*")
curl -sS -X POST "http://127.0.0.1:${QQ_REPLY_PORT:-8787}/reply" -H 'Content-Type: application/json' -H "X-Reply-Token: $(cat reply_token)" -d "$body"; echo
