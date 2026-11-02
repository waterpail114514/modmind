import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.lwjgl.input.*;
import org.lwjgl.opengl.Display;
import org.lwjgl.glfw.*;

/** Synthetic input consumer only. Real framebuffer proof lives in the game smoke runs. */
public class ControlFixture {
    public static void main(String[] arguments) throws Exception {
        Path root = Paths.get(arguments[0]); int presses = 0, releases = 0, characters = 0, selectAll = 0;
        final int[] callbacks = { 0 };
        GLFWKeyCallbackI keyCallback = (window, key, scancode, action, mods) -> callbacks[0]++;
        GLFWWindowFocusCallbackI focusCallback = (window, focused) -> callbacks[0]++;
        // Both native closure signatures must be filtered, while direct virtual
        // invokes remain callable. A missing signature produces 4 rather than 2.
        keyCallback.callback(0, 0); focusCallback.callback(0);
        keyCallback.invoke(1, 87, 0, 1, 0); focusCallback.invoke(1, true);
        for (;;) {
            if (!Files.exists(root.resolve("pause"))) {
                Display.width = Files.exists(root.resolve("resize")) ? 800 : 640;
                Display.processMessages();
                org.lwjgl.opengl.WindowsDisplay.resizeStyle();
                while (Keyboard.next()) {
                    if (Keyboard.getEventKeyState()) presses++; else releases++;
                    if (Keyboard.getEventCharacter() != 0) characters++;
                    if (Keyboard.getEventCharacter() == 1) selectAll++;
                }
                while (Mouse.next()) {}
                Display.swapBuffers();
                String result = "{\"presses\":" + presses + ",\"releases\":" + releases + ",\"characters\":" + characters +
                    ",\"selectAll\":" + selectAll + ",\"key\":" + Keyboard.isKeyDown(17) + ",\"button\":" + Mouse.isButtonDown(0) + ",\"focus\":" + Display.isActive() + ",\"positionFlags\":" + org.lwjgl.opengl.WindowsDisplay.flags + ",\"callbackInvocations\":" + callbacks[0] + "}";
                Files.write(root.resolve("consumer.json.tmp"), result.getBytes(StandardCharsets.UTF_8));
                try {
                    Files.move(root.resolve("consumer.json.tmp"), root.resolve("consumer.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AccessDeniedException reading) {
                    // A Windows reader may briefly deny replacement. Preserve
                    // the previous complete snapshot and retry on the next frame.
                }
            }
            Thread.sleep(10);
        }
    }
}
