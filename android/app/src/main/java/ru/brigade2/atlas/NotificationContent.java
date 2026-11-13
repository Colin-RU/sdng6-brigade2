package ru.brigade2.atlas;

/** Plain text shared by the native notification presenter and its JVM checks. */
final class NotificationContent {
    static final class Summary {
        final String title, body;
        Summary(String title, String body) { this.title = title; this.body = body; }
    }
    private NotificationContent() { }
    private static String clean(String value, int limit, String fallback) {
        String text = value == null ? "" : value.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
        if (text.isEmpty()) text = fallback;
        return text.codePointCount(0, text.length()) > limit ? text.substring(0, text.offsetByCodePoints(0, limit)) + "…" : text;
    }
    static Summary create(String type, String objectKey, String actor, String objectLabel, String preview) {
        boolean chat = "chat".equals(type) || "chat".equals(objectKey);
        String name = clean(actor, 60, "Коллега");
        String title = name + (chat ? " написал в чат" : " ответил на запись");
        String text = clean(preview, 300, chat ? "Новое сообщение в чате" : "Новый ответ на вашу запись");
        String body = chat ? text : clean(objectLabel, 100, "Запись бригады") + ": " + text;
        return new Summary(title, body);
    }
}
