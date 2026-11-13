package ru.brigade2.atlas;

public final class NotificationPolicyTest {
    private static int assertions;
    private static void check(boolean value) { assertions++; if(!value)throw new AssertionError("Assertion "+assertions); }
    public static void main(String[] args) {
        String allowed=NotificationPolicy.API_BASE;
        check(NotificationPolicy.allowedApiBase(allowed));
        for(String input:new String[]{"http"+allowed.substring(5),allowed+"/",allowed+"?token=sample",allowed+"#fragment",allowed+"/notifications",allowed.replace("supabase.co","supabase.co.example.org"),allowed.replace("https://","https://name@"),allowed.replace("supabase.co/","supabase.co:443/"),allowed.replace("/brigade-api","/other-function"),"https://appassets.androidplatform.net/api/v1",null})check(!NotificationPolicy.allowedApiBase(input));
        check(NotificationPolicy.validToken("a".repeat(64)));check(NotificationPolicy.validToken("a_b-c.d~".repeat(8)));
        for(String token:new String[]{"short","a".repeat(513),"a".repeat(64)+"\r\nInjected: value","a".repeat(64)+" value",null})check(!NotificationPolicy.validToken(token));
        check(NotificationPolicy.validId("notification:1234_ab-cd.ef"));check(!NotificationPolicy.validId("../a"));check(!NotificationPolicy.validId("x\nalert"));check(!NotificationPolicy.validId(""));check(!NotificationPolicy.validId("x".repeat(161)));
        long start=1700000000000L;check(!NotificationPolicy.expired(start,start));check(!NotificationPolicy.expired(start,start+NotificationPolicy.MAX_SESSION_MILLIS-1));check(NotificationPolicy.expired(start,start+NotificationPolicy.MAX_SESSION_MILLIS));check(NotificationPolicy.expired(start,start-60001));check(NotificationPolicy.expired(0,start));
        System.out.println("PASS "+assertions+" native notification endpoint/token/ID/expiry assertions");
    }
}
