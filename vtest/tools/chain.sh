#!/bin/bash
set -e
cd /home/claude/fly
KEYS="0:keys/k000_nb2.jpg"
for t in 30 60 90 120; do
  python3 chain_input.py $t $KEYS
  python3 chain_job.py $t
  cd /home/claude/iLisboa
  git pull -q origin claude/project-thread-5zfugr
  echo "JOBS=jobsc$t.json" > vtest/go
  git add vtest/go vtest/jobsc$t.json vtest/in/c${t}_photo.jpg vtest/in/c0${t}_photo.jpg 2>/dev/null || git add vtest/go vtest/jobsc$t.json vtest/in/
  git commit -qm "vtest: chained keyframe $t" && git push -q origin claude/project-thread-5zfugr
  T=$(printf "c%03d_nb2.jpg" $t)
  until git pull -q origin claude/project-thread-5zfugr 2>/dev/null; [ -f vtest/out/$T ]; do sleep 15; done
  cp vtest/out/$T /home/claude/fly/keys/
  cd /home/claude/fly
  KEYS="$KEYS $t:keys/$T"
  echo "done $t"
done
echo ALL $KEYS
