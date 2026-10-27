cd /Volumes/T7/Projects/open-source/sim-eyes-fast
out=scripts/bench/out; rm -rf $out; mkdir -p $out
for k in 1 2 3; do
  rm -rf /tmp/run-ios /tmp/run-and; mkdir -p /tmp/run-ios /tmp/run-and
  node scripts/measure-batch.mjs com.ilamaster.pivoplay "$(cat scripts/bench/ios.json)" > $out/ios-$k.txt 2>&1
  mkdir -p $out/shots-ios-$k && cp -R /tmp/run-ios/. $out/shots-ios-$k/
  PLATFORM=android node scripts/measure-batch.mjs com.ilamaster.pivoplay "$(cat scripts/bench/android.json)" > $out/and-$k.txt 2>&1
  mkdir -p $out/shots-and-$k && cp -R /tmp/run-and/. $out/shots-and-$k/
done
echo ALLDONE > $out/done.txt
