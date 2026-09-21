// ModMind replacement for the screenshot helper in minecraft-mod-mcp v0.3.0.
// Reads the actual displayed OpenGL front buffer. No guessed obfuscated fields,
// stale frame cache, alpha replacement, coordinate grid or desktop capture.
package xyz.langyo.minecraft.mcp.common;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

public final class ScreenshotHelper {
    private static volatile boolean capturing;
    private static volatile boolean video;
    private ScreenshotHelper() {}
    public static boolean isScreenshotInProgress() { return capturing; }
    public static void setVideoCaptureActive(boolean value) { video = value; }
    public static boolean isVideoCaptureActive() { return video; }
    public static void cacheFrameFromRenderThread(Object mc) {}
    public static void tickVideoCapture(Object mc) {}
    public static byte[] captureFrameJpeg(Object mc) { return capture(mc, "jpg"); }
    public static byte[] takeScreenshot(Object mc, int ignoredWidth, int ignoredHeight) { return capture(mc, "png"); }

    private static byte[] capture(Object mc, String format) {
        final byte[][] result = new byte[1][];
        final Exception[] error = new Exception[1];
        final CountDownLatch done = new CountDownLatch(1);
        Runnable action = () -> {
            capturing = true;
            try { result[0] = readFrame(format); }
            catch (Exception e) { error[0] = e; }
            finally { capturing = false; done.countDown(); }
        };
        String thread = Thread.currentThread().getName();
        if (thread.contains("Render") || thread.equals("Client thread")) action.run();
        else {
            try {
                Class.forName("xyz.langyo.minecraft.mcp.common.ReflectedInputHandler")
                    .getMethod("executeOnRenderThread", Runnable.class).invoke(null, action);
                if (!done.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("render capture timed out");
            } catch (Exception e) { throw new IllegalStateException("Cannot schedule native screenshot", e); }
        }
        if (error[0] != null) throw new IllegalStateException("Native framebuffer capture failed", error[0]);
        return result[0];
    }

    private static byte[] readFrame(String format) throws Exception {
        Class<?> gl = Class.forName("org.lwjgl.opengl.GL11");
        Method get = gl.getMethod("glGetInteger", int.class);
        int width, height;
        try {
            Class<?> glfw = Class.forName("org.lwjgl.glfw.GLFW");
            long window = (Long) glfw.getMethod("glfwGetCurrentContext").invoke(null);
            if (window == 0) throw new IllegalStateException("no current OpenGL context");
            IntBuffer w = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            IntBuffer h = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            glfw.getMethod("glfwGetFramebufferSize", long.class, IntBuffer.class, IntBuffer.class).invoke(null, window, w, h);
            width = w.get(0); height = h.get(0);
        } catch (ClassNotFoundException lwjgl2) {
            Class<?> display = Class.forName("org.lwjgl.opengl.Display");
            width = (Integer) display.getMethod("getWidth").invoke(null);
            height = (Integer) display.getMethod("getHeight").invoke(null);
        }
        if (width <= 0 || height <= 0 || (long) width * height > 16777216) throw new IllegalStateException("invalid framebuffer dimensions");
        Class<?> gl30 = Class.forName("org.lwjgl.opengl.GL30");
        Method bind = gl30.getMethod("glBindFramebuffer", int.class, int.class);
        Method readBuffer = gl.getMethod("glReadBuffer", int.class);
        Method pixelStore = gl.getMethod("glPixelStorei", int.class, int.class);
        int previousFramebuffer = (Integer) get.invoke(null, 0x8CAA); // GL_READ_FRAMEBUFFER_BINDING
        int previousReadBuffer = (Integer) get.invoke(null, 0x0C02);
        int[] settings = { 0x0D05, 0x0D02, 0x0D03, 0x0D04 }; // pack alignment/row length/skip rows/skip pixels
        int[] previousSettings = new int[settings.length];
        for (int i = 0; i < settings.length; i++) previousSettings[i] = (Integer) get.invoke(null, settings[i]);
        ByteBuffer pixels = ByteBuffer.allocateDirect(width * height * 4);
        try {
            bind.invoke(null, 0x8CA8, 0); // GL_READ_FRAMEBUFFER, default window framebuffer
            readBuffer.invoke(null, 0x0404); // GL_FRONT: last displayed complete frame
            for (int i = 0; i < settings.length; i++) pixelStore.invoke(null, settings[i], i == 0 ? 1 : 0);
            gl.getMethod("glReadPixels", int.class, int.class, int.class, int.class, int.class, int.class, ByteBuffer.class)
                .invoke(null, 0, 0, width, height, 0x1908, 0x1401, pixels); // RGBA, unsigned byte
        } finally {
            bind.invoke(null, 0x8CA8, previousFramebuffer);
            readBuffer.invoke(null, previousReadBuffer);
            for (int i = 0; i < settings.length; i++) pixelStore.invoke(null, settings[i], previousSettings[i]);
        }
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int index = (y * width + x) * 4;
            int rgb = ((pixels.get(index) & 255) << 16) | ((pixels.get(index + 1) & 255) << 8) | (pixels.get(index + 2) & 255);
            image.setRGB(x, height - y - 1, rgb);
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, format, bytes);
        return bytes.toByteArray();
    }
}
