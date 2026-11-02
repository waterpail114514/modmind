package dev.modmind.gamecontrol;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import java.util.*;
import org.objectweb.asm.*;

/** SDL bindings plus the explicit unmapped 26.3 GPU submission boundary. */
public final class SdlTransformer implements ClassFileTransformer {
    private static final String ADAPTER = "dev/modmind/gamecontrol/SdlInput", BRIDGE = "dev/modmind/gamecontrol/InputBridge";
    public byte[] transform(ClassLoader loader, final String name, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
        final boolean minecraft = "net/minecraft/client/Minecraft".equals(name);
        if (!minecraft && (name == null || !name.startsWith("org/lwjgl/sdl/SDL"))) return null;
        if (!minecraft && !Arrays.asList("org/lwjgl/sdl/SDLEvents", "org/lwjgl/sdl/SDLKeyboard", "org/lwjgl/sdl/SDLMouse", "org/lwjgl/sdl/SDLVideo").contains(name)) return null;
        try {
            ClassReader reader = new ClassReader(bytes); ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
            final List<String> hooks = new ArrayList<String>();
            reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                public MethodVisitor visitMethod(int access, final String method, final String descriptor, String signature, String[] exceptions) {
                    MethodVisitor visitor = super.visitMethod(access, method, descriptor, signature, exceptions);
                    if ((access & (Opcodes.ACC_NATIVE | Opcodes.ACC_ABSTRACT)) != 0) return visitor;
                    if (name.endsWith("SDLEvents") && method.equals("SDL_PollEvent") && descriptor.equals("(Lorg/lwjgl/sdl/SDL_Event;)Z")) {
                        hooks.add(method + descriptor); visitor.visitCode(); visitor.visitLdcInsn(Type.getObjectType(name)); visitor.visitVarInsn(Opcodes.ALOAD, 0);
                        visitor.visitMethodInsn(Opcodes.INVOKESTATIC, ADAPTER, "poll", "(Ljava/lang/Class;Ljava/lang/Object;)Z", false); visitor.visitInsn(Opcodes.IRETURN); visitor.visitMaxs(2, 1); visitor.visitEnd(); return null;
                    }
                    return new MethodVisitor(Opcodes.ASM9, visitor) {
                        private void adapter(String method, String descriptor) { super.visitMethodInsn(Opcodes.INVOKESTATIC, ADAPTER, method, descriptor, false); }
                        private void bridge(String method, String descriptor) { super.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, method, descriptor, false); }
                        private void active(String target, String desc, int opcode, Runnable args) {
                            hooks.add(method + descriptor); Label original = new Label(); bridge("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original);
                            if (args != null) args.run(); if (target != null) adapter(target, desc); super.visitInsn(opcode);
                            super.visitLabel(original); super.visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                        }
                        public void visitCode() {
                            super.visitCode(); if (minecraft) return;
                            if (name.endsWith("SDLEvents") && method.equals("SDL_PollEvent") && descriptor.equals("(Lorg/lwjgl/sdl/SDL_Event;)Z")) {
                                hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); super.visitVarInsn(Opcodes.ALOAD, 0);
                                adapter("poll", "(Ljava/lang/Class;Ljava/lang/Object;)Z"); super.visitInsn(Opcodes.IRETURN);
                            }
                            if (name.endsWith("SDLKeyboard")) {
                                if (method.equals("SDL_GetKeyboardState") && descriptor.equals("()Ljava/nio/ByteBuffer;")) active("keyboardState", descriptor, Opcodes.ARETURN, null);
                                else if (method.equals("SDL_GetModState") && descriptor.equals("()S")) active("modifiers", descriptor, Opcodes.IRETURN, null);
                                else if (method.equals("SDL_GetKeyboardFocus") && descriptor.equals("()J")) active("window", "()J", Opcodes.LRETURN, null);
                                else if (method.equals("SDL_SetModState") && descriptor.equals("(S)V")) active(null, null, Opcodes.RETURN, null);
                            }
                            if (name.endsWith("SDLMouse")) {
                                if (method.equals("SDL_GetMouseFocus") && descriptor.equals("()J")) active("window", "()J", Opcodes.LRETURN, null);
                                else if ((method.equals("SDL_GetMouseState") || method.equals("SDL_GetGlobalMouseState") || method.equals("SDL_GetRelativeMouseState")) && descriptor.equals("(Ljava/nio/FloatBuffer;Ljava/nio/FloatBuffer;)I")) active(method.equals("SDL_GetRelativeMouseState") ? "relativeState" : "mouseState", descriptor, Opcodes.IRETURN, () -> { super.visitVarInsn(Opcodes.ALOAD, 0); super.visitVarInsn(Opcodes.ALOAD, 1); });
                                else if (method.equals("SDL_SetWindowRelativeMouseMode") && descriptor.equals("(JZ)Z")) active("relative", "(Z)Z", Opcodes.IRETURN, () -> super.visitVarInsn(Opcodes.ILOAD, 2));
                                else if (method.equals("SDL_GetWindowRelativeMouseMode") && descriptor.equals("(J)Z")) active("relative", "()Z", Opcodes.IRETURN, null);
                                else if (method.equals("SDL_WarpMouseInWindow") && descriptor.equals("(JFF)V")) active("warp", "(FF)V", Opcodes.RETURN, () -> { super.visitVarInsn(Opcodes.FLOAD, 2); super.visitVarInsn(Opcodes.FLOAD, 3); });
                                else if (method.equals("SDL_WarpMouseGlobal") && descriptor.equals("(FF)Z") || method.equals("SDL_CaptureMouse") && descriptor.equals("(Z)Z") || (method.equals("SDL_ShowCursor") || method.equals("SDL_HideCursor")) && descriptor.equals("()Z")) active(null, null, Opcodes.IRETURN, () -> super.visitInsn(Opcodes.ICONST_1));
                            }
                            if (name.endsWith("SDLVideo")) {
                                if (method.equals("nSDL_CreateWindow") && descriptor.equals("(JIIJ)J")) {
                                    hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); adapter("beforeCreate", "(Ljava/lang/Class;)V");
                                    super.visitVarInsn(Opcodes.LLOAD, 4); adapter("createFlags", "(J)J"); super.visitVarInsn(Opcodes.LSTORE, 4);
                                } else if (method.equals("SDL_CreateWindowWithProperties") && descriptor.equals("(I)J")) {
                                    hooks.add(method + descriptor); super.visitLdcInsn(Type.getObjectType(name)); super.visitVarInsn(Opcodes.ILOAD, 0); adapter("createProperties", "(Ljava/lang/Class;I)V");
                                } else if ((method.equals("SDL_SetWindowMouseGrab") || method.equals("SDL_SetWindowKeyboardGrab") || method.equals("SDL_RaiseWindow")) && (descriptor.equals("(JZ)Z") || descriptor.equals("(J)Z"))) active(null, null, Opcodes.IRETURN, () -> super.visitInsn(Opcodes.ICONST_1));
                                else if (method.equals("SDL_SetWindowFocusable") && descriptor.equals("(JZ)Z")) {
                                    Label original = new Label(); bridge("active", "()Z"); super.visitJumpInsn(Opcodes.IFEQ, original); super.visitInsn(Opcodes.ICONST_0); super.visitVarInsn(Opcodes.ISTORE, 2); super.visitLabel(original); super.visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                                } else if (method.equals("SDL_DestroyWindow") && descriptor.equals("(J)V")) { super.visitVarInsn(Opcodes.LLOAD, 0); bridge("windowDestroyed", "(J)V"); }
                            }
                        }
                        public void visitInsn(int opcode) {
                            if (name.endsWith("SDLVideo") && method.equals("SDL_GetWindowFlags") && descriptor.equals("(J)J") && opcode == Opcodes.LRETURN) adapter("windowFlags", "(J)J");
                            super.visitInsn(opcode);
                        }
                        public void visitMethodInsn(int opcode, String owner, String called, String desc, boolean contract) {
                            if (minecraft && method.equals("renderFrame") && descriptor.equals("(Z)V") && owner.equals("com/mojang/renderpearl/api/commands/CommandEncoder") && called.equals("submit") && desc.equals("()V")) {
                                hooks.add("renderFrame-before-submit"); super.visitVarInsn(Opcodes.ALOAD, 0); adapter("beforeSubmit", "(Ljava/lang/Object;)V");
                            }
                            super.visitMethodInsn(opcode, owner, called, desc, contract);
                        }
                    };
                }
            }, 0);
            if (hooks.isEmpty()) return null;
            InputBridge.transformed(name, hooks); return writer.toByteArray();
        } catch (Throwable invalid) { InputBridge.failure("transform " + name, invalid); return null; }
    }
}
