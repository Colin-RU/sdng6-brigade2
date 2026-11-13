package ru.brigade2.atlas;

public final class NotificationContentTest {
    private static int assertions;
    private static void check(boolean value) { assertions++; if(!value)throw new AssertionError("Assertion "+assertions); }
    public static void main(String[] args) {
        NotificationContent.Summary chat=NotificationContent.create("chat","chat","Оператор","Чат бригады","Новая запись");
        check(chat.title.equals("Оператор написал в чат"));check(chat.body.equals("Новая запись"));check(!chat.title.contains("ответил"));
        NotificationContent.Summary reply=NotificationContent.create("comment","equipment:856:p2:agzu","Мастер","Куст 856 · 2п · АГЗУ","Проверено");
        check(reply.title.equals("Мастер · ответ: Куст 856 · 2п · АГЗУ"));check(reply.body.equals("Проверено"));
        check(NotificationContent.create("comment","chat",null,null,"").title.equals("Коллега написал в чат"));
        check(NotificationContent.create("chat","chat",null,null,"").body.equals("Новое сообщение в чате"));
        check(NotificationContent.create("comment","pad:162",null,null,null).body.equals("Новый ответ на вашу запись"));
        check(NotificationContent.create("chat","chat","А\nБ",null,"Текст\r\nсообщения").body.equals("Текст сообщения"));
        NotificationContent.Summary longText=NotificationContent.create("chat","chat","🙂".repeat(80),null,"x".repeat(400));
        check(longText.title.startsWith("🙂".repeat(60)+"…"));check(longText.body.equals("x".repeat(300)+"…"));
        check(chat.channelId.equals("brigade_chat_messages"));check(reply.channelId.equals("brigade_replies_v1"));
        check(!chat.channelId.equals(reply.channelId));check(!chat.groupKey.equals(reply.groupKey));check(chat.color!=reply.color);
        check(NotificationContent.create("comment","chat",null,null,null).channelId.equals(NotificationContent.CHAT_CHANNEL));
        check(NotificationContent.create("chat","pad:162",null,null,null).groupKey.equals(NotificationContent.CHAT_GROUP));
        check(NotificationContent.create("comment","well:163:2655",null,null,null).groupKey.equals(NotificationContent.WORK_GROUP));
        NotificationContent.Summary round=NotificationContent.create("sampling-round","sampling",null,"Отбор проб","Круг 2 · 8–15 ноября");
        check(round.title.equals("Начался новый круг отбора"));check(round.body.equals("Круг 2 · 8–15 ноября"));
        check(round.channelId.equals(NotificationContent.WORK_CHANNEL));check(round.groupKey.equals(NotificationContent.WORK_GROUP));
        check(!NotificationContent.create("sampling-round","sampling","Не должен отображаться",null,null).title.contains("Не должен"));
        check(NotificationContent.create("sampling-round","sampling",null,null,null).body.equals("Откройте отбор проб, чтобы увидеть новый круг."));
        NotificationContent.Summary mention=NotificationContent.create("chat","chat","Мастер","Чат бригады","@operator проверьте куст",true);
        check(mention.title.equals("Вас упомянули · Мастер"));check(mention.channelId.equals(NotificationContent.CHAT_CHANNEL));check(mention.body.equals("@operator проверьте куст"));
        System.out.println("PASS "+assertions+" native chat/work content and channel assertions");
    }
}
