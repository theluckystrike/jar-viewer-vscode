# Turn on decompiling

CFR needs a Java runtime, version 8 or newer. The viewer uses, in this order:

1. the setting `jarViewer.javaPath`
2. `JAVA_HOME`
3. `java` on your `PATH`

Without Java, the bytecode, members and constant pool views still work.
