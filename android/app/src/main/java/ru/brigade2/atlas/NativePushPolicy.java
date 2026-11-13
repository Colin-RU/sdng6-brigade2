package ru.brigade2.atlas;

/** Deterministic validation shared with plain JVM security checks. */
final class NativePushPolicy {
    private NativePushPolicy() { }
    static boolean validConfig(String app, String key, String project, String sender) {
        return sender != null && sender.matches("[0-9]{4,20}") && app != null
            && app.matches("1:[0-9]+:android:[a-fA-F0-9]+") && app.startsWith("1:" + sender + ":android:")
            && key != null && key.matches("AIza[A-Za-z0-9_-]{30,60}")
            && project != null && project.matches("[a-z][a-z0-9-]{4,28}[a-z0-9]");
    }
    static boolean validFcmToken(String value) { return value != null && value.length() >= 20 && value.length() <= 4096 && value.matches("[\\x21-\\x7e]+"); }
    static boolean sameGeneration(String expected, String current) { return expected != null && !expected.isEmpty() && expected.equals(current); }
    static boolean registrationDue(long now,long lastQueued,boolean force){return force||lastQueued<=0||now<lastQueued||now-lastQueued>=60000;}
    static boolean validIdentity(String id, String secret) { return id != null && id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}") && secret != null && secret.matches("[A-Za-z0-9_-]{43}"); }
}
