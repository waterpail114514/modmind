package net.minecraft.client;
import java.util.concurrent.*;

/** JVM integration fixture, not a Minecraft implementation. */
public class Minecraft {
    private static final Minecraft INSTANCE = new Minecraft();
    private final BlockingQueue<Runnable> tasks = new LinkedBlockingQueue<>();
    private volatile boolean running = true;
    public static Minecraft getInstance() { return INSTANCE; }
    public void execute(Runnable action) { tasks.add(action); }
    public void stop() { running = false; }
    public void run() throws Exception {
        net.irisshaders.iris.Iris.reload();
        while (running) { Runnable task = tasks.poll(100, TimeUnit.MILLISECONDS); if (task != null) task.run(); }
    }
}
