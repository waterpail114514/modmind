package com.google.gson;
import java.util.*;
import java.util.stream.*;

/** Small fixture encoder for transport tests. Production uses Minecraft's Gson. */
public class Gson {
    public String toJson(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean || value instanceof Number) return value.toString();
        if (value instanceof Map<?, ?> map) return map.entrySet().stream().map(entry -> toJson(entry.getKey().toString()) + ":" + toJson(entry.getValue())).collect(Collectors.joining(",", "{", "}"));
        return "\"" + value.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }
}
