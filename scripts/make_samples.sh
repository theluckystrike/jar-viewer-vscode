#!/bin/zsh
# Builds the walkthrough samples (samples/sample-inventory.jar and samples/Inventory.class) from scripts/samples-src
# with a local JDK (javac and jar). Run: zsh scripts/make_samples.sh [JDK bin folder]
set -eu
here=${0:A:h}; root=${here:h}
bin=${1:-/opt/homebrew/opt/openjdk/bin}
work=$(mktemp -d); trap 'rm -rf $work' EXIT
mkdir -p $work/classes
$bin/javac -nowarn --release 11 -g -d $work/classes $here/samples-src/a/com/example/inventory/*.java
$bin/javac -nowarn --release 17 -g -d $work/classes $here/samples-src/b/com/example/inventory/*.java
mkdir -p $work/classes/config
print -r -- "warehouse=Bangkok-2
reorder.days=7" > $work/classes/config/inventory.properties
mkdir -p $root/samples
rm -f $root/samples/sample-inventory.jar
(cd $work/classes && $bin/jar --create --file $root/samples/sample-inventory.jar --main-class com.example.inventory.InventoryApp com config)
cp $work/classes/com/example/inventory/Inventory.class $root/samples/Inventory.class
ls -l $root/samples
