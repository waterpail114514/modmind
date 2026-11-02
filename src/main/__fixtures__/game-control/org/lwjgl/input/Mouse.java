package org.lwjgl.input;
public class Mouse {
    public static void poll() {}
    public static boolean next() { return false; }
    public static boolean isButtonDown(int code) { return true; }
    public static int getX() { return -999; }
    public static int getY() { return -999; }
    public static int getDX() { return -999; }
    public static int getDY() { return -999; }
    public static int getEventButton() { return -1; }
    public static boolean getEventButtonState() { return false; }
    public static void setGrabbed(boolean grabbed) {}
    public static void setCursorPosition(int x, int y) {}
}
