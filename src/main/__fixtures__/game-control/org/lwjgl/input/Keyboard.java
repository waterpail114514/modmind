package org.lwjgl.input;
public class Keyboard {
    public static void poll() {}
    public static boolean next() { return false; }
    public static boolean isKeyDown(int code) { return true; }
    public static int getEventKey() { return 999; }
    public static boolean getEventKeyState() { return false; }
    public static char getEventCharacter() { return 0; }
    public static long getEventNanoseconds() { return 0; }
    public static boolean isRepeatEvent() { return false; }
}
