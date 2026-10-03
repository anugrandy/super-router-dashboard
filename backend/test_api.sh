#!/usr/bin/env bash
# End-to-end API smoke test against a running netdash on 127.0.0.1:8777
set -u
# Match the port the backend actually runs on; default 8777 for older setups.
PORT="${NETDASH_BACKEND:-${NETDASH_PORT:-8777}}"
BASE="http://127.0.0.1:${PORT}"
CJ="$LOCALAPPDATA/Temp/netdash_test_c.txt"
rm -f "$CJ"
PASS=0; FAIL=0
say() { printf '%s\n' "$*"; }
chk() { # name expected_substring actual
  if printf '%s' "$3" | grep -q "$2"; then say "PASS  $1"; PASS=$((PASS+1));
  else say "FAIL  $1 -- got: ${3:0:220}"; FAIL=$((FAIL+1)); fi
}

say "--- auth ---"
R=$(curl -s -c "$CJ" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"netdash"}')
chk "login ok" '"ok":true' "$R"
chk "unauth devices 401" '401' "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/devices)"
chk "bad password 401" '401' "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}')"

say "--- devices ---"
DEV=$(curl -s -b "$CJ" "$BASE/api/devices")
chk "device list" '"devices"' "$DEV"
MAC=$(printf '%s' "$DEV" | grep -o '"mac":"[0-9A-F:]*"' | head -1 | cut -d'"' -f4)
say "  first mac: ${MAC:-none}"

say "--- nickname patch ---"
if [ -n "$MAC" ]; then
  ENC=$(printf '%s' "$MAC" | sed 's/:/%3A/g')
  R=$(curl -s -b "$CJ" -X PATCH "$BASE/api/devices/$ENC" -H 'Content-Type: application/json' -d '{"nickname":"HP Adek"}')
  chk "nickname set" 'HP Adek' "$R"
  chk "detail 200" '200' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" $BASE/api/devices/$ENC)"
  chk "history 200" '200' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" $BASE/api/devices/$ENC/history)"
  # type override: set it, confirm it wins over the auto guess, then clear it
OVR=$(curl -s -b "$CJ" -X PATCH "$BASE/api/devices/$ENC" -H 'Content-Type: application/json' -d '{"type_override":"printer"}')
chk "type override set" '"type_override":"printer"' "$OVR"
chk "override wins" '"device_type":"printer"' "$OVR"
R=$(curl -s -b "$CJ" -X PATCH "$BASE/api/devices/$ENC" -H 'Content-Type: application/json' -d '{"type_override":"not_a_real_type"}')
chk "bad type 400" '400' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X PATCH "$BASE/api/devices/$ENC" -H 'Content-Type: application/json' -d '{"type_override":"not_a_real_type"}')"
CLR=$(curl -s -b "$CJ" -X PATCH "$BASE/api/devices/$ENC" -H 'Content-Type: application/json' -d '{"type_override":""}')
chk "type override cleared" '"type_override":""' "$CLR"

chk "bad mac 400/404" '\(400\|404\)' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" $BASE/api/devices/not-a-mac)"
fi

# Remember the real gateway so it can be restored no matter which branch runs.
GW_SAVED=$(curl -s -b "$CJ" "$BASE/api/settings" | grep -o '"gateway_mac":[^,}]*' | cut -d: -f2- | tr -d '"')

say "--- kick safety ---"
chk "kick unknown mac 404" '404' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST $BASE/api/devices/AA:BB:CC:DD:EE:FF/kick -H 'Content-Type: application/json' -d '{}')"
chk "kick malformed 400" '400' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST $BASE/api/devices/zz/kick -H 'Content-Type: application/json' -d '{}')"
# Pick a NON-gateway device for kick-safety checks: the gateway is refused for
# a different (earlier) reason, which would mask the whitelist assertion.
if [ -n "$MAC" ]; then
  ENC=$(printf '%s' "$MAC" | sed 's/:/%3A/g')
  HOST=$(curl -s -b "$CJ" "$BASE/api/devices" | tr '{' '\n' | grep -v '"is_gateway":true' | grep -o '"mac":"[0-9A-F:]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$HOST" ]; then say "SKIP  no non-gateway device discovered; whitelist check needs one"; HOST="$MAC"; fi
  say "  testing kick on: ${HOST}"
  HENC=$(printf '%s' "$HOST" | sed 's/:/%3A/g')
  # whitelist the target, then confirm kick is refused for a whitelisted MAC
  curl -s -b "$CJ" -X POST "$BASE/api/settings" -H 'Content-Type: application/json' -d "{\"whitelist_macs\":[\"$HOST\"]}" >/dev/null
  chk "whitelisted kick refused" 'whitelist' "$(curl -s -b "$CJ" -X POST $BASE/api/devices/$HENC/kick -H 'Content-Type: application/json' -d '{}')"
  # gateway must also be protected once gateway_mac is set
  curl -s -b "$CJ" -X POST "$BASE/api/settings" -H 'Content-Type: application/json' -d "{\"whitelist_macs\":[],\"gateway_mac\":\"$HOST\"}" >/dev/null
  chk "gateway kick refused" 'gateway' "$(curl -s -b "$CJ" -X POST $BASE/api/devices/$HENC/kick -H 'Content-Type: application/json' -d '{}')"
  # a device already marked is_gateway is refused even without gateway_mac
  chk "is_gateway device refused" 'gateway' "$(curl -s -b "$CJ" -X POST $BASE/api/devices/$ENC/kick -H 'Content-Type: application/json' -d '{}')"
fi

# Restore the gateway the user actually has, whether or not the block above ran.
# Without this the suite can leave an arbitrary phone pinned as the gateway.
if [ -n "$GW_SAVED" ] && [ "$GW_SAVED" != "null" ]; then
  curl -s -b "$CJ" -X POST "$BASE/api/settings" -H 'Content-Type: application/json' \
    -d "{\"gateway_mac\":\"$GW_SAVED\",\"whitelist_macs\":[]}" >/dev/null
else
  curl -s -b "$CJ" -X POST "$BASE/api/settings" -H 'Content-Type: application/json' \
    -d '{"gateway_mac":null,"whitelist_macs":[]}' >/dev/null
fi
say "  gateway restored to: ${GW_SAVED:-<auto>}"

say "--- dashboard / settings ---"
chk "dashboard 200" '"total"' "$(curl -s -b "$CJ" $BASE/api/dashboard)"
chk "settings 200" 'subnet' "$(curl -s -b "$CJ" $BASE/api/settings)"
chk "bad subnet 400" '400' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST $BASE/api/settings -H 'Content-Type: application/json' -d '{"subnet":"999.999.1.0/24"}')"
chk "bad whitelist mac 400" '400' "$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST $BASE/api/settings -H 'Content-Type: application/json' -d '{"whitelist_macs":["nope"]}')"
chk "kicks list 200" 'kicks' "$(curl -s -b "$CJ" $BASE/api/kicks)"

say "--- rate limit ---"
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"bad"}'
done
chk "login locked out 429" '429' "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"bad"}')"

say ""
say "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
