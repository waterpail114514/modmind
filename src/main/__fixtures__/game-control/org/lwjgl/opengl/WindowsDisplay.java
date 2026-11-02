package org.lwjgl.opengl;

/** Peer boundary fixture; native activation is separately checked in Minecraft. */
public final class WindowsDisplay {
    public static long flags;
    private static boolean setWindowPos(long window, long after, int x, int y, int width, int height, long value) { flags = value; return true; }
    public static void resizeStyle() { setWindowPos(1, 0, 0, 0, 640, 360, 36); }
}
