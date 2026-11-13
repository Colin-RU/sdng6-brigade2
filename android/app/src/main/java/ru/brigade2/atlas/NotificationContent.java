package ru.brigade2.atlas;

/** Plain text shared by the native notification presenter and its JVM checks. */
final class NotificationContent {
    static final String WORK_CHANNEL = "brigade_replies_v1", CHAT_CHANNEL = "brigade_chat_messages";
    static final String WORK_GROUP = "brigade_work_objects", CHAT_GROUP = "brigade_chat";
    static final class Summary {
        final String title, body, channelId, groupKey;
        final int color;
        Summary(String title, String body, boolean chat) {
            this.title = title; this.body = body;
            channelId = chat ? CHAT_CHANNEL : WORK_CHANNEL;
            groupKey = chat ? CHAT_GROUP : WORK_GROUP;
            color = chat ? 0xff246fc0 : 0xff167c8a;
        }
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
        String title = name + (chat ? " написал в чат" : " · ответ: " + clean(objectLabel, 100, "Запись бригады"));
        String text = clean(preview, 300, chat ? "Новое сообщение в чате" : "Новый ответ на вашу запись");
        return new Summary(title, text, chat);
    }
}
