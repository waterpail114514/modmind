/* ModMind 26.3 client adapter. SPDX-License-Identifier: AGPL-3.0-only */
package xyz.langyo.minecraft.mcp.common;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.events.ContainerEventHandler;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Uses the public 26.3 API, including SDL input and asynchronous GPU readback.
 * The upstream server/protocol and control-mode gate remain in use.
 */
public final class ModMind263InputHandler extends ReflectedInputHandler {
    public ModMind263InputHandler(RenderThreadExecutor executor) { super(executor); }

    private static Minecraft mc() { return Minecraft.getInstance(); }
    private static String json(JsonObject value) { return value.toString(); }
    private static String error(Throwable failure) {
        JsonObject value = new JsonObject();
        value.addProperty("error", failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage());
        return json(value);
    }
    private static <T> T await(CompletableFuture<T> future) throws Exception {
        try { return future.get(10, TimeUnit.SECONDS); }
        finally { future.cancel(false); }
    }
    // Wait only on the HTTP worker. A timed-out queued mutation is cancelled.
    private static String onClient(Callable<String> task) {
        CompletableFuture<String> future = new CompletableFuture<>();
        mc().execute(() -> {
            if (future.isDone()) return;
            try { future.complete(task.call()); }
            catch (Exception | LinkageError failure) { future.completeExceptionally(failure); }
        });
        try { return await(future); }
        catch (Exception failure) { return error(failure); }
    }

    @Override protected Object handleScreenshot() {
        CompletableFuture<byte[]> future = new CompletableFuture<>();
        mc().execute(() -> {
            if (future.isDone()) return;
            try {
                // Vanilla owns backend selection, readback and row orientation.
                Screenshot.takeScreenshot(mc().gameRenderer.mainRenderTarget(), image -> {
                    try (image) {
                        if (future.isDone()) return;
                        int width = image.getWidth(), height = image.getHeight();
                        if (width < 1 || height < 1 || (long) width * height > 16_777_216L)
                            throw new IllegalStateException("Screenshot dimensions exceed the limit");
                        BufferedImage png = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
                        png.setRGB(0, 0, width, height, image.getPixels(), 0, width);
                        ByteArrayOutputStream output = new ByteArrayOutputStream();
                        if (!ImageIO.write(png, "png", output)) throw new IllegalStateException("PNG encoder unavailable");
                        if (output.size() > 8 * 1024 * 1024) throw new IllegalStateException("Screenshot exceeds 8 MiB");
                        future.complete(output.toByteArray());
                    } catch (Exception | LinkageError failure) { future.completeExceptionally(failure); }
                });
            } catch (Exception | LinkageError failure) { future.completeExceptionally(failure); }
        });
        try { return "data:image/png;base64," + Base64.getEncoder().encodeToString(await(future)); }
        catch (Exception failure) { return "error: " + failure.getMessage(); }
    }

    private static List<AbstractWidget> widgets(Screen screen) {
        List<AbstractWidget> result = new ArrayList<>();
        Set<GuiEventListener> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        collect(screen, result, visited, 0);
        return result;
    }
    private static void collect(GuiEventListener item, List<AbstractWidget> out, Set<GuiEventListener> visited, int depth) {
        if (item == null || depth > 32 || visited.size() >= 4096 || !visited.add(item)) return;
        if (item instanceof AbstractWidget widget && widget.visible) out.add(widget);
        if (item instanceof ContainerEventHandler container)
            for (GuiEventListener child : container.children()) collect(child, out, visited, depth + 1);
    }
    @Override protected Object handleGetScreenButtons() {
        return onClient(() -> {
            Screen screen = mc().gui.screen();
            JsonObject value = new JsonObject();
            value.addProperty("screen", screen == null ? "none" : screen.getClass().getName());
            value.addProperty("title", screen == null ? "" : screen.getTitle().getString());
            value.addProperty("width", mc().getWindow().getWidth());
            value.addProperty("height", mc().getWindow().getHeight());
            value.addProperty("guiWidth", mc().getWindow().getGuiScaledWidth());
            value.addProperty("guiHeight", mc().getWindow().getGuiScaledHeight());
            JsonArray buttons = new JsonArray();
            for (AbstractWidget widget : widgets(screen)) {
                JsonObject button = new JsonObject();
                button.addProperty("index", buttons.size());
                button.addProperty("label", widget.getMessage().getString());
                button.addProperty("x", widget.getX()); button.addProperty("y", widget.getY());
                button.addProperty("width", widget.getWidth()); button.addProperty("height", widget.getHeight());
                button.addProperty("active", widget.active); button.addProperty("visible", widget.visible);
                buttons.add(button);
            }
            value.add("buttons", buttons);
            return json(value);
        });
    }
    // Coordinates in the protocol are pixels in the original screenshot.
    private static String clickGui(double x, double y, String button) {
        int sdlButton = switch (button) { case "left" -> 1; case "middle" -> 2; case "right" -> 3;
            default -> throw new IllegalArgumentException("Unknown mouse button"); };
        Screen screen = mc().gui.screen();
        if (screen == null) throw new IllegalStateException("No GUI screen; use interact for world interaction");
        MouseButtonEvent event = new MouseButtonEvent(x, y, new MouseButtonInfo(sdlButton, 0));
        boolean handled = screen.mouseClicked(event, false);
        screen.mouseReleased(event);
        screen.afterMouseAction();
        if (!handled) throw new IllegalStateException("No widget accepted the click");
        return "{\"clicked\":true}";
    }
    @Override protected Object handleClick(Map<String, String> params) {
        return onClient(() -> {
            int x = Integer.parseInt(params.get("x")), y = Integer.parseInt(params.get("y"));
            var window = mc().getWindow();
            if (x < 0 || y < 0 || x >= window.getWidth() || y >= window.getHeight())
                throw new IllegalArgumentException("Click is outside the current screenshot");
            return clickGui(x * (double) window.getGuiScaledWidth() / window.getWidth(),
                    y * (double) window.getGuiScaledHeight() / window.getHeight(), params.getOrDefault("button", "left"));
        });
    }
    @Override protected Object handleClickButtonIndex(Map<String, String> params) {
        return onClient(() -> {
            List<AbstractWidget> buttons = widgets(mc().gui.screen());
            int index = Integer.parseInt(params.get("index"));
            if (index < 0 || index >= buttons.size()) throw new IllegalArgumentException("Widget index is no longer available");
            AbstractWidget widget = buttons.get(index);
            if (!widget.active) throw new IllegalStateException("Widget is disabled");
            return clickGui(widget.getX() + widget.getWidth() / 2.0, widget.getY() + widget.getHeight() / 2.0, "left");
        });
    }
    @Override protected Object handlePressKey(Map<String, String> params) {
        try {
            String name = params.get("key");
            if (name == null || !name.matches("key\\.keyboard\\.[a-z0-9.]+")) throw new IllegalArgumentException("Invalid keyboard key");
            int key = InputConstants.getKey(name).getValue();
            float seconds = Float.parseFloat(params.getOrDefault("hold_seconds", "0"));
            if (!Float.isFinite(seconds) || seconds < 0 || seconds > 2) throw new IllegalArgumentException("Key hold exceeds 2 seconds");
            String pressed = onClient(() -> {
                mc().keyboardHandler.keyPress(mc().getWindow().handle(), InputConstants.PRESS, new KeyEvent(key, 0, 0));
                return "{\"pressed\":true}";
            });
            if (pressed.contains("\"error\"")) return pressed;
            try { if (seconds > 0) Thread.sleep((long) (seconds * 1000)); }
            finally {
                String released = onClient(() -> {
                    mc().keyboardHandler.keyPress(mc().getWindow().handle(), InputConstants.RELEASE, new KeyEvent(key, 0, 0));
                    return "{\"released\":true}";
                });
                if (released.contains("\"error\"")) return released;
            }
            return pressed;
        } catch (Exception failure) { return error(failure); }
    }
    @Override protected Object handleTypeText(Map<String, String> params) {
        return onClient(() -> {
            Screen screen = mc().gui.screen();
            if (screen == null) throw new IllegalStateException("No text input screen");
            String text = params.get("text");
            if (text == null || text.length() > 4096) throw new IllegalArgumentException("Invalid text length");
            // CharacterEvent is the public non-IME path; handles Unicode code points.
            for (int point : text.codePoints().toArray()) screen.charTyped(new CharacterEvent(point));
            if (Boolean.parseBoolean(params.getOrDefault("press_enter", "false")))
                screen.keyPressed(new KeyEvent(InputConstants.KEY_RETURN, 0, 0));
            return "{\"typed\":true}";
        });
    }
    @Override protected Object handleScroll(Map<String, String> params) {
        return onClient(() -> {
            Screen screen = mc().gui.screen();
            if (screen == null) throw new IllegalStateException("No GUI screen");
            int clicks = Integer.parseInt(params.getOrDefault("clicks", "0"));
            if (Math.abs((long) clicks) > 20) throw new IllegalArgumentException("Scroll exceeds limit");
            screen.mouseScrolled(mc().mouseHandler.getScaledXPos(mc().getWindow()), mc().mouseHandler.getScaledYPos(mc().getWindow()), 0, clicks);
            return "{\"scrolled\":true}";
        });
    }
    @Override protected Object handleCloseScreen() {
        return onClient(() -> { Screen screen = mc().gui.screen(); if (screen != null) screen.onClose(); return "{\"closed\":true}"; });
    }
    @Override protected Object handleSetViewAngle(Map<String, String> params) {
        return onClient(() -> {
            if (mc().player == null) throw new IllegalStateException("No player");
            float yaw = Float.parseFloat(params.get("yaw")), pitch = Float.parseFloat(params.get("pitch"));
            if (!Float.isFinite(yaw) || !Float.isFinite(pitch) || Math.abs(yaw) > 180 || Math.abs(pitch) > 90) throw new IllegalArgumentException("Invalid view angle");
            mc().player.setYRot(yaw); mc().player.setXRot(pitch);
            return "{\"view_set\":true}";
        });
    }
    @Override protected Object handleExecuteCommand(Map<String, String> params) {
        return onClient(() -> {
            if (mc().player == null) throw new IllegalStateException("No player");
            String command = params.get("command");
            if (command == null || command.length() > 4096 || !command.startsWith("/")) throw new IllegalArgumentException("Invalid command");
            mc().player.connection.sendCommand(command.substring(1));
            return "{\"sent\":true}";
        });
    }
    @Override protected Object handleGetPlayerInfo() {
        return onClient(() -> {
            JsonObject value = new JsonObject(); value.addProperty("present", mc().player != null);
            if (mc().player != null) {
                value.addProperty("x", mc().player.getX()); value.addProperty("y", mc().player.getY()); value.addProperty("z", mc().player.getZ());
                value.addProperty("yaw", mc().player.getYRot()); value.addProperty("pitch", mc().player.getXRot());
                value.addProperty("health", mc().player.getHealth());
            }
            return json(value);
        });
    }
    @Override protected Object handleGetWorldInfo() {
        return onClient(() -> {
            JsonObject value = new JsonObject(); value.addProperty("present", mc().level != null);
            if (mc().level != null) {
                value.addProperty("dimension", mc().level.dimension().identifier().toString());
                value.addProperty("gameTime", mc().level.getGameTime());
            }
            return json(value);
        });
    }
    @Override protected Object handleRightClick() {
        return onClient(() -> {
            if (mc().player == null || mc().gui.screen() != null) throw new IllegalStateException("World interaction requires an active world without a GUI");
            MouseButtonInfo button = new MouseButtonInfo(3, 0);
            mc().mouseHandler.onButton(mc().getWindow().handle(), button, InputConstants.PRESS);
            mc().mouseHandler.onButton(mc().getWindow().handle(), button, InputConstants.RELEASE);
            return "{\"interacted\":true}";
        });
    }
}
