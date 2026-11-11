# Task 2 rehearsal only. A path guard, then the rollout document's quarantine/install block VERBATIM
# (docs/pinned-keywords-related-rollout.md lines 234-245 at 842459e) with ACTUAL_TIMESTAMP = 20261110-090500.
# Runs only in the Task 2 maintenance container, after --verify succeeded:
#   docker exec recall-task2-20261110-6c4a91f2-maint2 sh /task2/quarantine-install.sh
set -eu
guard_stage=/data/restore-v3-20261110-090500
guard_quarantine=/data/post-v4-20261110-090500
# /data must be the mounted task-owned volume, and every path must resolve directly inside it.
grep -q '^[^ ]* [^ ]* [^ ]* [^ ]* /data ' /proc/self/mountinfo || { echo "/data is not a mount point" >&2; exit 90; }
[ "$(realpath /data)" = /data ] || { echo "/data resolves elsewhere" >&2; exit 91; }
[ "$(realpath "$guard_stage")" = "$guard_stage" ] || { echo "stage resolves elsewhere" >&2; exit 92; }
[ "$(realpath -m "$guard_quarantine")" = "$guard_quarantine" ] || { echo "quarantine resolves elsewhere" >&2; exit 93; }
[ ! -e "$guard_quarantine" ] || { echo "quarantine already exists" >&2; exit 94; }
for name in recall.db recall.db-wal recall.db-shm photos; do
  if [ -L "/data/$name" ] || [ -L "$guard_stage/$name" ]; then echo "symlink: $name" >&2; exit 95; fi
done
echo "Path guard passed: /data is a mount point; stage and quarantine resolve directly inside it."
echo "--- /data before"
ls -lan /data

# ---- verbatim from the rollout document ----
set -eu
stage=/data/restore-v3-20261110-090500
quarantine=/data/post-v4-20261110-090500
test -f "$stage/recall.db"
test -d "$stage/photos"
mkdir "$quarantine"
for name in recall.db recall.db-wal recall.db-shm photos; do
  if [ -e "/data/$name" ]; then mv "/data/$name" "$quarantine/$name"; fi
done
mv "$stage/recall.db" /data/recall.db
mv "$stage/photos" /data/photos
chown -R node:node /data/recall.db /data/photos
# ---- end of verbatim block ----

echo "--- /data after"
ls -lan /data
echo "--- quarantine"
ls -lanR "$quarantine"
if [ -e /data/recall.db-wal ] || [ -e /data/recall.db-shm ]; then echo "A WAL/SHM file remains beside the restored database" >&2; exit 96; fi
echo "Installed matched v3 database and photos; v4 database, sidecars and photos are in $quarantine."
