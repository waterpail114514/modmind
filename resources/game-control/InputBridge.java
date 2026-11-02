package dev.modmind.gamecontrol;

import java.awt.image.BufferedImage;
import java.io.*;
import java.lang.management.ManagementFactory;
import java.lang.reflect.*;
import java.net.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import javax.imageio.ImageIO;

/** Bootstrap-visible virtual input device and authenticated loopback transport. */
public final class InputBridge {
    private static volatile boolean owned = true;
    private static volatile boolean paused;
    private static volatile long geometryVersion = 1;
    private static final List<Request> barriers = new ArrayList<Request>();
    private static Request handoff;
    private static volatile String session, secret, family = "waiting", error;
    private static volatile long window, frameId, lastPump, actionSequence;
    private static volatile int width, height, logicalWidth, logicalHeight;
    private static volatile Class<?> binding;
    private static volatile Request capture;
    private static volatile Request sdlReadback;
    private static final Map<String,Object> callbacks = new HashMap<String,Object>();
    private static final Map<String,List<String>> hooks = new TreeMap<String,List<String>>();
    private static final Set<Integer> keys = new HashSet<Integer>(), buttons = new HashSet<Integer>();
    private static final Map<Integer,Long> keyLeases = new HashMap<Integer,Long>(), buttonLeases = new HashMap<Integer,Long>();
    private static final ArrayBlockingQueue<Request> pending = new ArrayBlockingQueue<Request>(32);
    private static final LinkedHashMap<String,Request> requests = new LinkedHashMap<String,Request>();
    private static final Set<String> seenRequests = new HashSet<String>();
    private static final ArrayDeque<Event> keyEvents = new ArrayDeque<Event>(), mouseEvents = new ArrayDeque<Event>();
    private static Event keyEvent = new Event(), mouseEvent = new Event();
    private static double x, y;
    private static int dx, dy, wheel, mode = 0x00034001;
    private static boolean grabbed, focusSent;
    private static final long origin = System.nanoTime();
    private static volatile long lastContact = origin;
    private static final ThreadPoolExecutor clients = new ThreadPoolExecutor(4, 4, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(4), r -> {
        Thread thread = new Thread(r, "ModMind game control request"); thread.setDaemon(true); return thread;
    });

    private InputBridge() {}
    public static boolean active() { return owned; }
    public static long positionFlags(long flags) { return owned ? flags | 0x0010L : flags; } // SWP_NOACTIVATE
    public static void legacyReshape(Object display, int left, int top, int nextWidth, int nextHeight) {
        try {
            Class<?> api = display.getClass();
            Method handle = api.getDeclaredMethod("getHwnd"); handle.setAccessible(true); long hwnd = ((Long) handle.invoke(display)).longValue();
            Method read = api.getDeclaredMethod("getWindowLongPtr", long.class, int.class); read.setAccessible(true);
            int style = ((Long) read.invoke(null, hwnd, -16)).intValue(), extended = ((Long) read.invoke(null, hwnd, -20)).intValue();
            IntBuffer rectangle = ByteBuffer.allocateDirect(16).order(ByteOrder.nativeOrder()).asIntBuffer(); rectangle.put(2, nextWidth); rectangle.put(3, nextHeight);
            Method adjust = api.getDeclaredMethod("adjustWindowRectEx", IntBuffer.class, int.class, boolean.class, int.class); adjust.setAccessible(true);
            if (!((Boolean) adjust.invoke(display, rectangle, style, false, extended)).booleanValue()) throw new IOException("Cannot calculate the owned window frame");
            Method position = api.getDeclaredMethod("setWindowPos", long.class, long.class, int.class, int.class, int.class, int.class, long.class); position.setAccessible(true);
            if (!((Boolean) position.invoke(null, hwnd, 0L, left, top, rectangle.get(2) - rectangle.get(0), rectangle.get(3) - rectangle.get(1), 0x0014L)).booleanValue()) throw new IOException("Cannot resize the owned window without activating it");
        } catch (Exception invalid) { failure("background window resize", invalid); throw new IllegalStateException("Cannot resize background window", invalid); }
    }
    public static synchronized void transformed(String name, List<String> methods) { hooks.put(name, new ArrayList<String>(methods)); }
    public static void failure(String operation, Throwable cause) {
        while (cause.getCause() != null) cause = cause.getCause();
        error = operation + ": " + cause.toString();
        if (error.length() > 2000) error = error.substring(0, 2000);
        System.err.println("[ModMind game control] " + error);
    }

    public static void start(String file) throws Exception {
        Properties config = new Properties();
        try (Reader input = Files.newBufferedReader(Paths.get(file), StandardCharsets.UTF_8)) { config.load(input); }
        session = config.getProperty("sessionId"); secret = System.getenv("MODMIND_GAME_CONTROL_TOKEN");
        if (session == null || !session.matches("[a-f0-9-]{36}") || secret == null || !secret.matches("[a-f0-9]{64}")) throw new IOException("Invalid owned game control configuration");
        final ServerSocket server = new ServerSocket();
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4);
        // The JVM allocates the port. No reserve/close/rebind race and no unauthenticated HTTP surface.
        Path endpoint = Paths.get(file + ".endpoint");
        String identity = "{\"protocol\":1,\"sessionId\":" + quote(session) + ",\"port\":" + server.getLocalPort() + ",\"pid\":" + pid() + "}";
        Files.write(endpoint, identity.getBytes(StandardCharsets.UTF_8), StandardOpenOption.CREATE_NEW);
        Thread listener = new Thread(() -> {
            for (;;) {
                Socket socket = null;
                try {
                    socket = server.accept(); socket.setSoTimeout(12000);
                    final Socket accepted = socket;
                    clients.execute(() -> handle(accepted));
                } catch (Exception refused) { if (socket != null) try { socket.close(); } catch (IOException ignored) {} }
            }
        }, "ModMind game control listener");
        listener.setDaemon(true); listener.start();
        Thread watchdog = new Thread(() -> {
            for (;;) {
                try { Thread.sleep(100); } catch (InterruptedException interrupted) { return; }
                synchronized (InputBridge.class) {
                    // Polling state is cleared even if the render thread stops. Callback releases
                    // are delivered on its next pump; no native input is ever used for recovery.
                    long now = System.nanoTime();
                    if (now - lastContact > TimeUnit.SECONDS.toNanos(10)) expireAll();
                    for (Integer code : new ArrayList<Integer>(keyLeases.keySet())) if (now >= keyLeases.get(code)) expire(code, false);
                    for (Integer code : new ArrayList<Integer>(buttonLeases.keySet())) if (now >= buttonLeases.get(code)) expire(code, true);
                    for (Request request : requests.values()) if (!request.done() && now - request.created > TimeUnit.SECONDS.toNanos(10)) request.fail("Render thread did not process request before deadline");
                }
            }
        }, "ModMind virtual input watchdog");
        watchdog.setDaemon(true); watchdog.start();
    }

    private static void handle(Socket socket) {
        try (Socket connection = socket) {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            InputStream input = connection.getInputStream();
            for (int next; (next = input.read()) != -1 && next != '\n';) { if (line.size() >= 8192) throw new IOException("Request too large"); line.write(next); }
            String[] parts = new String(line.toByteArray(), StandardCharsets.UTF_8).split("\t", -1);
            if (parts.length < 4 || !parts[0].matches("[a-f0-9-]{36}") || !session.equals(parts[2]) ||
                !MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8), parts[1].getBytes(StandardCharsets.UTF_8))) return;
            lastContact = System.nanoTime();
            Request request;
            synchronized (InputBridge.class) {
                request = requests.get(parts[0]);
                String fingerprint = Arrays.toString(Arrays.copyOfRange(parts, 3, parts.length));
                if (request != null && !request.fingerprint.equals(fingerprint)) {
                    request = new Request(parts, fingerprint); request.fail("Request ID reused for another action");
                }
                if (request == null) {
                    if (requests.size() >= 128) {
                        Iterator<Request> iterator = requests.values().iterator();
                        while (iterator.hasNext() && requests.size() >= 128) if (iterator.next().done()) iterator.remove();
                    }
                    request = new Request(parts, fingerprint);
                    if (parts[3].equals("status")) { request.complete(status(), null); }
                    else if (parts[3].equals("release")) { cancelAll(); request.complete("{\"released\":true}", null); }
                    else if (parts[3].equals("cancel") && parts.length == 5) {
                        Request cancelled = requests.get(parts[4]);
                        if (cancelled != null) { cancelled.fail("Input cancelled by owner"); cancelAll(); }
                        request.complete("{\"cancelled\":true}", null);
                    }
                    else if (seenRequests.contains(parts[0])) request.fail("Request result expired; the action will not be repeated");
                    else if (requests.size() >= 128 || seenRequests.size() >= 4096) request.fail("Session request capacity reached; start a new owned session");
                    else {
                    requests.put(parts[0], request); seenRequests.add(parts[0]);
                    if (!pending.offer(request)) request.fail("Game control queue is full");
                    }
                }
            }
            if (!request.ready.await(11, TimeUnit.SECONDS)) request.fail("Game control request timed out");
            byte[] png = null;
            if (request.frame != null) png = request.frame.png();
            String header = "{\"requestId\":" + quote(parts[0]) + ",\"sessionId\":" + quote(session) + ",\"ok\":" + (request.failure == null) +
                ",\"result\":" + (request.failure == null ? request.result : "null") + ",\"error\":" + quote(request.failure) + ",\"imageBytes\":" + (png == null ? 0 : png.length) + "}\n";
            OutputStream output = connection.getOutputStream(); output.write(header.getBytes(StandardCharsets.UTF_8)); if (png != null) output.write(png); output.flush();
        } catch (Exception ignored) { /* Unauthenticated, malformed and disconnected peers cannot change ownership. */ }
    }

    private static String status() {
        return "{\"protocol\":1,\"pid\":" + pid() + ",\"family\":" + quote(family) + ",\"active\":" + owned +
            ",\"ready\":" + (binding != null && lastPump != 0 && System.nanoTime() - lastPump < TimeUnit.SECONDS.toNanos(3) && frameId > 0 && width > 0 && height > 0 && filtersReady() && error == null) + ",\"frameId\":" + frameId + ",\"actionSequence\":" + actionSequence +
            ",\"width\":" + width + ",\"height\":" + height + ",\"logicalWidth\":" + logicalWidth + ",\"logicalHeight\":" + logicalHeight +
            ",\"coordinateRevision\":" + quote(geometry()) + ",\"ownership\":" + quote(owned ? (paused ? "paused" : "ai") : "human") +
            ",\"lastPumpAgeMs\":" + (lastPump == 0 ? -1 : TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - lastPump)) +
            ",\"keysDown\":" + keys.toString() + ",\"buttonsDown\":" + buttons.toString() + ",\"hookClasses\":" + hooks.size() +
            ",\"physicalCallbacksFiltered\":" + (owned && filtersReady()) + ",\"error\":" + quote(error) + "}";
    }
    private static String geometry() { return session + ":" + geometryVersion; }
    public static synchronized void windowDestroyed(long target) {
        if (target == 0 || target == window) {
            if (family.equals("sdl")) SdlInput.destroyed();
            cancelAll(); callbacks.clear(); window = 0; focusSent = false;
            width = height = logicalWidth = logicalHeight = 0; geometryVersion++;
        }
    }
    private static boolean filtersReady() {
        if (family.equals("waiting")) return false;
        if (family.equals("sdl")) return SdlInput.ready() && hooks.containsKey("org/lwjgl/sdl/SDLEvents") && hooks.containsKey("org/lwjgl/sdl/SDLKeyboard") && hooks.containsKey("org/lwjgl/sdl/SDLMouse");
        if (family.equals("lwjgl2")) return hooks.containsKey("org/lwjgl/input/Keyboard") && hooks.containsKey("org/lwjgl/input/Mouse");
        for (String kind : callbacks.keySet()) {
            List<String> methods = hooks.get("org/lwjgl/glfw/GLFW" + kind + "CallbackI"); boolean found = false;
            if (methods != null) for (String method : methods) if (method.equals("callback(J)V") || method.equals("callback(JJ)V")) found = true;
            if (!found) return false;
        }
        return true;
    }

    public static synchronized void registerCallback(long target, String kind, Object callback) {
        if (window == 0 || window == target) {
            window = target;
            if (kind.equals("WindowFocus") && callbacks.get(kind) != callback) focusSent = false;
            if (callback == null) callbacks.remove(kind); else callbacks.put(kind, callback);
        }
    }
    public static synchronized void sdlWindow(Class<?> api, long target) { binding = api; family = "sdl"; window = target; }
    public static boolean showWindow(Class<?> api, long target) {
        if (!owned || !System.getProperty("os.name", "").startsWith("Windows")) return false;
        try {
            Class<?> nativeWindow = Class.forName("org.lwjgl.glfw.GLFWNativeWin32", true, api.getClassLoader());
            long hwnd = ((Long) nativeWindow.getMethod("glfwGetWin32Window", long.class).invoke(null, target)).longValue();
            Class<?> user = Class.forName("org.lwjgl.system.windows.User32", true, api.getClassLoader());
            Method show = user.getMethod("ShowWindow", long.class, int.class);
            show.invoke(null, hwnd, 4); show.invoke(null, hwnd, 4);
            return true;
        } catch (Exception invalid) { failure("background window show", invalid); throw new IllegalStateException("Cannot show owned window without activating it", invalid); }
    }
    public static void beforeCreate(Class<?> api) {
        if (!owned) return;
        try {
            Method hint = api.getMethod("glfwWindowHint", int.class, int.class);
            hint.invoke(null, 0x00020001, 0); // GLFW_FOCUSED: create the test window without activating it.
            hint.invoke(null, 0x00020006, 0); // GLFW_AUTO_ICONIFY: switching apps must not minimize fullscreen rendering.
            IntBuffer major = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            IntBuffer minor = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            api.getMethod("glfwGetVersion", IntBuffer.class, IntBuffer.class, IntBuffer.class).invoke(null, major, minor, null);
            // Some shipped 3.3-development natives predate FOCUS_ON_SHOW.
            // The matching Java binding must expose it as well.
            if (major.get(0) > 3 || (major.get(0) == 3 && minor.get(0) >= 3)) {
                try { api.getField("GLFW_FOCUS_ON_SHOW"); hint.invoke(null, 0x0002000C, 0); }
                catch (NoSuchFieldException oldBinding) { /* Show through the platform no-activate path. */ }
            }
        } catch (Exception invalid) { failure("background window creation", invalid); }
    }
    public static synchronized int key(int code) { return keys.contains(code) ? 1 : 0; }
    public static synchronized int button(int code) { return buttons.contains(code) ? 1 : 0; }
    public static synchronized void cursorMode(int value) { mode = value; }
    public static synchronized int cursorMode() { return mode; }
    public static synchronized void warp(double nextX, double nextY) { x = nextX; y = nextY; }
    public static synchronized void legacyWarp(int nextX, int nextY) { x = nextX; y = nextY; }
    public static synchronized void cursor(DoubleBuffer outX, DoubleBuffer outY) { if (outX != null) outX.put(outX.position(), x); if (outY != null) outY.put(outY.position(), y); }
    public static synchronized void cursor(double[] outX, double[] outY) { if (outX != null && outX.length > 0) outX[0] = x; if (outY != null && outY.length > 0) outY[0] = y; }
    public static synchronized void grabbed(boolean value) { if (grabbed != value) { dx = dy = 0; } grabbed = value; }
    public static synchronized boolean grabbed() { return grabbed; }
    public static boolean inside() { return true; }

    public static void pump(Class<?> api) {
      if (family.equals("sdl") && !api.getName().startsWith("org.lwjgl.sdl.")) return;
      synchronized (InputBridge.class) {
        binding = api; family = api.getName().startsWith("org.lwjgl.sdl.") ? "sdl" : api.getName().endsWith("GLFW") ? "glfw" : "lwjgl2"; lastPump = System.nanoTime();
        try {
            if (family.equals("glfw")) {
                if (window == 0) window = ((Long) api.getMethod("glfwGetCurrentContext").invoke(null)).longValue();
                if (owned && !focusSent && callbacks.containsKey("WindowFocus")) { emit("WindowFocus", window, true); focusSent = true; }
            }
            drainReleases();
            for (int processed = 0; processed < 32; processed++) {
                Request request = pending.peek(); if (request == null) break;
                if (request.done()) { pending.poll(); continue; }
                if (request.parts[3].equals("capture") && (capture != null || sdlReadback != null)) break;
                pending.poll();
                try {
                    if (error != null) throw new IllegalStateException(error);
                    if (request.parts[3].equals("capture")) capture = request;
                    else if (request.parts[3].equals("sync")) { dimensions(api, window); request.complete(status(), null); }
                    else if (request.parts[3].equals("settle")) { request.targetFrame = frameId + 2; barriers.add(request); }
                    else if (request.parts[3].equals("ownership")) {
                        require(request.parts, 5); changeOwnership(request.parts[4], request);
                    }
                    else {
                        if (!owned || paused) throw new IllegalStateException("AI input is paused or handed to the user");
                        if (!filtersReady()) throw new IllegalStateException("Physical input callback isolation is not connected");
                        apply(request.parts); actionSequence++; request.complete("{\"dispatched\":true,\"actionSequence\":" + actionSequence + "}", null);
                    }
                } catch (Exception invalid) { expireAll(); request.fail(reason(invalid)); }
            }
        } catch (Throwable cause) { failure("input pump", cause); expireAll(); }
      }
      deliverCallbacks();
      if (capture != null && family.equals("lwjgl2") && System.getProperty("os.name", "").startsWith("Windows")) {
        try {
            if (!((Boolean) api.getMethod("isVisible").invoke(null)).booleanValue()) {
                Class<?> windows = Class.forName("org.lwjgl.opengl.WindowsDisplay", false, api.getClassLoader());
                Field current = windows.getDeclaredField("current_display"); current.setAccessible(true); Object display = current.get(null);
                Method handle = windows.getDeclaredMethod("getHwnd"); handle.setAccessible(true);
                Method show = windows.getDeclaredMethod("showWindow", long.class, int.class); show.setAccessible(true);
                // A minimized LWJGL2 window stops swapping. Restore only our own
                // window without activating it; never return a cached old image.
                show.invoke(null, handle.invoke(display), 4);
            }
        } catch (Exception invalid) { synchronized (InputBridge.class) { if (capture != null) { capture.fail("Cannot resume background rendering: " + reason(invalid)); capture = null; } } }
      }
    }

    private static void apply(String[] request) throws Exception {
        if (request[request.length - 1].startsWith("revision:")) {
            String expected = request[request.length - 1].substring(9);
            dimensions(binding, window);
            if (!geometry().equals(expected)) throw new IllegalStateException("STALE_COORDINATES: capture the resized/recreated window again");
            request = Arrays.copyOf(request, request.length - 1);
        }
        String operation = request[3];
        if (operation.equals("key") || operation.equals("button")) {
            require(request, 7); boolean mouse = operation.equals("button");
            int code = integer(request[4], 0, mouse ? 7 : (family.equals("lwjgl2") ? 255 : 348));
            if (!request[5].equals("down") && !request[5].equals("up")) throw new IllegalArgumentException("Expected down or up");
            boolean down = request[5].equals("down"); int duration = integer(request[6], 1, 5000);
            setButtonOrKey(code, down, mouse, duration);
        } else if (operation.equals("move") || operation.equals("look")) {
            require(request, 6); double nextX = number(request[4]), nextY = number(request[5]);
            if (Math.abs(nextX) > 16384 || Math.abs(nextY) > 16384) throw new IllegalArgumentException("Pointer value exceeds limit");
            double oldX = x, oldY = y;
            if (operation.equals("look")) { x += nextX; y += family.equals("lwjgl2") ? -nextY : nextY; }
            else { if (logicalWidth <= 0 || logicalHeight <= 0 || nextX < 0 || nextY < 0 || nextX >= logicalWidth || nextY >= logicalHeight) throw new IllegalArgumentException("Pointer is outside the current logical window"); x = nextX; y = family.equals("lwjgl2") ? logicalHeight - 1 - nextY : nextY; }
            dx += (int) (x - oldX); dy += (int) (y - oldY);
            if (family.equals("sdl")) SdlInput.move(x, y);
            else if (family.equals("glfw")) emit("CursorPos", window, x, y);
            else { Event event = new Event(); event.x = (int) x; event.y = (int) y; event.dx = (int) (x - oldX); event.dy = (int) (y - oldY); enqueue(mouseEvents, event); }
        } else if (operation.equals("scroll")) {
            require(request, 6); double horizontal = number(request[4]), vertical = number(request[5]);
            if (Math.abs(horizontal) > 100 || Math.abs(vertical) > 100) throw new IllegalArgumentException("Scroll exceeds limit");
            if (family.equals("sdl")) SdlInput.scroll(horizontal, vertical);
            else if (family.equals("glfw")) emit("Scroll", window, horizontal, vertical);
            else { int amount = (int) (vertical * 120); wheel += amount; Event event = new Event(); event.wheel = amount; event.x = (int) x; event.y = (int) y; enqueue(mouseEvents, event); }
        } else if (operation.equals("text")) {
            require(request, 5); String text = new String(Base64.getDecoder().decode(request[4]), StandardCharsets.UTF_8);
            if (text.length() > 512) throw new IllegalArgumentException("Text exceeds limit");
            if (family.equals("sdl")) { SdlInput.text(text); return; }
            for (int offset = 0; offset < text.length();) {
                int codepoint = text.codePointAt(offset); offset += Character.charCount(codepoint);
                if (family.equals("glfw")) {
                    if (!callbacks.containsKey("Char") && !callbacks.containsKey("CharMods")) throw new IllegalStateException("Game has not registered a character callback");
                    emit("Char", window, codepoint); emit("CharMods", window, codepoint, modifiers());
                }
                else { for (char character : Character.toChars(codepoint)) { Event event = new Event(); event.code = 0; event.character = character; event.down = true; enqueue(keyEvents, event); } }
            }
        } else throw new IllegalArgumentException("Unsupported input operation");
    }

    private static void setButtonOrKey(int code, boolean down, boolean mouse, int duration) throws Exception {
        Set<Integer> state = mouse ? buttons : keys; Map<Integer,Long> leases = mouse ? buttonLeases : keyLeases;
        boolean changed = down ? state.add(code) : state.remove(code);
        if (down) leases.put(code, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(duration)); else leases.remove(code);
        if (!changed) return;
        if (family.equals("sdl")) { if (mouse) SdlInput.button(code, down); else SdlInput.key(code, down); }
        else if (family.equals("glfw")) {
            if (mouse) emit("MouseButton", window, code, down ? 1 : 0, modifiers());
            else emit("Key", window, code, 0, down ? 1 : 0, modifiers());
        } else {
            Event event = new Event(); event.code = code; event.down = down; event.x = (int) x; event.y = (int) y;
            // Older GuiTextField implementations recognize Ctrl+A/C/V/X from
            // the character in Keyboard's event, before key-code shortcuts.
            if (!mouse && down && (keys.contains(29) || keys.contains(157))) {
                if (code == 30) event.character = 1;
                else if (code == 46) event.character = 3;
                else if (code == 47) event.character = 22;
                else if (code == 45) event.character = 24;
            }
            enqueue(mouse ? mouseEvents : keyEvents, event);
        }
    }
    private static int modifiers() { return (keys.contains(340) || keys.contains(344) ? 1 : 0) | (keys.contains(341) || keys.contains(345) ? 2 : 0) | (keys.contains(342) || keys.contains(346) ? 4 : 0) | (keys.contains(343) || keys.contains(347) ? 8 : 0); }
    private static final ArrayDeque<int[]> releases = new ArrayDeque<int[]>();
    private static void expire(int code, boolean mouse) {
        if ((mouse ? buttons : keys).remove(code)) releases.add(new int[] { code, mouse ? 1 : 0 });
        if (family.equals("sdl")) SdlInput.expire(code, mouse);
        (mouse ? buttonLeases : keyLeases).remove(code);
    }
    private static void expireAll() {
        for (Integer code : new ArrayList<Integer>(keys)) expire(code, false);
        for (Integer code : new ArrayList<Integer>(buttons)) expire(code, true);
        dx = dy = wheel = 0;
    }
    private static void cancelAll() {
        if (handoff != null) { handoff.fail("Input handoff cancelled by owner"); handoff = null; }
        for (Request queued : pending) queued.fail("Input cancelled by owner"); pending.clear();
        if (capture != null) { capture.fail("Capture cancelled by owner"); capture = null; }
        if (sdlReadback != null) sdlReadback.fail("Capture cancelled by owner");
        deliveries.clear(); keyEvents.clear(); mouseEvents.clear(); expireAll();
        if (family.equals("sdl")) SdlInput.cancel();
        for (Request barrier : barriers) barrier.fail("Input cancelled by owner"); barriers.clear();
    }
    private static void changeOwnership(String owner, Request request) throws Exception {
        if (!owner.equals("ai") && !owner.equals("paused") && !owner.equals("human")) throw new IllegalArgumentException("Invalid input ownership");
        boolean wasHuman = !owned;
        cancelAll(); drainReleases();
        if (owner.equals("human")) {
            if (!owned) { request.complete(status(), null); return; }
            // LWJGL2 consumes its event queue after the pump. Keep the virtual
            // device selected until the game has consumed the release events.
            paused = true; request.targetFrame = frameId + 2; handoff = request;
            return;
        } else {
            if (!owned) {
                if (family.equals("sdl")) SdlInput.handoff(false);
                else if (family.equals("glfw")) binding.getMethod("glfwSetInputMode", long.class, int.class, int.class).invoke(null, window, 0x00033001, 0x00034001);
                else for (String name : new String[] { "Keyboard", "Mouse" }) {
                    Class<?> device = Class.forName("org.lwjgl.input." + name, true, binding.getClassLoader());
                    device.getMethod("poll").invoke(null);
                    for (int count = 0; count < 2048 && ((Boolean) device.getMethod("next").invoke(null)).booleanValue(); count++) {}
                }
            }
            owned = true; paused = owner.equals("paused"); focusSent = false;
            // Human key bindings may remain cached even after native polling
            // has been disabled. Clear those bindings through normal releases.
            if (wasHuman) {
                for (int code = family.equals("lwjgl2") ? 0 : 32; code <= (family.equals("lwjgl2") ? 255 : 348); code++) releases.add(new int[] { code, 0 });
                for (int code = 0; code < 8; code++) releases.add(new int[] { code, 1 });
                drainReleases();
            }
        }
        request.complete(status(), null);
    }
    private static void finishHandoff() throws Exception {
        Request request = handoff;
        if (request == null) return;
        if (request.done()) { handoff = null; return; }
        if (frameId < request.targetFrame) return;
        handoff = null; owned = false; paused = false;
        if (family.equals("sdl")) SdlInput.handoff(true);
        else if (family.equals("glfw")) {
            binding.getMethod("glfwSetInputMode", long.class, int.class, int.class).invoke(null, window, 0x00033001, 0x00034001);
            boolean focused = ((Integer) binding.getMethod("glfwGetWindowAttrib", long.class, int.class).invoke(null, window, 0x00020001)).intValue() != 0;
            emit("WindowFocus", window, focused);
        } else Class.forName("org.lwjgl.input.Mouse", true, binding.getClassLoader()).getMethod("setGrabbed", boolean.class).invoke(null, false);
        request.complete(status(), null);
    }
    private static void drainReleases() throws Exception {
        while (!releases.isEmpty()) {
            int[] item = releases.remove(); int code = item[0]; boolean mouse = item[1] == 1;
            if (family.equals("sdl")) { if (mouse) SdlInput.button(code, false); else SdlInput.key(code, false); }
            else if (family.equals("glfw")) { if (mouse) emit("MouseButton", window, code, 0, modifiers()); else emit("Key", window, code, 0, 0, modifiers()); }
            else { Event event = new Event(); event.code = code; event.x = (int) x; event.y = (int) y; enqueue(mouse ? mouseEvents : keyEvents, event); }
        }
    }
    private static void emit(String kind, Object... arguments) throws Exception {
        Object callback = callbacks.get(kind); if (callback == null) return;
        if (deliveries.size() >= 2048) throw new IllegalStateException("Virtual callback queue overflow");
        deliveries.add(new Delivery(kind, callback, arguments));
    }
    private static final ArrayDeque<Delivery> deliveries = new ArrayDeque<Delivery>();
    private static final ThreadLocal<Boolean> delivering = new ThreadLocal<Boolean>();
    private static class Delivery {
        final String kind; final Object callback; final Object[] arguments;
        Delivery(String kind, Object callback, Object[] arguments) { this.kind = kind; this.callback = callback; this.arguments = arguments; }
    }
    private static void deliverCallbacks() {
        if (Boolean.TRUE.equals(delivering.get())) return;
        delivering.set(true);
        try {
            for (int count = 0; count < 2048; count++) {
                Delivery next;
                synchronized (InputBridge.class) { next = deliveries.poll(); }
                if (next == null) break;
                // Game callbacks may block while loading a world. Never hold the
                // input monitor here: leases and authenticated status must keep working.
                Class<?> contract = Class.forName("org.lwjgl.glfw.GLFW" + next.kind + "CallbackI", false, binding.getClassLoader());
                for (Method method : contract.getMethods()) if (method.getName().equals("invoke")) { method.invoke(next.callback, next.arguments); break; }
            }
        } catch (Throwable cause) { failure("callback dispatch", cause); synchronized (InputBridge.class) { expireAll(); } }
        finally { delivering.remove(); }
    }

    public static void beforeSwap(Class<?> api, long target) {
        if (family.equals("sdl") && !api.getName().startsWith("org.lwjgl.sdl.")) return;
        binding = api; if (target != 0) window = target; frameId++;
        synchronized (InputBridge.class) {
            try { finishHandoff(); } catch (Exception invalid) { failure("input handoff", invalid); }
            Iterator<Request> iterator = barriers.iterator();
            while (iterator.hasNext()) {
                Request barrier = iterator.next();
                if (barrier.done()) iterator.remove();
                else if (frameId >= barrier.targetFrame) { barrier.complete("{\"settled\":true,\"frameId\":" + frameId + ",\"actionSequence\":" + actionSequence + "}", null); iterator.remove(); }
            }
        }
        try {
            if (capture != null || frameId == 1 || frameId % 120 == 0) dimensions(api, target);
            if (capture != null) {
                Request request;
                synchronized (InputBridge.class) { request = capture; capture = null; }
                if (request == null) return;
                if (!request.done()) {
                    try {
                        if (family.equals("sdl")) {
                            final Request readback = request; sdlReadback = request;
                            final int captureWidth = width, captureHeight = height;
                            final String captureGeometry = geometry(), metadata = captureMetadata();
                            SdlInput.capture((pixels, size) -> {
                                synchronized (InputBridge.class) {
                                    try {
                                        if (size[0] != captureWidth || size[1] != captureHeight || !captureGeometry.equals(geometry())) readback.fail("Capture geometry changed during GPU readback");
                                        else { retainFrames(); readback.complete(metadata, new Frame(size[0], size[1], pixels)); }
                                    } finally { if (sdlReadback == readback) sdlReadback = null; }
                                }
                            }, invalid -> { synchronized (InputBridge.class) { readback.fail(reason(invalid)); if (sdlReadback == readback) sdlReadback = null; } });
                            return;
                        }
                        Frame frame = Frame.read(api, width, height);
                        // Retain at most two image results for idempotent retries, not 128 full frames.
                        retainFrames();
                        request.complete(captureMetadata(), frame);
                    } catch (Exception invalid) { if (sdlReadback == request) sdlReadback = null; request.fail(reason(invalid)); }
                }
            }
        } catch (Exception invalid) { if (capture != null) { capture.fail(reason(invalid)); capture = null; } else failure("capture", invalid); }
    }
    private static void dimensions(Class<?> api, long target) throws Exception {
        int priorWidth = width, priorHeight = height, priorLogicalWidth = logicalWidth, priorLogicalHeight = logicalHeight;
        if (family.equals("sdl")) { int[] size = SdlInput.dimensions(target); width = size[0]; height = size[1]; logicalWidth = size[2]; logicalHeight = size[3]; }
        else if (target != 0) {
            IntBuffer w = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer(), h = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
            api.getMethod("glfwGetFramebufferSize", long.class, IntBuffer.class, IntBuffer.class).invoke(null, target, w, h); width = w.get(0); height = h.get(0);
            api.getMethod("glfwGetWindowSize", long.class, IntBuffer.class, IntBuffer.class).invoke(null, target, w, h); logicalWidth = w.get(0); logicalHeight = h.get(0);
        } else { width = (Integer) api.getMethod("getWidth").invoke(null); height = (Integer) api.getMethod("getHeight").invoke(null); logicalWidth = width; logicalHeight = height; }
        if (width != priorWidth || height != priorHeight || logicalWidth != priorLogicalWidth || logicalHeight != priorLogicalHeight) geometryVersion++;
    }
    private static String captureMetadata() { return "{\"frameId\":" + frameId + ",\"capturedAt\":" + System.currentTimeMillis() + ",\"width\":" + width + ",\"height\":" + height + ",\"logicalWidth\":" + logicalWidth + ",\"logicalHeight\":" + logicalHeight + ",\"coordinateRevision\":" + quote(geometry()) + ",\"actionSequence\":" + actionSequence + "}"; }
    private static synchronized void retainFrames() {
        int retained = 0; List<Request> recent = new ArrayList<Request>(requests.values()); Collections.reverse(recent);
        for (Request old : recent) if (old.frame != null && ++retained >= 2) old.frame = null;
    }

    public static synchronized boolean keyNext() { if (keyEvents.isEmpty()) return false; keyEvent = keyEvents.remove(); return true; }
    public static synchronized boolean mouseNext() { if (mouseEvents.isEmpty()) return false; mouseEvent = mouseEvents.remove(); return true; }
    public static synchronized int keyEventCount() { return keyEvents.size(); }
    public static synchronized int eventKey() { return keyEvent.code; }
    public static synchronized boolean eventKeyState() { return keyEvent.down; }
    public static synchronized char eventCharacter() { return keyEvent.character; }
    public static synchronized long keyEventNanos() { return keyEvent.nanos; }
    public static boolean repeatEvent() { return false; }
    public static synchronized int mouseX() { return (int) x; }
    public static synchronized int mouseY() { return (int) y; }
    public static synchronized int mouseDX() { int value = dx; dx = 0; return value; }
    public static synchronized int mouseDY() { int value = dy; dy = 0; return value; }
    public static synchronized int mouseWheel() { int value = wheel; wheel = 0; return value; }
    public static synchronized int eventButton() { return mouseEvent.code; }
    public static synchronized boolean eventButtonState() { return mouseEvent.down; }
    public static synchronized int eventX() { return mouseEvent.x; }
    public static synchronized int eventY() { return mouseEvent.y; }
    public static synchronized int eventDX() { return mouseEvent.dx; }
    public static synchronized int eventDY() { return mouseEvent.dy; }
    public static synchronized int eventWheel() { return mouseEvent.wheel; }
    public static synchronized long mouseEventNanos() { return mouseEvent.nanos; }

    private static void enqueue(ArrayDeque<Event> queue, Event event) { if (queue.size() >= 2048) throw new IllegalStateException("Virtual event queue overflow"); queue.add(event); }
    private static class Event { int code = -1, x, y, dx, dy, wheel; char character; boolean down; long nanos = System.nanoTime(); }
    private static class Request {
        final String[] parts; final String fingerprint; final long created = System.nanoTime(); final CountDownLatch ready = new CountDownLatch(1);
        volatile String result, failure; volatile Frame frame;
        long targetFrame;
        Request(String[] parts, String fingerprint) { this.parts = parts; this.fingerprint = fingerprint; }
        boolean done() { return ready.getCount() == 0; }
        synchronized void complete(String value, Frame image) { if (done()) return; result = value; frame = image; ready.countDown(); }
        synchronized void fail(String message) { if (done()) return; failure = message; ready.countDown(); }
    }
    private static class Frame {
        final int width, height; final ByteBuffer pixels; final int[] colors;
        Frame(int width, int height, ByteBuffer pixels) { this.width = width; this.height = height; this.pixels = pixels; this.colors = null; }
        Frame(int width, int height, int[] colors) { this.width = width; this.height = height; this.pixels = null; this.colors = colors; }
        static Frame read(Class<?> api, int width, int height) throws Exception {
            if (width <= 0 || height <= 0 || (long) width * height > 8388608) throw new IOException("Framebuffer is unavailable or exceeds capture limit");
            ClassLoader loader = api.getClassLoader(); Class<?> gl = Class.forName("org.lwjgl.opengl.GL11", true, loader);
            Method get = gl.getMethod("glGetInteger", int.class), pixelStore = gl.getMethod("glPixelStorei", int.class, int.class), readBuffer = gl.getMethod("glReadBuffer", int.class);
            Object capabilities = Class.forName(api.getName().endsWith("GLFW") ? "org.lwjgl.opengl.GL" : "org.lwjgl.opengl.GLContext", true, loader).getMethod("getCapabilities").invoke(null);
            boolean modern = capabilities.getClass().getField("OpenGL30").getBoolean(capabilities);
            Method bind = modern ? Class.forName("org.lwjgl.opengl.GL30", true, loader).getMethod("glBindFramebuffer", int.class, int.class) : null;
            int framebuffer = modern ? (Integer) get.invoke(null, 0x8CAA) : 0;
            int previousRead = (Integer) get.invoke(null, 0x0C02);
            int[] settings = { 0x0D05, 0x0D02, 0x0D03, 0x0D04, 0x0D00, 0x0D01 }, previous = new int[6];
            for (int i = 0; i < settings.length; i++) previous[i] = (Integer) get.invoke(null, settings[i]);
            boolean pboSupported = capabilities.getClass().getField("OpenGL21").getBoolean(capabilities);
            Method bindBuffer = pboSupported ? Class.forName("org.lwjgl.opengl.GL15", true, loader).getMethod("glBindBuffer", int.class, int.class) : null;
            int pbo = pboSupported ? (Integer) get.invoke(null, 0x88ED) : 0;
            ByteBuffer pixels = ByteBuffer.allocateDirect(width * height * 4);
            try {
                if (bind != null) bind.invoke(null, 0x8CA8, 0);
                readBuffer.invoke(null, 0x0405); // Read the just-rendered BACK buffer immediately before its swap.
                if (bindBuffer != null) bindBuffer.invoke(null, 0x88EB, 0);
                for (int i = 0; i < settings.length; i++) pixelStore.invoke(null, settings[i], i == 0 ? 1 : 0);
                gl.getMethod("glReadPixels", int.class, int.class, int.class, int.class, int.class, int.class, ByteBuffer.class).invoke(null, 0, 0, width, height, 0x1908, 0x1401, pixels);
            } finally {
                if (bindBuffer != null) bindBuffer.invoke(null, 0x88EB, pbo);
                if (bind != null) bind.invoke(null, 0x8CA8, framebuffer);
                readBuffer.invoke(null, previousRead);
                for (int i = 0; i < settings.length; i++) pixelStore.invoke(null, settings[i], previous[i]);
            }
            return new Frame(width, height, pixels);
        }
        byte[] png() throws IOException {
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            int[] rgb = colors != null ? colors : new int[width * height];
            if (colors == null) for (int row = 0; row < height; row++) for (int column = 0; column < width; column++) { int at = (row * width + column) * 4; rgb[(height - row - 1) * width + column] = ((pixels.get(at) & 255) << 16) | ((pixels.get(at + 1) & 255) << 8) | (pixels.get(at + 2) & 255); }
            image.setRGB(0, 0, width, height, rgb, 0, width);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); ImageIO.write(image, "png", bytes); return bytes.toByteArray();
        }
    }
    private static String pid() { String name = ManagementFactory.getRuntimeMXBean().getName(); return name.substring(0, name.indexOf('@')); }
    private static String reason(Throwable cause) { while (cause.getCause() != null) cause = cause.getCause(); return cause.toString(); }
    private static int integer(String value, int min, int max) { int parsed = Integer.parseInt(value); if (parsed < min || parsed > max) throw new IllegalArgumentException("Integer outside range"); return parsed; }
    private static double number(String value) { double parsed = Double.parseDouble(value); if (Double.isNaN(parsed) || Double.isInfinite(parsed)) throw new IllegalArgumentException("Expected finite number"); return parsed; }
    private static void require(String[] request, int length) { if (request.length != length) throw new IllegalArgumentException("Invalid operation arguments"); }
    private static String quote(String value) {
        if (value == null) return "null"; StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) { char character = value.charAt(index); if (character == '"' || character == '\\') result.append('\\').append(character); else if (character < 32) result.append(String.format("\\u%04x", (int) character)); else result.append(character); }
        return result.append('"').toString();
    }
}
