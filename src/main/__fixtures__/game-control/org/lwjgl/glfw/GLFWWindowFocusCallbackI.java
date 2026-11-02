package org.lwjgl.glfw;
public interface GLFWWindowFocusCallbackI {
    default void callback(long arguments) { invoke(1, false); }
    void invoke(long window, boolean focused);
}
