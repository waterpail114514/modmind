package net.irisshaders.iris;
import java.nio.file.*;
import java.util.*;

/** Explicit Iris-shaped JVM fixture; does not render or claim game compatibility. */
public class Iris {
    private static String name;
    private static Optional<Exception> storedError = Optional.empty();
    public static void reload() throws Exception {
        Properties settings = new Properties();
        try (var reader = Files.newBufferedReader(Path.of("config/iris.properties"))) { settings.load(reader); }
        name = settings.getProperty("shaderPack");
    }
    public static String getCurrentPackName() { return name; }
    public static Optional<Pack> getCurrentPack() { return Optional.of(new Pack()); }
    public static Manager getPipelineManager() { return new Manager(); }
    public static Optional<Exception> getStoredError() { var error = storedError; storedError = Optional.empty(); return error; }
    public static class Manager { public Object getPipelineNullable() { return new IrisRenderingPipeline(); } }
    public static class IrisRenderingPipeline {}
    public static class Pack {
        public Options getShaderPackOptions() { return new Options(); }
        public String getProfileInfo() { return "jvm-fixture"; }
    }
    public static class Options {
        public Values getOptionValues() { return new Values(); }
        public Definitions getOptionSet() { return new Definitions(); }
    }
    public static class Values {
        public boolean getBooleanValueOrDefault(String name) { return true; }
        public String getStringValueOrDefault(String name) { return "1.0"; }
    }
    public static class Definitions {
        public Map<String, Boolean> getBooleanOptions() { return Map.of("TAA", true); }
        public Map<String, String> getStringOptions() { return Map.of("EXPOSURE", "1.0"); }
    }
}
