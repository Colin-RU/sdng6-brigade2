# Уведомления о сторонних компонентах

## Карта в атласе

| Компонент | Лицензия | Официальный источник |
| --- | --- | --- |
| Leaflet 1.9.4 | BSD 2-Clause | [Leaflet v1.9.4](https://github.com/Leaflet/Leaflet/tree/v1.9.4) |
| Leaflet.markercluster 1.5.3 | MIT | [Leaflet.markercluster v1.5.3](https://github.com/Leaflet/Leaflet.markercluster/tree/v1.5.3) |

Leaflet: Copyright (c) 2010–2023 Volodymyr Agafonkin; Copyright (c) 2010–2011 CloudMade. Полный текст: [Leaflet-1.9.4-LICENSE.txt](licenses/Leaflet-1.9.4-LICENSE.txt).

Leaflet.markercluster: Copyright 2012 David Leaver. Полный текст: [Leaflet.markercluster-1.5.3-LICENSE.txt](licenses/Leaflet.markercluster-1.5.3-LICENSE.txt).

## Данные OpenStreetMap

Картографические данные © [участники OpenStreetMap](https://www.openstreetmap.org/copyright). Данные OpenStreetMap и производные от них дорожные данные распространяются на условиях [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). [Полный текст ODbL](licenses/Open-Database-License-1.0.txt).

Производные дорожные данные доступны в машиночитаемом виде в `docs/geo-network.json` и `docs/geo-roads.json`. Источники отдельных географических объектов и точек указаны в соответствующих записях данных. Уведомление об ODbL относится к данным OpenStreetMap и производным от них сведениям.

## Компоненты Android APK

Для Android 2.0.0 фактически разрешены 34 артефакта AAR/JAR в `releaseRuntimeClasspath`. Версии, зависимости и исходные POM лицензий сохранены в [машиночитаемом перечне](licenses/android-runtime-dependencies.json). Метаданные разрешения содержат 38 компонентов; они не означают 38 дополнительных библиотек.

Все перечисленные Android-компоненты распространяются по Apache License 2.0. [Полный текст Apache 2.0](licenses/Apache-2.0.txt).

| Артефакт | Фактическая версия |
| --- | --- |
| `androidx.annotation:annotation-experimental` | 1.4.1 |
| `androidx.annotation:annotation-jvm` | 1.8.1 |
| `androidx.arch.core:core-common` | 2.2.0 |
| `androidx.arch.core:core-runtime` | 2.2.0 |
| `androidx.collection:collection-jvm` | 1.4.2 |
| `androidx.concurrent:concurrent-futures` | 1.1.0 |
| `androidx.concurrent:concurrent-futures-ktx` | 1.1.0 |
| `androidx.core:core` | 1.15.0 |
| `androidx.interpolator:interpolator` | 1.0.0 |
| `androidx.lifecycle:lifecycle-common` | 2.6.2 |
| `androidx.lifecycle:lifecycle-livedata` | 2.6.2 |
| `androidx.lifecycle:lifecycle-livedata-core` | 2.6.2 |
| `androidx.lifecycle:lifecycle-runtime` | 2.6.2 |
| `androidx.lifecycle:lifecycle-service` | 2.6.2 |
| `androidx.profileinstaller:profileinstaller` | 1.3.0 |
| `androidx.room:room-common` | 2.6.1 |
| `androidx.room:room-ktx` | 2.6.1 |
| `androidx.room:room-runtime` | 2.6.1 |
| `androidx.sqlite:sqlite` | 2.4.0 |
| `androidx.sqlite:sqlite-framework` | 2.4.0 |
| `androidx.startup:startup-runtime` | 1.1.1 |
| `androidx.tracing:tracing` | 1.2.0 |
| `androidx.tracing:tracing-ktx` | 1.2.0 |
| `androidx.versionedparcelable:versionedparcelable` | 1.1.1 |
| `androidx.webkit:webkit` | 1.12.1 |
| `androidx.work:work-runtime` | 2.10.1 |
| `com.google.guava:listenablefuture` | 1.0 |
| `org.jetbrains.kotlin:kotlin-stdlib` | 1.8.22 |
| `org.jetbrains.kotlin:kotlin-stdlib-common` | 1.8.22 |
| `org.jetbrains.kotlin:kotlin-stdlib-jdk7` | 1.8.22 |
| `org.jetbrains.kotlin:kotlin-stdlib-jdk8` | 1.8.22 |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` | 1.7.3 |
| `org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm` | 1.7.3 |
| `org.jetbrains:annotations` | 23.0.0 |

AndroidX: The Android Open Source Project. [Официальные исходники](https://android.googlesource.com/platform/frameworks/support/), [полный текст лицензии](licenses/AndroidX-Apache-2.0.txt). Лицензии каждого артефакта проверены по его POM в официальном Google Maven.

Kotlin 1.8.22, kotlinx.coroutines 1.7.3 и JetBrains annotations 23.0.0: JetBrains s.r.o. и участники соответствующих проектов. Полные тексты: [Kotlin](licenses/Kotlin-1.8.22-LICENSE.txt), [kotlinx.coroutines](licenses/Kotlinx-Coroutines-1.7.3-LICENSE.txt), [JetBrains annotations](licenses/JetBrains-Annotations-23.0.0-LICENSE.txt). Официальные исходники: [Kotlin v1.8.22](https://github.com/JetBrains/kotlin/tree/v1.8.22), [kotlinx.coroutines 1.7.3](https://github.com/Kotlin/kotlinx.coroutines/tree/1.7.3), [annotations 23.0.0](https://github.com/JetBrains/java-annotations/tree/23.0.0).

Guava ListenableFuture 1.0: Copyright (C) 2007 The Guava Authors. [Исходное уведомление](licenses/Guava-ListenableFuture-1.0-NOTICE.txt), [Apache License 2.0](licenses/Apache-2.0.txt). Лицензия наследуется из официального POM `guava-parent:26.0-android`; исходное уведомление сохранено из `listenablefuture-1.0-sources.jar` Maven Central.

## Gradle Wrapper

В исходниках Android сохранён Gradle Wrapper 8.11.1. Copyright Gradle, Inc. и участники проекта. Apache License 2.0: [полный текст](licenses/AndroidX-Apache-2.0.txt), [официальное уведомление Gradle](licenses/Gradle-8.11.1-NOTICE.txt), [исходники](https://github.com/gradle/gradle/tree/v8.11.1/platforms/core-runtime/wrapper-main).

Указанные лицензии относятся к перечисленным сторонним компонентам и данным.
