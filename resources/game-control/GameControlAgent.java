package dev.modmind.gamecontrol;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.util.jar.JarFile;

/** Loaded only into an explicitly owned test JVM. Java 8 is the minimum. */
public final class GameControlAgent {
    public static void premain(String configuration, Instrumentation instrumentation) throws Exception {
        File jar = new File(GameControlAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        // Knot, LaunchWrapper and module-based loaders must share the same bridge and input state.
        instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(jar));
        Class<?> bridge = Class.forName("dev.modmind.gamecontrol.InputBridge", true, null);
        // Windows JVMs can decode non-ASCII javaagent option strings incorrectly.
        // Environment values retain the native Unicode project/session path.
        bridge.getMethod("start", String.class).invoke(null, System.getenv("MODMIND_GAME_CONTROL_CONFIG"));
        instrumentation.addTransformer(new InputTransformer(), false);
        instrumentation.addTransformer(new SdlTransformer(), false);
    }
}
