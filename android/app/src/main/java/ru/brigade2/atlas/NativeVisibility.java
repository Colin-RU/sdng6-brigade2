package ru.brigade2.atlas;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/** Started activities are visible; a stopped but still allocated activity is not. */
final class NativeVisibility {
    private static final Set<Object> started=Collections.newSetFromMap(new IdentityHashMap<>());
    private NativeVisibility() { }
    static synchronized void started(Object activity){started.add(activity);}
    static synchronized void stopped(Object activity){started.remove(activity);}
    static synchronized boolean visible(){return !started.isEmpty();}
    static synchronized void whileHidden(Runnable action){if(started.isEmpty())action.run();}
}
