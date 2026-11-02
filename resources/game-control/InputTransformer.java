package dev.modmind.gamecontrol;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import java.util.*;
import org.objectweb.asm.*;

/** Instruments LWJGL's Java bindings; never depends on Minecraft names or mappings. */
public final class InputTransformer implements ClassFileTransformer {
    private static final String BRIDGE = "dev/modmind/gamecontrol/InputBridge";
    private static final String GLFW = "org/lwjgl/glfw/GLFW";
    private static final String DISPLAY = "org/lwjgl/opengl/Display";
    private static final String WINDOWS = "org/lwjgl/opengl/WindowsDisplay";
    private static final Set<String> CALLBACKS = new HashSet<String>(Arrays.asList(
        "Key", "Char", "CharMods", "MouseButton", "CursorPos", "CursorEnter", "Scroll", "WindowFocus"));

    public byte[] transform(ClassLoader loader, final String name, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
        final boolean callback = name != null && name.startsWith("org/lwjgl/glfw/GLFW") && name.endsWith("CallbackI")
            && CALLBACKS.contains(name.substring("org/lwjgl/glfw/GLFW".length(), name.length() - "CallbackI".length()));
        if (!GLFW.equals(name) && !DISPLAY.equals(name) && !WINDOWS.equals(name) && !"org/lwjgl/input/Keyboard".equals(name) && !"org/lwjgl/input/Mouse".equals(name) && !callback) return null;
        try {
            ClassReader reader = new ClassReader(bytes);
            final boolean stackMaps = reader.readShort(6) >= Opcodes.V1_6;
            // Only prepend branches whose merge point has the original empty operand stack.
            // Explicit F_SAME frames avoid resolving game classes inside their class loader.
            ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
            final List<String> hooks = new ArrayList<String>();
            reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                public MethodVisitor visitMethod(int access, final String method, final String descriptor, String signature, String[] exceptions) {
                    MethodVisitor visitor = super.visitMethod(access, method, descriptor, signature, exceptions);
                    if ((access & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_NATIVE)) != 0) return visitor;
                    return new MethodVisitor(Opcodes.ASM9, visitor) {
                        private void call(String target, String desc) { super.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, target, desc, false); }
                        private void sameFrame() { if (stackMaps) super.visitFrame(Opcodes.F_SAME, 0, null, 0, null); }
                        private void activeReturn(String target, String desc, int opcode, Runnable arguments) {
                            hooks.add(method + descriptor);
                            Label original = new Label(); call("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                            if (arguments != null) arguments.run();
                            if (target != null) call(target, desc);
                            super.visitInsn(opcode); super.visitLabel(original); sameFrame();
                        }
                        private void load(final int opcode, final int slot) { super.visitVarInsn(opcode, slot); }
                        public void visitCode() {
                            super.visitCode();
                            if (callback && method.equals("callback") && (descriptor.equals("(J)V") || descriptor.equals("(JJ)V"))) {
                                activeReturn(null, null, Opcodes.RETURN, null);
                            } else if (GLFW.equals(name)) {
                                if (method.equals("glfwShowWindow") && descriptor.equals("(J)V")) {
                                    hooks.add(method + descriptor); Label original = new Label();
                                    super.visitLdcInsn(Type.getObjectType(name)); load(Opcodes.LLOAD, 0); call("showWindow", "(Ljava/lang/Class;J)Z");
                                    super.visitJumpInsn(Opcodes.IFEQ, original); super.visitInsn(Opcodes.RETURN); super.visitLabel(original); sameFrame();
                                }
                                if (method.equals("glfwDestroyWindow") && descriptor.equals("(J)V")) {
                                    hooks.add(method + descriptor); load(Opcodes.LLOAD, 0); call("windowDestroyed", "(J)V");
                                }
                                if (method.equals("glfwCreateWindow") && (descriptor.equals("(IILjava/lang/CharSequence;JJ)J") || descriptor.equals("(IILjava/nio/ByteBuffer;JJ)J"))) {
                                    hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); call("beforeCreate", "(Ljava/lang/Class;)V");
                                }
                                if (method.startsWith("glfwSet") && method.endsWith("Callback") && descriptor.startsWith("(JLorg/lwjgl/glfw/")) {
                                    String kind = method.substring(7, method.length() - 8);
                                    if (CALLBACKS.contains(kind)) {
                                        hooks.add(method + descriptor); load(Opcodes.LLOAD, 0); super.visitLdcInsn(kind); load(Opcodes.ALOAD, 2);
                                        call("registerCallback", "(JLjava/lang/String;Ljava/lang/Object;)V");
                                    }
                                }
                                if (method.equals("glfwGetKey") && descriptor.equals("(JI)I"))
                                    activeReturn("key", "(I)I", Opcodes.IRETURN, () -> load(Opcodes.ILOAD, 2));
                                if (method.equals("glfwGetMouseButton") && descriptor.equals("(JI)I"))
                                    activeReturn("button", "(I)I", Opcodes.IRETURN, () -> load(Opcodes.ILOAD, 2));
                                if (method.equals("glfwGetWindowAttrib") && descriptor.equals("(JI)I")) {
                                    Label original = new Label(); call("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                                    load(Opcodes.ILOAD, 2); super.visitLdcInsn(0x00020001); super.visitJumpInsn(Opcodes.IF_ICMPNE, original);
                                    super.visitInsn(Opcodes.ICONST_1); super.visitInsn(Opcodes.IRETURN);
                                    super.visitLabel(original); sameFrame(); hooks.add(method + descriptor);
                                }
                                if (method.equals("glfwSetInputMode") && descriptor.equals("(JII)V")) {
                                    Label original = new Label(); call("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                                    load(Opcodes.ILOAD, 2); super.visitLdcInsn(0x00033001); super.visitJumpInsn(Opcodes.IF_ICMPNE, original);
                                    load(Opcodes.ILOAD, 3); call("cursorMode", "(I)V");
                                    // Keep the real cursor free even when Minecraft requests DISABLED/HIDDEN.
                                    super.visitLdcInsn(0x00034001); super.visitVarInsn(Opcodes.ISTORE, 3);
                                    super.visitLabel(original); sameFrame(); hooks.add(method + descriptor);
                                }
                                if (method.equals("glfwGetInputMode") && descriptor.equals("(JI)I")) {
                                    Label original = new Label(); call("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                                    load(Opcodes.ILOAD, 2); super.visitLdcInsn(0x00033001); super.visitJumpInsn(Opcodes.IF_ICMPNE, original);
                                    call("cursorMode", "()I"); super.visitInsn(Opcodes.IRETURN);
                                    super.visitLabel(original); sameFrame(); hooks.add(method + descriptor);
                                }
                                if (method.equals("glfwSetCursorPos") && descriptor.equals("(JDD)V"))
                                    activeReturn("warp", "(DD)V", Opcodes.RETURN, () -> { load(Opcodes.DLOAD, 2); load(Opcodes.DLOAD, 4); });
                                if (method.equals("glfwGetCursorPos") && descriptor.equals("(JLjava/nio/DoubleBuffer;Ljava/nio/DoubleBuffer;)V"))
                                    activeReturn("cursor", "(Ljava/nio/DoubleBuffer;Ljava/nio/DoubleBuffer;)V", Opcodes.RETURN, () -> { load(Opcodes.ALOAD, 2); load(Opcodes.ALOAD, 3); });
                                if (method.equals("glfwGetCursorPos") && descriptor.equals("(J[D[D)V"))
                                    activeReturn("cursor", "([D[D)V", Opcodes.RETURN, () -> { load(Opcodes.ALOAD, 2); load(Opcodes.ALOAD, 3); });
                                if ((method.equals("glfwFocusWindow") || method.equals("glfwRequestWindowAttention")) && descriptor.equals("(J)V"))
                                    activeReturn(null, null, Opcodes.RETURN, null);
                                if (method.equals("glfwSwapBuffers") && descriptor.equals("(J)V")) {
                                    hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); load(Opcodes.LLOAD, 0);
                                    call("beforeSwap", "(Ljava/lang/Class;J)V");
                                }
                            } else if (WINDOWS.equals(name)) {
                                if (method.equals("reshape") && descriptor.equals("(IIII)V"))
                                    activeReturn("legacyReshape", "(Ljava/lang/Object;IIII)V", Opcodes.RETURN, () -> { load(Opcodes.ALOAD, 0); for (int slot = 1; slot <= 4; slot++) load(Opcodes.ILOAD, slot); });
                                if ((method.equals("grabFocus") || method.equals("updateCursor") || method.equals("updateClipping")) && descriptor.equals("()V"))
                                    activeReturn(null, null, Opcodes.RETURN, null);
                                if (method.equals("centerCursor") && descriptor.equals("(J)V")) activeReturn(null, null, Opcodes.RETURN, null);
                            } else if (DISPLAY.equals(name)) {
                                if (method.equals("destroyWindow") && descriptor.equals("()V")) {
                                    hooks.add(method + descriptor); super.visitInsn(Opcodes.LCONST_0); call("windowDestroyed", "(J)V");
                                }
                                if (method.equals("isActive") && descriptor.equals("()Z"))
                                    activeReturn(null, null, Opcodes.IRETURN, () -> super.visitInsn(Opcodes.ICONST_1));
                                if (method.equals("swapBuffers") && descriptor.equals("()V")) {
                                    hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); super.visitInsn(Opcodes.LCONST_0);
                                    call("beforeSwap", "(Ljava/lang/Class;J)V");
                                }
                            } else {
                                final boolean mouse = name.endsWith("/Mouse");
                                if (method.equals("poll") && descriptor.equals("()V")) activeReturn(null, null, Opcodes.RETURN, null);
                                if (method.equals(mouse ? "isButtonDown" : "isKeyDown") && descriptor.equals("(I)Z"))
                                    activeReturn(mouse ? "button" : "key", "(I)I", Opcodes.IRETURN, () -> load(Opcodes.ILOAD, 0));
                                if (method.equals("next") && descriptor.equals("()Z"))
                                    activeReturn(mouse ? "mouseNext" : "keyNext", "()Z", Opcodes.IRETURN, null);
                                Map<String,String> readers = mouse ? mouseReaders() : keyReaders();
                                if (readers.containsKey(method) && descriptor.startsWith("()"))
                                    activeReturn(readers.get(method), descriptor, Type.getReturnType(descriptor).getOpcode(Opcodes.IRETURN), null);
                                if (mouse && method.equals("setGrabbed") && descriptor.equals("(Z)V")) {
                                    Label original = new Label(); call("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                                    load(Opcodes.ILOAD, 0); call("grabbed", "(Z)V"); super.visitInsn(Opcodes.ICONST_0); super.visitVarInsn(Opcodes.ISTORE, 0);
                                    super.visitLabel(original); sameFrame(); hooks.add(method + descriptor);
                                }
                                if (mouse && method.equals("setCursorPosition") && descriptor.equals("(II)V"))
                                    activeReturn("legacyWarp", "(II)V", Opcodes.RETURN, () -> { load(Opcodes.ILOAD, 0); load(Opcodes.ILOAD, 1); });
                            }
                        }
                        public void visitMethodInsn(int opcode, String owner, String target, String desc, boolean isInterface) {
                            if (WINDOWS.equals(name) && WINDOWS.equals(owner) && opcode == Opcodes.INVOKESTATIC &&
                                (target.equals("showWindow") || target.equals("setFocus") || target.equals("setForegroundWindow") || target.equals("nSetCursorPosition") || target.equals("clipCursor") || target.equals("setWindowPos"))) {
                                hooks.add("native-call:" + target + desc);
                                super.visitMethodInsn(opcode, owner, "modmind$" + target, desc, false);
                            } else super.visitMethodInsn(opcode, owner, target, desc, isInterface);
                        }
                        public void visitInsn(int opcode) {
                            if (opcode == Opcodes.RETURN && ((GLFW.equals(name) && method.equals("glfwPollEvents") && descriptor.equals("()V"))
                                || (DISPLAY.equals(name) && method.equals("processMessages") && descriptor.equals("()V")))) {
                                hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); call("pump", "(Ljava/lang/Class;)V");
                            }
                            super.visitInsn(opcode);
                        }
                    };
                }
                public void visitEnd() {
                    if (WINDOWS.equals(name)) {
                        nativeGuard("showWindow", "(JI)V", true);
                        nativeGuard("setFocus", "(J)V", false);
                        nativeGuard("setForegroundWindow", "(J)V", false);
                        nativeGuard("nSetCursorPosition", "(II)V", false);
                        nativeGuard("clipCursor", "(Ljava/nio/IntBuffer;)V", false);
                        MethodVisitor position = super.visitMethod(Opcodes.ACC_PRIVATE | Opcodes.ACC_STATIC, "modmind$setWindowPos", "(JJIIIIJ)Z", null, null);
                        position.visitCode();
                        position.visitVarInsn(Opcodes.LLOAD, 0); position.visitVarInsn(Opcodes.LLOAD, 2);
                        for (int slot = 4; slot <= 7; slot++) position.visitVarInsn(Opcodes.ILOAD, slot);
                        position.visitVarInsn(Opcodes.LLOAD, 8);
                        position.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "positionFlags", "(J)J", false);
                        position.visitMethodInsn(Opcodes.INVOKESTATIC, WINDOWS, "setWindowPos", "(JJIIIIJ)Z", false);
                        position.visitInsn(Opcodes.IRETURN); position.visitMaxs(0, 0); position.visitEnd();
                    }
                    super.visitEnd();
                }
                private void nativeGuard(String target, String descriptor, boolean show) {
                    MethodVisitor method = super.visitMethod(Opcodes.ACC_PRIVATE | Opcodes.ACC_STATIC, "modmind$" + target, descriptor, null, null);
                    method.visitCode(); Label original = new Label();
                    method.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "active", "()Z", false); method.visitJumpInsn(Opcodes.IFEQ, original);
                    if (show) {
                        // Win32 may consume the launcher's STARTUPINFO show state
                        // on the first call. Repeat NOACTIVATE so a hidden Java
                        // console startup cannot leave the game minimized/hidden.
                        for (int attempt = 0; attempt < 2; attempt++) { method.visitVarInsn(Opcodes.LLOAD, 0); method.visitInsn(Opcodes.ICONST_4); method.visitMethodInsn(Opcodes.INVOKESTATIC, WINDOWS, target, descriptor, false); }
                    }
                    method.visitInsn(Opcodes.RETURN); method.visitLabel(original); if (stackMaps) method.visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                    int slot = 0;
                    for (Type argument : Type.getArgumentTypes(descriptor)) { method.visitVarInsn(argument.getOpcode(Opcodes.ILOAD), slot); slot += argument.getSize(); }
                    method.visitMethodInsn(Opcodes.INVOKESTATIC, WINDOWS, target, descriptor, false); method.visitInsn(Opcodes.RETURN); method.visitMaxs(0, 0); method.visitEnd();
                }
            }, 0);
            InputBridge.transformed(name, hooks);
            return writer.toByteArray();
        } catch (Throwable error) {
            InputBridge.failure("transform " + name, error);
            // A partially connected input path must never advertise readiness.
            throw new IllegalStateException("Cannot instrument owned input binding " + name, error);
        }
    }

    private static Map<String,String> keyReaders() {
        Map<String,String> map = new HashMap<String,String>();
        map.put("getEventKey", "eventKey"); map.put("getEventKeyState", "eventKeyState"); map.put("getEventCharacter", "eventCharacter");
        map.put("getEventNanoseconds", "keyEventNanos"); map.put("isRepeatEvent", "repeatEvent"); map.put("getNumKeyboardEvents", "keyEventCount"); return map;
    }
    private static Map<String,String> mouseReaders() {
        Map<String,String> map = new HashMap<String,String>();
        map.put("getX", "mouseX"); map.put("getY", "mouseY"); map.put("getDX", "mouseDX"); map.put("getDY", "mouseDY"); map.put("getDWheel", "mouseWheel");
        map.put("isGrabbed", "grabbed"); map.put("isInsideWindow", "inside"); map.put("getEventButton", "eventButton"); map.put("getEventButtonState", "eventButtonState");
        map.put("getEventX", "eventX"); map.put("getEventY", "eventY"); map.put("getEventDX", "eventDX"); map.put("getEventDY", "eventDY"); map.put("getEventDWheel", "eventWheel");
        map.put("getEventNanoseconds", "mouseEventNanos"); return map;
    }
}
