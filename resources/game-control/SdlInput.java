package dev.modmind.gamecontrol;

import java.lang.reflect.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.*;

/** SDL3 adapter. Events stay in this owned JVM; no native event injection. */
public final class SdlInput {
    private static ClassLoader loader;
    private static Class<?> events, video, keyboard, eventType;
    private static long window;
    private static int windowId;
    private static boolean focusSent, relative;
    private static Object client;
    private static double x, y;
    private static double relativeX, relativeY;
    private static final ByteBuffer keyState = ByteBuffer.allocateDirect(512);
    private static final Set<Integer> keys = new HashSet<Integer>(), buttons = new HashSet<Integer>();
    private static final ArrayDeque<Envelope> queue = new ArrayDeque<Envelope>();
    private static Envelope previous;
    private static final Map<String,Method> methods = new java.util.concurrent.ConcurrentHashMap<String,Method>();
    private static class Envelope {
        final Object event; final ByteBuffer storage; ByteBuffer text;
        Envelope(Object event, ByteBuffer storage) { this.event = event; this.storage = storage; }
    }
    private SdlInput() {}
    private static Class<?> api(String name) throws Exception { return Class.forName("org.lwjgl.sdl." + name, true, loader); }
    private static boolean matches(Class<?> type, Object value) {
        if (value == null) return !type.isPrimitive();
        if (!type.isPrimitive()) return type.isInstance(value);
        return type == int.class && value instanceof Integer || type == long.class && value instanceof Long || type == boolean.class && value instanceof Boolean || type == float.class && value instanceof Float || type == double.class && value instanceof Double || type == short.class && value instanceof Short || type == byte.class && value instanceof Byte;
    }
    private static Object call(Object target, String name, Object... args) throws Exception {
        Class<?> type = target instanceof Class ? (Class<?>) target : target.getClass();
        String key = type.getName() + ":" + name;
        for (Object value : args) key += ":" + (value == null ? "null" : value.getClass().getName());
        Method method = methods.get(key);
        if (method == null) {
            for (Method candidate : type.getMethods()) {
                if (!candidate.getName().equals(name) || candidate.getParameterTypes().length != args.length) continue;
                boolean match = true; Class<?>[] parameters = candidate.getParameterTypes();
                for (int index = 0; index < args.length; index++) if (!matches(parameters[index], args[index])) { match = false; break; }
                if (match) { method = candidate; methods.put(key, candidate); break; }
            }
        }
        if (method == null) throw new NoSuchMethodException(key);
        return method.invoke(target instanceof Class ? null : target, args);
    }
    private static void initialize(Class<?> binding) throws Exception {
        if (loader != null) return;
        loader = binding.getClassLoader();
        events = api("SDLEvents"); video = api("SDLVideo"); keyboard = api("SDLKeyboard"); eventType = api("SDL_Event");
        api("SDLMouse");
    }
    public static boolean ready() { return client != null && window != 0; }
    public static long window() { return window; }
    public static long windowFlags(long flags) { return InputBridge.active() ? flags | 1536L : flags; }
    public static void beforeCreate(Class<?> binding) {
        try {
            initialize(binding);
            Class<?> hints = api("SDLHints");
            call(hints, "SDL_SetHint", "SDL_WINDOW_ACTIVATE_WHEN_SHOWN", "0");
            call(hints, "SDL_SetHint", "SDL_WINDOW_ACTIVATE_WHEN_RAISED", "0");
        } catch (Exception invalid) { InputBridge.failure("SDL window hints", invalid); }
    }
    public static long createFlags(long flags) { return InputBridge.active() ? flags | 0x80000000L : flags; }
    public static void createProperties(Class<?> binding, int properties) {
        if (!InputBridge.active()) return;
        try { beforeCreate(binding); call(api("SDLProperties"), "SDL_SetBooleanProperty", properties, "SDL.window.create.focusable", false); }
        catch (Exception invalid) { InputBridge.failure("SDL creation properties", invalid); }
    }
    public static void beforeSubmit(Object minecraft) {
        try {
            Class<?> eventApi = Class.forName("org.lwjgl.sdl.SDLEvents", true, minecraft.getClass().getClassLoader());
            initialize(eventApi); client = minecraft;
            Object gameWindow = call(minecraft, "getWindow"); long target = ((Long) call(gameWindow, "handle")).longValue();
            if (window != target) { window = target; windowId = (Integer) call(video, "SDL_GetWindowID", target); focusSent = false; }
            InputBridge.sdlWindow(eventApi, target);
            InputBridge.beforeSwap(eventApi, target);
        } catch (Exception invalid) { InputBridge.failure("SDL rendered frame", invalid); }
    }
    public static int[] dimensions(long target) throws Exception {
        IntBuffer width = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer(), height = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
        call(video, "SDL_GetWindowSizeInPixels", target, width, height);
        int pixelWidth = width.get(0), pixelHeight = height.get(0);
        call(video, "SDL_GetWindowSize", target, width, height);
        return new int[] { pixelWidth, pixelHeight, width.get(0), height.get(0) };
    }
    public static void capture(BiConsumer<int[],int[]> complete, Consumer<Throwable> failed) throws Exception {
        if (client == null) throw new IllegalStateException("SDL client render target is unavailable");
        Object renderer = client.getClass().getField("gameRenderer").get(client);
        Object target = call(renderer, "mainRenderTarget");
        Class<?> screenshot = Class.forName("net.minecraft.client.Screenshot", true, client.getClass().getClassLoader());
        Consumer<Object> callback = image -> {
            try {
                int width = (Integer) call(image, "getWidth"), height = (Integer) call(image, "getHeight");
                if (width <= 0 || height <= 0 || (long) width * height > 8388608) throw new IllegalStateException("SDL capture size exceeds limit");
                complete.accept((int[]) call(image, "getPixels"), new int[] { width, height });
            } catch (Throwable invalid) { failed.accept(invalid); }
            finally { try { call(image, "close"); } catch (Exception ignored) {} }
        };
        call(screenshot, "takeScreenshot", target, callback);
    }
    private static Envelope event(String member, int type) throws Exception {
        ByteBuffer storage = ByteBuffer.allocateDirect(eventType.getField("SIZEOF").getInt(null)).order(ByteOrder.nativeOrder());
        Object event = eventType.getConstructor(ByteBuffer.class).newInstance(storage);
        Object data = call(event, member); call(data, "type", type); call(data, "windowID", windowId); call(data, "timestamp", System.nanoTime());
        return new Envelope(event, storage);
    }
    private static synchronized void enqueue(Envelope event) { if (queue.size() >= 2048) throw new IllegalStateException("SDL virtual input queue overflow"); queue.add(event); }
    public static boolean poll(Class<?> binding, Object output) {
        try {
            initialize(binding); InputBridge.pump(binding);
            if (output == null) return !queue.isEmpty() || (Boolean) call(events, "nSDL_PollEvent", 0L);
            if (InputBridge.active() && window != 0 && !focusSent) { enqueue(event("window", 526)); focusSent = true; }
            synchronized (SdlInput.class) { previous = queue.poll(); }
            if (previous != null) {
                Class<?> memory = Class.forName("org.lwjgl.system.MemoryUtil", true, loader);
                call(memory, "memCopy", call(previous.event, "address"), call(output, "address"), (long) eventType.getField("SIZEOF").getInt(null));
                return true;
            }
            for (int count = 0; count < 2048; count++) {
                if (!(Boolean) call(events, "nSDL_PollEvent", call(output, "address"))) return false;
                int type = (Integer) call(output, "type");
                // Real window geometry/lifecycle still flows. Owned keyboard,
                // mouse, gamepad/drop and focus input never reaches game code.
                if (InputBridge.active() && (type >= 768 && type < 4096 || type >= 4096 && type <= 4099 || type == 524 || type == 525 || type == 526 || type == 527)) continue;
                return true;
            }
            return false;
        } catch (Exception invalid) { InputBridge.failure("SDL virtual event poll", invalid); return false; }
    }
    public static synchronized ByteBuffer keyboardState() { return keyState; }
    public static synchronized short modifiers() {
        return (short) ((keys.contains(340) ? 1 : 0) | (keys.contains(344) ? 2 : 0) | (keys.contains(341) ? 64 : 0) | (keys.contains(345) ? 128 : 0) | (keys.contains(342) ? 256 : 0) | (keys.contains(346) ? 512 : 0) | (keys.contains(343) ? 1024 : 0) | (keys.contains(347) ? 2048 : 0));
    }
    public static synchronized int mouseState(FloatBuffer outX, FloatBuffer outY) {
        if (outX != null) outX.put(outX.position(), (float) x); if (outY != null) outY.put(outY.position(), (float) y);
        int mask = 0; for (Integer code : buttons) mask |= 1 << (buttonCode(code) - 1); return mask;
    }
    public static synchronized int relativeState(FloatBuffer outX, FloatBuffer outY) {
        if (outX != null) outX.put(outX.position(), (float) relativeX); if (outY != null) outY.put(outY.position(), (float) relativeY);
        relativeX = relativeY = 0; return mouseState(null, null);
    }
    private static int buttonCode(int glfw) { return glfw == 1 ? 3 : glfw == 2 ? 2 : glfw + 1; }
    private static int scancode(int glfw) {
        if (glfw >= 65 && glfw <= 90) return glfw - 65 + 4;
        if (glfw >= 49 && glfw <= 57) return glfw - 49 + 30;
        if (glfw == 48) return 39;
        if (glfw >= 290 && glfw <= 301) return glfw - 290 + 58;
        if (glfw >= 340 && glfw <= 347) { int[] modifiers = {225, 224, 226, 227, 229, 228, 230, 231}; return modifiers[glfw - 340]; }
        if (glfw >= 321 && glfw <= 329) return glfw - 321 + 89;
        switch (glfw) {
            case 32: return 44; case 39: return 52; case 44: return 54; case 45: return 45; case 46: return 55; case 47: return 56; case 59: return 51; case 61: return 46;
            case 91: return 47; case 92: return 49; case 93: return 48; case 96: return 53;
            case 256: return 41; case 257: return 40; case 258: return 43; case 259: return 42; case 260: return 73; case 261: return 76;
            case 262: return 79; case 263: return 80; case 264: return 81; case 265: return 82; case 266: return 75; case 267: return 78; case 268: return 74; case 269: return 77;
            case 280: return 57; case 281: return 71; case 282: return 83; case 283: return 70; case 284: return 72;
            case 320: return 98; case 330: return 99; case 331: return 84; case 332: return 85; case 333: return 86; case 334: return 87; case 335: return 88;
            default: return 0;
        }
    }
    public static synchronized void key(int code, boolean down) throws Exception {
        int scan = scancode(code); if (scan == 0) return;
        if (down) keys.add(code); else keys.remove(code); keyState.put(scan, down ? (byte) 1 : (byte) 0);
        Envelope event = event("key", down ? 768 : 769); Object data = call(event.event, "key");
        call(data, "scancode", scan); call(data, "key", call(keyboard, "SDL_GetKeyFromScancode", scan, modifiers(), true));
        call(data, "mod", modifiers()); call(data, "down", down); call(data, "repeat", false); enqueue(event);
    }
    public static synchronized void button(int code, boolean down) throws Exception {
        if (down) buttons.add(code); else buttons.remove(code);
        Envelope event = event("button", down ? 1025 : 1026); Object data = call(event.event, "button");
        call(data, "button", (byte) buttonCode(code)); call(data, "down", down); call(data, "clicks", (byte) 1); call(data, "x", (float) x); call(data, "y", (float) y); enqueue(event);
    }
    public static synchronized void move(double nextX, double nextY) throws Exception {
        Envelope event = event("motion", 1024); Object data = call(event.event, "motion");
        call(data, "x", (float) nextX); call(data, "y", (float) nextY); call(data, "xrel", (float) (nextX - x)); call(data, "yrel", (float) (nextY - y));
        relativeX += nextX - x; relativeY += nextY - y;
        x = nextX; y = nextY; enqueue(event);
    }
    public static synchronized void scroll(double horizontal, double vertical) throws Exception {
        Envelope event = event("wheel", 1027); Object data = call(event.event, "wheel");
        call(data, "x", (float) horizontal); call(data, "y", (float) vertical); call(data, "direction", 0); enqueue(event);
    }
    public static synchronized void text(String text) throws Exception {
        Envelope event = event("text", 771); byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        event.text = ByteBuffer.allocateDirect(bytes.length + 1); event.text.put(bytes).put((byte) 0).flip();
        call(call(event.event, "text"), "text", event.text); enqueue(event);
    }
    public static void warp(float nextX, float nextY) { InputBridge.warp(nextX, nextY); synchronized (SdlInput.class) { x = nextX; y = nextY; } }
    public static synchronized void expire(int code, boolean mouse) {
        if (mouse) buttons.remove(code);
        else { keys.remove(code); int scan = scancode(code); if (scan > 0) keyState.put(scan, (byte) 0); }
    }
    public static synchronized void cancel() { queue.clear(); keys.clear(); buttons.clear(); for (int index = 0; index < keyState.capacity(); index++) keyState.put(index, (byte) 0); relativeX = relativeY = 0; }
    public static synchronized void destroyed() { cancel(); window = 0; windowId = 0; focusSent = false; }
    public static synchronized boolean relative(boolean value) { relative = value; return true; }
    public static synchronized boolean relative() { return relative; }
    public static synchronized void handoff(boolean human) throws Exception {
        focusSent = false;
        if (window == 0) return;
        call(video, "SDL_SetWindowFocusable", window, human);
        call(api("SDLMouse"), "SDL_SetWindowRelativeMouseMode", window, false);
        call(video, "SDL_SetWindowMouseGrab", window, false); call(video, "SDL_SetWindowKeyboardGrab", window, false);
        if (human) { long flags = (Long) call(video, "SDL_GetWindowFlags", window); enqueue(event("window", (flags & 512L) != 0 ? 526 : 527)); }
    }
}
