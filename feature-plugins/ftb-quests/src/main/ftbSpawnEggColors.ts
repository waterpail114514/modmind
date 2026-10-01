import { ClassReader, ClassVisitor, Handle, MethodVisitor, Opcodes } from '@xmcl/asm'

/** Recognize constant ForgeSpawnEggItem registrations, without executing mod code. */
export function constantSpawnEggColors(bytes: Buffer): Map<string, number[]> {
  const suppliers = new Map<string, string>()
  const colors = new Map<string, number[]>()
  class Visitor extends ClassVisitor {
    constructor() { super(Opcodes.ASM5) }
    override visitMethod(_access: number, method: string, _desc: string, _signature: string | null, _exceptions: string[] | null): MethodVisitor {
      let registration = '', supplier = '', egg = false, properties = false
      const constants: number[] = []
      return new class extends MethodVisitor {
        constructor() { super(Opcodes.ASM5) }
        override visitTypeInsn(opcode: number, type: string): void {
          if (opcode === Opcodes.NEW && type === 'net/minecraftforge/common/ForgeSpawnEggItem') { egg = true; properties = false; constants.length = 0 }
          else if (egg && opcode === Opcodes.NEW) properties = true
        }
        override visitLdcInsn(value: unknown): void {
          if (method === '<clinit>' && typeof value === 'string') registration = value
          if (egg && !properties && typeof value === 'number') constants.push(value)
        }
        override visitIntInsn(opcode: number, operand: number): void { if (egg && !properties && (opcode === Opcodes.BIPUSH || opcode === Opcodes.SIPUSH)) constants.push(operand) }
        override visitInsn(opcode: number): void {
          if (egg && !properties && opcode >= Opcodes.ICONST_M1 && opcode <= Opcodes.ICONST_5) constants.push(opcode - Opcodes.ICONST_0)
        }
        override visitInvokeDynamicInsn(_name: string, _desc: string, _bootstrap: Handle, ...args: unknown[]): void {
          supplier = args.find((arg): arg is Handle => arg instanceof Handle)?.name ?? ''
        }
        override visitMethodInsn(_opcode: number, owner: string, name: string, desc: string, _itf: boolean): void {
          if (method === '<clinit>' && owner === 'net/minecraftforge/registries/DeferredRegister' && name === 'register' && registration && supplier) {
            suppliers.set(registration, supplier); registration = ''; supplier = ''
          }
          if (egg && owner === 'net/minecraftforge/common/ForgeSpawnEggItem' && name === '<init>' && desc === '(Ljava/util/function/Supplier;IILnet/minecraft/world/item/Item$Properties;)V') {
            if (constants.length === 2) colors.set(method, [...constants])
            egg = false
          }
        }
      }()
    }
  }
  try { new ClassReader(bytes).accept(new Visitor(), [], ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES) } catch { return new Map() }
  return new Map([...suppliers].flatMap(([id, supplier]) => colors.has(supplier) ? [[id, colors.get(supplier)!]] : []))
}
