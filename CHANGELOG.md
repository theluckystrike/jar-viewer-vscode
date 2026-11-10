# Changelog

## 0.1.0

- First release: JAR, WAR, EAR, AAR and class file viewer with packages, resources, MANIFEST.MF, the Java version of each class, a javap-style bytecode listing, members, constant pool and class attributes.
- Decompiled Java source with the bundled CFR 0.152 when a Java runtime is found (setting `jarViewer.javaPath`, `JAVA_HOME` or `java` on `PATH`).
- Nested JARs (Spring Boot `BOOT-INF/lib`, WAR `WEB-INF/lib`, AAR `classes.jar`) open one level deep.
- Zovo Pro tools with 3 free tries each: export the decompiled sources of a JAR, compare two JARs, find a class, method or string in every JAR of a folder.
- The footer, the README and the last walkthrough step link related free Zovo extensions. "Zovo Pro, USD 19" and the Marketplace Sponsor button open the Zovo Pro tier on GitHub Sponsors.
