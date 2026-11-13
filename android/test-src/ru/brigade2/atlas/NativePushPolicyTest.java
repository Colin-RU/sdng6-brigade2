package ru.brigade2.atlas;

public final class NativePushPolicyTest {
    private static int count;
    private static void check(boolean value){count++;if(!value)throw new AssertionError("Assertion "+count);}
    public static void main(String[] args){
        String app="1:123456789:android:abcdef0123456789",key="AIza"+"A".repeat(35),project="brigade-atlas",sender="123456789";
        check(NativePushPolicy.validConfig(app,key,project,sender));
        check(!NativePushPolicy.validConfig("",key,project,sender));check(!NativePushPolicy.validConfig(app,key,project,"987654321"));
        check(!NativePushPolicy.validConfig(app,"placeholder",project,sender));check(!NativePushPolicy.validConfig(app,key,"../invalid",sender));
        check(!NativePushPolicy.validConfig(app,key,project,null));
        check(NativePushPolicy.validFcmToken("abcDEF_01234:abcdefghijklmnopqrstuvwxyz-123.456"));
        check(NativePushPolicy.validFcmToken("opaque~token/with+symbols=0123456789"));
        for(String token:new String[]{"", "short", "a".repeat(4097),"validtoken1234567890\nHeader: injected","token with whitespace 01234567890"})check(!NativePushPolicy.validFcmToken(token));
        check(NativePushPolicy.sameGeneration("profile-a-session-1","profile-a-session-1"));
        check(!NativePushPolicy.sameGeneration("profile-a-session-1","profile-b-session-2"));
        check(!NativePushPolicy.sameGeneration(null,"profile-b-session-2"));check(!NativePushPolicy.sameGeneration("", ""));
        String id="12345678-1234-1234-1234-123456789abc",secret="A".repeat(43);
        check(NativePushPolicy.validIdentity(id,secret));check(!NativePushPolicy.validIdentity(id,"A".repeat(42)));check(!NativePushPolicy.validIdentity("../other-device",secret));check(!NativePushPolicy.validIdentity(id,"\n"+secret.substring(1)));
        check(NativePushPolicy.registrationDue(120000,0,false));check(!NativePushPolicy.registrationDue(120000,119000,false));
        check(NativePushPolicy.registrationDue(120000,60000,false));check(NativePushPolicy.registrationDue(120000,119000,true));check(NativePushPolicy.registrationDue(120000,121000,false));
        System.out.println("PASS "+count+" FCM configuration, token, identity and session-isolation assertions");
    }
}
