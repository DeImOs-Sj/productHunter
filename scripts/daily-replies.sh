#!/bin/bash
# Check inbox replies with retry for transient IMAP errors
cd /opt/data/productHunter
for attempt in 1 2 3; do
  result=$(node src/pipeline.js check-replies 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "$result"
    exit 0
  fi
  echo "Attempt $attempt failed (rc=$rc): $result" >&2
  [ $attempt -lt 3 ] && sleep 10
done
echo "All 3 attempts failed." >&2
exit 1
