package ru.brigade2.atlas;

public final class NotificationContentTest {
    private static int assertions;
    private static void check(boolean value) { assertions++; if(!value)throw new AssertionError("Assertion "+assertions); }
    public static void main(String[] args) {
        NotificationContent.Summary chat=NotificationContent.create("chat","chat","Оператор","Чат бригады","Новая запись");
        check(chat.title.equals("Оператор написал в чат"));check(chat.body.equals("Новая запись"));check(!chat.title.contains("ответил"));
        NotificationContent.Summary reply=NotificationContent.create("comment","equipment:856:p2:agzu","Мастер","Куст 856 · 2п · АГЗУ","Проверено");
        check(reply.title.equals("Мастер ответил на запись"));check(reply.body.equals("Куст 856 · 2п · АГЗУ: Проверено"));
        check(NotificationContent.create("comment","chat",null,null,"").title.equals("Коллега написал в чат"));
        check(NotificationContent.create("chat","chat",null,null,"").body.equals("Новое сообщение в чате"));
        check(NotificationContent.create("comment","pad:162",null,null,null).body.equals("Запись бригады: Новый ответ на вашу запись"));
        check(NotificationContent.create("chat","chat","А\nБ",null,"Текст\r\nсообщения").body.equals("Текст сообщения"));
        NotificationContent.Summary longText=NotificationContent.create("chat","chat","🙂".repeat(80),null,"x".repeat(400));
        check(longText.title.startsWith("🙂".repeat(60)+"…"));check(longText.body.equals("x".repeat(300)+"…"));
        System.out.println("PASS "+assertions+" native chat/reply content assertions");
    }
}
