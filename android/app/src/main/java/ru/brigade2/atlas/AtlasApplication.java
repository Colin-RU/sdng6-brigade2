package ru.brigade2.atlas;

import android.app.Application;

public final class AtlasApplication extends Application {
    @Override public void onCreate() { super.onCreate(); NativePush.initialize(this); }
}
