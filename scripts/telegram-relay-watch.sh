#!/bin/bash
RELAY="/opt/data/productHunter/telegram-relay.jsonl"
if [ -f "$RELAY" ] && [ -s "$RELAY" ]; then
  cat "$RELAY"
  > "$RELAY"
fi