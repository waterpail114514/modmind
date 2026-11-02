package org.lwjgl.glfw;
public interface GLFWKeyCallbackI {
    default void callback(long result, long arguments) { invoke(1, 87, 0, 1, 0); }
    void invoke(long window, int key, int scancode, int action, int mods);
}
