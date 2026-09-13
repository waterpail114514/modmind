# 无外置 Fabric API 的模组测试

Fabric Loader 不自带完整 Fabric API。模组可以内嵌实际需要的 API 子模块，让玩家不必另装完整 API；是否可行需要核对具体功能、Minecraft 版本、模块及传递依赖，不能只删除 `fabric.mod.json` 的依赖声明。

ModMind 的工作台提示已加入这一区分：用户提出无外置 API 的要求时，AI 应评估并实现合适的内嵌方案、检查最终 JAR，然后验证启动和相关功能。普通项目不强制改成模块化依赖。

## 测试实例开关

项目默认仍根据 API 版本自动安装完整 Fabric API / Quilted Fabric API。需要测试无外置 API 时，在项目的 `.modmind/minecraft-test.json` 中合并以下字段：

```json
{
  "managedLoaderApi": false
}
```

下一次准备或启动内置测试实例时，ModMind 跳过完整 API 下载，并清理 `.modmind/minecraft/mods` 下本工具管理的 API JAR 和对应版本标记。缓存实例也会执行这个步骤。此配置不改变项目的 `apiVersion`、Gradle 编译依赖或发布元数据；将字段设回 `true` 或删除字段可恢复默认安装。无效 JSON 或非布尔值会明确报错，不会静默开启安装。整合包仍按其清单管理模组，不使用此开关。

开关不删除手动安装的模组。验证前还需检查测试实例中的外置 API、其他模组及其内嵌依赖，以免它们补齐目标模组缺少的模块。使用只包含目标模组及必要前置的测试环境，检查最终发布 JAR 的嵌套 JAR、模块依赖和许可证，构建并同步后实际启动并测试相关功能。成功启动仅证明已执行的启动场景，不能代替功能验证。

本开关用于 ModMind 内置测试实例；独立 Gradle `runClient`、外部启动器或单独配置的服务端需分别检查其运行依赖。
