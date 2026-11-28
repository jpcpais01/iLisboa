#!/bin/bash
set -e
cd /home/claude/fly
KEYS="0:keys/k000_nb2.jpg 12:keys/v012_nb2.jpg 24:keys/v024_nb2.jpg 36:keys/v036_nb2.jpg 48:keys/v048_nb2.jpg 60:keys/v060_nb2.jpg 72:keys/v072_nb2.jpg 84:keys/v084_nb2.jpg 96:keys/v096_nb2.jpg"
for t in 108 120; do
  python3 chain_input.py $t $KEYS
  python3 chain2_job.py $t
  cd /home/claude/iLisboa
  git pull -q origin claude/project-thread-5zfugr
  printf "JOBS=jobsv$t.json\nRUN=%s\n" "$(date +%s)" > vtest/go
  git add vtest/go vtest/jobsv$t.json vtest/in/
  git commit -qm "vtest: v4 keyframe $t" && git push -q origin claude/project-thread-5zfugr
  T=$(printf "v%03d_nb2.jpg" $t)
  n=0; until git pull -q origin claude/project-thread-5zfugr 2>/dev/null; [ -f vtest/out/$T ]; do sleep 10; n=$((n+1)); [ $n -gt 60 ] && { echo "timeout $t"; exit 1; }; done
  cp vtest/out/$T /home/claude/fly/keys/
  cd /home/claude/fly
  KEYS="$KEYS $t:keys/$T"
  echo "done $t"
done
echo ALL $KEYS
