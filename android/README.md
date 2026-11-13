# Android

APK содержит весь атлас, карту, дороги и расчёт маршрутов. Интернет для запуска, поиска и GPS не требуется. Местоположение доступно при открытом приложении; включите геолокацию телефона и разрешите точное местоположение. Первый спутниковый сигнал на открытом месте может определяться до минуты. В разделе «Загруженные карты» можно проверить сохранённую карту.

Чат, общие записи, фотографии, отметки отбора проб и календарь бригады обновляются при подключении к интернету. Для ответов коллег на экране телефона войдите с отметкой «Запомнить меня» и включите уведомления в приложении. Android запрашивает разрешение на уведомления отдельно.

Фоновая проверка ответов планируется примерно раз в 15 минут. Android может задерживать её из-за экономии батареи, режима сна или ограничений телефона; мгновенная доставка не гарантируется. После принудительной остановки приложения откройте его снова. Все ответы сохраняются в разделе «Уведомления». Выключение уведомлений или выход из профиля останавливает фоновую проверку. Через 30 дней либо после окончания сеанса потребуется войти заново.

Сборка на Windows: `pwsh -File android/build-release.ps1`. Скрипт сначала заново копирует текущую папку `dist` в Android assets, затем собирает, подписывает и проверяет APK. Исходная папка `dist` не меняется.

Зависимости для этого скрипта хранятся отдельно, по умолчанию в `D:\sites\android-build-tools`: JDK 17 в `jdk17/<jdk-directory>`, Gradle 8.11.1 в `gradle-8.11.1`, Android SDK в `sdk` с `platforms;android-35` и `build-tools;35.0.0`. Прямые зависимости проекта: AGP 8.9.3, AndroidX WebKit 1.12.1, Core 1.15.0 и WorkManager 2.10.1. Альтернатива — открыть папку `android` в Android Studio и сначала выполнить `prepare-assets.ps1`.

Постоянный ключ обновлений и зашифрованный Windows DPAPI пароль хранятся отдельно, по умолчанию в `D:\sites\sdng6-brigade2-signing`. Они не входят в репозиторий. DPAPI привязан к текущей учётной записи Windows. Сохраняйте резервную копию ключа и доступного пароля для будущих обновлений; не публикуйте их. Скрипт берёт пароль из окружения процесса, а не аргументов командной строки.

GPS-адаптер Android заменяет стандартный `navigator.geolocation` на приём данных от системного `LocationManager.GPS_PROVIDER`. Параллельные разовые запросы и подписки независимы. Для импорта, экспорта и выбора до трёх фотографий используются системные окна. Встроенный WebView загружает упакованные assets и обращается к разрешённому адресу API бригады; внешние ссылки открываются в браузере и не получают доступ к Android bridge.

Для фоновых уведомлений сохраняется только токен сеанса в зашифрованном виде AES-GCM с ключом Android Keystore; пароль Android-часть не сохраняет. Выход удаляет токен, отменяет задания WorkManager и показанные уведомления. Повторные ответы отсекаются по сохранённым идентификаторам. Android API ограничен конкретным HTTPS-адресом, переходы HTTP не допускаются.

Официальные источники:

- [Android: локальные ресурсы и WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Android: runtime permissions](https://developer.android.com/training/permissions/requesting)
- [Android: LocationManager](https://developer.android.com/reference/android/location/LocationManager)
- [AndroidX WebKit releases](https://developer.android.com/jetpack/androidx/releases/webkit#1.12.1)
- [WorkManager: периодическая работа и ограничения времени](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest)
- [Разрешение Android на уведомления](https://developer.android.com/develop/ui/compose/notifications/notification-permission)
- [Android Gradle Plugin 8.9 compatibility](https://developer.android.com/build/releases/agp-8-9-0-release-notes)
- [Android SDK tools](https://developer.android.com/studio#command-tools)
- [Gradle 8.11.1](https://gradle.org/releases/)
- [Eclipse Temurin archives and checksum verification](https://adoptium.net/installation/archives)
