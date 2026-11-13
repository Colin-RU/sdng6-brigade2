package ru.brigade2.atlas;

import java.net.URI;

/** Public endpoint policy; contains no credentials. */
final class NotificationPolicy {
    static final String API_BASE = "https://ufwrdwndlzwxtlkougrv.supabase.co/functions/v1/brigade-api";
    static final long MAX_SESSION_MILLIS = 30L * 24 * 60 * 60 * 1000;
    private NotificationPolicy() { }

    static boolean allowedApiBase(String input) {
        if (input == null) return false;
        try {
            URI uri = new URI(input);
            return "https".equals(uri.getScheme())
                && "ufwrdwndlzwxtlkougrv.supabase.co".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getRawUserInfo() == null
                && uri.getRawQuery() == null && uri.getRawFragment() == null
                && "/functions/v1/brigade-api".equals(uri.getRawPath())
                && API_BASE.equals(input);
        } catch (Exception ignored) { return false; }
    }

    static boolean validToken(String token) {
        return token != null && token.length() >= 32 && token.length() <= 512
            && token.matches("[A-Za-z0-9._~+/=-]+") && !token.contains("\n") && !token.contains("\r");
    }

    static boolean validId(String id) { return id != null && id.matches("[A-Za-z0-9._:-]{1,160}"); }
    static boolean expired(long createdAt, long now) { return createdAt <= 0 || now < createdAt - 60000 || now - createdAt >= MAX_SESSION_MILLIS; }
}
