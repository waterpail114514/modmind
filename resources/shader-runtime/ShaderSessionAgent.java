package dev.modmind.shader;

import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Owned-client Iris adapter. No game bytecode or installed JAR is modified. */
public final class ShaderSessionAgent {
    private static Instrumentation instrumentation;
    private static String sessionId, secret;
    private static volatile Class<?> minecraftClass, irisClass;
    private static volatile long lastRequest = System.nanoTime();
    private static final long started = System.nanoTime();
    private static volatile boolean stopping;
    private static volatile String lastPipelineError;
    private static final ThreadPoolExecutor clients = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4), r -> {
        Thread thread = new Thread(r, "ModMind shader control"); thread.setDaemon(true); return thread;
    });

    public static void premain(String configuration, Instrumentation api) throws Exception {
        instrumentation = api;
        Properties properties = new Properties();
        try (Reader input = Files.newBufferedReader(Path.of(configuration), StandardCharsets.UTF_8)) { properties.load(input); }
        sessionId = properties.getProperty("sessionId"); secret = System.getenv("MODMIND_SHADER_SESSION_TOKEN");
        int port = Integer.parseInt(properties.getProperty("port"));
        if (sessionId == null || !sessionId.matches("[a-f0-9-]{36}") || secret == null || !secret.matches("[a-f0-9]{64}") || port < 1024 || port > 65535) throw new IllegalArgumentException("Invalid owned session configuration");
        ServerSocket server = new ServerSocket();
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 4); server.setSoTimeout(1000);
        Thread listener = new Thread(() -> {
            while (!stopping) {
                try {
                    Socket socket = server.accept(); socket.setSoTimeout(15000);
                    if (clients.getQueue().size() >= 4) socket.close();
                    else clients.execute(() -> handle(socket));
                } catch (SocketTimeoutException ignored) {
                } catch (Exception ignored) { if (server.isClosed()) break; }
                if (System.nanoTime() - started > TimeUnit.MINUTES.toNanos(20) || System.nanoTime() - lastRequest > TimeUnit.MINUTES.toNanos(5)) {
                    try { onGameThread(() -> { invoke(client(), "stop"); return null; }); stopping = true; }
                    catch (Exception ignored) {
                        if (System.nanoTime() - started > TimeUnit.MINUTES.toNanos(21) || System.nanoTime() - lastRequest > TimeUnit.MINUTES.toNanos(6)) {
                            System.err.println("ModMind shader session lease expired; owned client did not stop gracefully");
                            Runtime.getRuntime().halt(2);
                        }
                    }
                }
            }
            try { server.close(); } catch (IOException ignored) {}
            clients.shutdown();
        }, "ModMind shader listener");
        listener.setDaemon(true); listener.start();
    }

    private static void handle(Socket socket) {
        try (socket) {
            InputStream input = socket.getInputStream(); ByteArrayOutputStream line = new ByteArrayOutputStream();
            for (int next; (next = input.read()) != -1 && next != '\n';) {
                if (line.size() >= 1024) throw new IOException("Request too large"); line.write(next);
            }
            String[] request = line.toString(StandardCharsets.UTF_8).split("\t", -1);
            if (request.length != 3 || !request[0].matches("[a-f0-9-]{36}") || !java.security.MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8), request[1].getBytes(StandardCharsets.UTF_8))) return;
            String result, status = "ok";
            try {
                lastRequest = System.nanoTime();
                if (request[2].equals("hello")) result = "{\"protocol\":1,\"sessionId\":\"" + sessionId + "\",\"pid\":" + ProcessHandle.current().pid() + "}";
                else if (request[2].equals("state") || request[2].equals("reload")) {
                    result = onGameThread(() -> {
                        if (request[2].equals("reload")) {
                            lastPipelineError = null;
                            try { invoke(iris(), "reload"); } catch (Exception error) { lastPipelineError = reason(error); throw error; }
                        }
                        return json(observe());
                    });
                } else if (request[2].equals("stop")) {
                    onGameThread(() -> { invoke(client(), "stop"); return null; });
                    stopping = true; result = "{\"requested\":true}";
                } else throw new IllegalArgumentException("Unsupported operation");
            } catch (Exception error) { status = "error"; result = reason(error); }
            String response = request[0] + "\t" + status + "\t" + Base64.getEncoder().encodeToString(result.getBytes(StandardCharsets.UTF_8)) + "\n";
            socket.getOutputStream().write(response.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    private static String reason(Throwable error) {
        while (error.getCause() != null) error = error.getCause();
        String message = error.toString(); return message.substring(0, Math.min(message.length(), 2000));
    }
    private static Class<?> loaded(String name) throws ClassNotFoundException {
        for (Class<?> type : instrumentation.getAllLoadedClasses()) if (type.getName().equals(name)) return type;
        throw new ClassNotFoundException("Client not ready: " + name);
    }
    private static Class<?> iris() throws Exception {
        if (irisClass == null) irisClass = loaded("net.irisshaders.iris.Iris"); return irisClass;
    }
    private static Object client() throws Exception {
        if (minecraftClass == null) minecraftClass = loaded("net.minecraft.client.Minecraft");
        Object client = minecraftClass.getMethod("getInstance").invoke(null);
        if (client == null) throw new IllegalStateException("Client not ready"); return client;
    }
    private static Object invoke(Object receiver, String name, Object... args) throws Exception {
        Class<?> type = receiver instanceof Class<?> c ? c : receiver.getClass();
        for (Method method : type.getMethods()) if (method.getName().equals(name) && method.getParameterCount() == args.length) {
            try { return method.invoke(receiver instanceof Class<?> ? null : receiver, args); } catch (IllegalArgumentException ignored) {}
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }
    private static <T> T onGameThread(Callable<T> action) throws Exception {
        Object game = client(); FutureTask<T> task = new FutureTask<>(action);
        invoke(game, "execute", task);
        try { return task.get(10, TimeUnit.SECONDS); }
        catch (Exception error) { task.cancel(false); throw error; }
    }
    private static String json(Object value) throws Exception {
        Class<?> gson = Class.forName("com.google.gson.Gson", true, iris().getClassLoader());
        return (String) gson.getMethod("toJson", Object.class).invoke(gson.getConstructor().newInstance(), value);
    }
    private static Map<String, Object> observe() throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("packName", invoke(iris(), "getCurrentPackName"));
        Object pack = ((Optional<?>) invoke(iris(), "getCurrentPack")).orElse(null);
        result.put("shaderPackLoaded", pack != null);
        Object manager = invoke(iris(), "getPipelineManager"), pipeline = invoke(manager, "getPipelineNullable");
        result.put("pipeline", pipeline == null ? null : pipeline.getClass().getName());
        // getStoredError() consumes the error; observation must preserve Iris's pending diagnostic.
        Field field = iris().getDeclaredField("storedError"); field.setAccessible(true);
        Object error = ((Optional<?>) field.get(null)).orElse(null);
        result.put("pipelineError", error == null ? lastPipelineError : reason((Throwable) error));
        Map<String, String> effective = new TreeMap<>();
        if (pack != null) {
            Object options = invoke(pack, "getShaderPackOptions"), values = invoke(options, "getOptionValues"), definitions = invoke(options, "getOptionSet");
            for (Object key : ((Map<?, ?>) invoke(definitions, "getBooleanOptions")).keySet()) effective.put(key.toString(), invoke(values, "getBooleanValueOrDefault", key.toString()).toString());
            for (Object key : ((Map<?, ?>) invoke(definitions, "getStringOptions")).keySet()) effective.put(key.toString(), invoke(values, "getStringValueOrDefault", key.toString()).toString());
            result.put("profile", String.valueOf(invoke(pack, "getProfileInfo")));
        } else result.put("profile", null);
        result.put("effectiveOptions", effective);
        result.put("gameReady", true); result.put("observedAt", java.time.Instant.now().toString());
        return result;
    }
}
