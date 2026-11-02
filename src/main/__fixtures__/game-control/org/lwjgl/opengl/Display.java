package org.lwjgl.opengl;
public class Display {
    public static boolean isActive() { return false; }
    public static boolean isVisible() { return true; }
    public static void processMessages() {}
    public static void swapBuffers() {}
    public static int width = 640;
    public static int getWidth() { return width; }
    public static int getHeight() { return 360; }
}
