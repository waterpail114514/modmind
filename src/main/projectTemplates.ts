import type { LoaderKind, ProjectInfo } from '../shared/types'
import { isJavaLoader } from '../shared/projectPlatform'
import {
  assertProjectCreationSupported,
  compareMinecraftVersions,
  gradleWrapperProperties,
  loaderBuildCompatibility,
  officialTemplateSources
} from './loaderCompatibility'
import { CURRENT_PROJECT_VERSION } from './projectVersion'
import { bedrockTemplateFiles, neteaseTemplateFiles } from './addonTemplates'
import { normalizeProjectName, projectPropertiesValue } from '../shared/projectName'
import { pluginTemplateFiles } from './serverPluginTemplates'

function slugPackage(project: ProjectInfo): { name: string; path: string } {
  const name = `dev.modmind.${project.namespace}`
  return { name, path: name.replaceAll('.', '/') }
}

function javaString(value: string): string {
  return JSON.stringify(value)
}

function propertyValue(value: string): string {
  return projectPropertiesValue(value)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function commonProperties(project: ProjectInfo, javaVersion: number): string[] {
  return [
    'org.gradle.jvmargs=-Xmx2G',
    'org.gradle.parallel=true',
    'org.gradle.caching=true',
    `minecraft_version=${propertyValue(project.minecraftVersion)}`,
    `loader_version=${propertyValue(project.loaderVersion ?? '')}`,
    `java_version=${javaVersion}`,
    'mod_version=0.1.0',
    `mod_id=${propertyValue(project.namespace)}`,
    `mod_name=${propertyValue(project.name)}`,
    'mod_license=MIT',
    `maven_group=dev.modmind.${project.namespace}`,
    `archives_base_name=${project.namespace}`
  ]
}

function javaConfiguration(javaVersion: number, toolchain = true): string {
  return `tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
    options.release = ${javaVersion}
}

java {
${toolchain ? `    toolchain.languageVersion = JavaLanguageVersion.of(${javaVersion})\n` : ''}    withSourcesJar()
}
`
}

export function descriptorPath(loader: LoaderKind, minecraftVersion: string): string {
  if (loader === 'bedrock' || loader === 'netease-pc' || loader === 'netease-mobile') return 'behavior_pack/manifest.json'
  if (loader === 'fabric') return 'src/main/resources/fabric.mod.json'
  if (loader === 'quilt') return 'src/main/resources/quilt.mod.json'
  if (loader === 'forge' && compareMinecraftVersions(minecraftVersion, '1.13') < 0) return 'src/main/resources/mcmod.info'
  if (loader === 'neoforge' && compareMinecraftVersions(minecraftVersion, '1.20.5') >= 0) {
    return 'src/main/resources/META-INF/neoforge.mods.toml'
  }
  return 'src/main/resources/META-INF/mods.toml'
}

function fabricFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const compatibility = loaderBuildCompatibility('fabric', project.minecraftVersion)
  const unobfuscated = project.minecraftVersion.startsWith('26.')
  const javaVersion = project.javaVersion ?? compatibility.javaVersion
  const packageInfo = slugPackage(project)
  const apiVersion = project.apiVersion?.trim()
  const properties = [
    ...commonProperties(project, javaVersion),
    ...(apiVersion ? [`fabric_api_version=${propertyValue(apiVersion)}`] : [])
  ]
  const descriptor: Record<string, unknown> = {
    schemaVersion: 1,
    id: project.namespace,
    version: '${version}',
    name: project.name,
    description: 'Created with ModMind',
    environment: '*',
    ...(includeStarter ? { entrypoints: { main: [`${packageInfo.name}.ModMindEntry`] } } : {}),
    depends: {
      fabricloader: `>=${project.loaderVersion}`,
      ...(apiVersion ? { 'fabric-api': '*' } : {}),
      minecraft: project.minecraftVersion,
      java: `>=${javaVersion}`
    }
  }
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement {
    repositories {
        maven { url = 'https://repo.spongepowered.org/maven/' }
        maven { url = 'https://maven.fabricmc.net/' }
        gradlePluginPortal()
    }
}

rootProject.name = '${project.namespace}'
`,
    'gradle.properties': `${properties.join('\n')}\n`,
    'build.gradle': `plugins {
    id '${unobfuscated ? 'net.fabricmc.fabric-loom' : 'net.fabricmc.fabric-loom-remap'}' version '${compatibility.pluginVersion}'
    id 'maven-publish'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

repositories {
    maven { url = 'https://repo.spongepowered.org/maven/' }
    mavenCentral()
}

dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
${unobfuscated ? '' : '    mappings loom.officialMojangMappings()\n'}    ${unobfuscated ? 'implementation' : 'modImplementation'} "net.fabricmc:fabric-loader:\${project.loader_version}"
${apiVersion ? `    ${unobfuscated ? 'implementation' : 'modImplementation'} "net.fabricmc.fabric-api:fabric-api:\${project.fabric_api_version}"\n` : ''}
}

${javaConfiguration(javaVersion, false)}
processResources {
    filteringCharset = 'UTF-8'
    inputs.property 'version', project.version
    filesMatching('fabric.mod.json') { expand version: project.version }
}
`,
    [descriptorPath('fabric', project.minecraftVersion)]: JSON.stringify(descriptor, null, 2)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.fabricmc.api.ModInitializer;

public final class ModMindEntry implements ModInitializer {
    public static final String MOD_ID = ${javaString(project.namespace)};

    @Override
    public void onInitialize() {
        System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized");
    }
}
`
  }
  return files
}

function quiltFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const compatibility = loaderBuildCompatibility('quilt', project.minecraftVersion)
  const javaVersion = project.javaVersion ?? compatibility.javaVersion
  const packageInfo = slugPackage(project)
  const properties = [
    ...commonProperties(project, javaVersion),
    `qfapi_version=${propertyValue(project.apiVersion ?? '')}`,
    `qsl_version=${propertyValue(project.qslVersion ?? '')}`
  ]
  const quiltLoader: Record<string, unknown> = {
    group: `dev.modmind.${project.namespace}`,
    id: project.namespace,
    version: '${version}',
    metadata: { name: project.name, description: 'Created with ModMind', license: 'MIT' },
    intermediate_mappings: 'net.fabricmc:intermediary',
    ...(includeStarter ? { entrypoints: { init: [`${packageInfo.name}.ModMindEntry`] } } : {}),
    depends: [
      { id: 'quilt_loader', versions: `>=${project.loaderVersion}` },
      { id: 'minecraft', versions: project.minecraftVersion },
      { id: 'java', versions: `>=${javaVersion}` },
      { id: 'quilted_fabric_api', versions: '*' }
    ]
  }
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement {
    repositories {
        maven { url = 'https://repo.spongepowered.org/maven/' }
        maven { url = 'https://maven.quiltmc.org/repository/release/' }
        maven { url = 'https://maven.fabricmc.net/' }
        gradlePluginPortal()
    }
}

rootProject.name = '${project.namespace}'
`,
    'gradle.properties': `${properties.join('\n')}\n`,
    'build.gradle': `plugins {
    id 'org.quiltmc.loom' version '${compatibility.pluginVersion}'
    id 'maven-publish'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

repositories {
    maven { url = 'https://repo.spongepowered.org/maven/' }
    maven { url = 'https://maven.quiltmc.org/repository/release/' }
    mavenCentral()
}

dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
    mappings loom.officialMojangMappings()
    modImplementation "org.quiltmc:quilt-loader:\${project.loader_version}"
    modImplementation "org.quiltmc.quilted-fabric-api:quilted-fabric-api:\${project.qfapi_version}"
    modImplementation "org.quiltmc:qsl:\${project.qsl_version}"
}

${javaConfiguration(javaVersion)}
processResources {
    filteringCharset = 'UTF-8'
    inputs.property 'version', project.version
    filesMatching('quilt.mod.json') { expand version: project.version }
}
`,
    [descriptorPath('quilt', project.minecraftVersion)]: JSON.stringify({ schema_version: 1, quilt_loader: quiltLoader }, null, 2)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import org.quiltmc.loader.api.ModContainer;
import org.quiltmc.qsl.base.api.entrypoint.ModInitializer;

public final class ModMindEntry implements ModInitializer {
    public static final String MOD_ID = ${javaString(project.namespace)};

    @Override
    public void onInitialize(ModContainer mod) {
        System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized");
    }
}
`
  }
  return files
}

function loaderMajor(loaderVersion: string | undefined): string {
  const segment = (loaderVersion ?? '').split('-').at(-1) ?? ''
  return segment.match(/^\d+/)?.[0] ?? '1'
}

function forgeModToml(project: ProjectInfo): string {
  const major = loaderMajor(project.loaderVersion)
  return `modLoader="javafml"
loaderVersion="[${major},)"
license="MIT"

[[mods]]
modId="${project.namespace}"
version="\${version}"
displayName=${tomlString(project.name)}
description='''Created with ModMind'''

[[dependencies.${project.namespace}]]
modId="forge"
mandatory=true
versionRange="[${major},)"
ordering="NONE"
side="BOTH"

[[dependencies.${project.namespace}]]
modId="minecraft"
mandatory=true
versionRange="[${project.minecraftVersion}]"
ordering="NONE"
side="BOTH"
`
}

function legacyForgeMappings(version: string): string {
  if (compareMinecraftVersions(version, '1.8') < 0) return 'stable_12'
  if (compareMinecraftVersions(version, '1.9') < 0) return version === '1.8' ? 'stable_18' : version === '1.8.9' ? 'stable_20' : 'stable_22'
  if (compareMinecraftVersions(version, '1.10') < 0) return 'stable_24'
  if (compareMinecraftVersions(version, '1.11') < 0) return 'snapshot_20161111'
  if (compareMinecraftVersions(version, '1.12') < 0) return 'snapshot_20161220'
  return 'snapshot_20171003'
}

function forge1122Files(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const compatibility = loaderBuildCompatibility('forge', project.minecraftVersion)
  const packageInfo = slugPackage(project)
  const descriptor = JSON.stringify([{
    modid: project.namespace,
    name: project.name,
    description: 'Created with ModMind',
    version: '${version}',
    mcversion: '1.12.2',
    authorList: ['ModMind']
  }], null, 2)
  const files: Record<string, string> = {
    'settings.gradle': `rootProject.name = '${project.namespace}'\n`,
    'gradle.properties': `${commonProperties(project, 8).join('\n')}\norg.gradle.daemon=false\n`,
    'build.gradle': `buildscript {
    repositories {
        maven { url = 'https://maven.minecraftforge.net/' }
        mavenCentral()
    }
    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:${compatibility.pluginVersion}' }
}

apply plugin: 'net.minecraftforge.gradle'

version = project.mod_version
group = project.maven_group
archivesBaseName = project.archives_base_name
sourceCompatibility = targetCompatibility = compileJava.sourceCompatibility = compileJava.targetCompatibility = '1.8'

minecraft {
    mappings channel: 'snapshot', version: '20171003-1.12'
    runs {
        client { workingDirectory project.file('run') }
        server { workingDirectory project.file('run-server'); args '--nogui' }
    }
}

dependencies { minecraft "net.minecraftforge:forge:\${project.loader_version}" }
tasks.withType(JavaCompile) { options.encoding = 'UTF-8' }

processResources {
    inputs.property 'version', project.version
    inputs.property 'mcversion', project.minecraft_version
    from(sourceSets.main.resources.srcDirs) {
        include 'mcmod.info'
        expand version: project.version, mcversion: project.minecraft_version
    }
    from(sourceSets.main.resources.srcDirs) { exclude 'mcmod.info' }
}

jar.finalizedBy('reobfJar')
`,
    'src/main/resources/mcmod.info': descriptor,
    'src/main/resources/pack.mcmeta': JSON.stringify({ pack: { description: `${project.name} resources`, pack_format: 3 } }, null, 2)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.minecraftforge.fml.common.Mod;

@Mod(modid = ModMindEntry.MOD_ID, name = ${javaString(project.name)}, version = "0.1.0")
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};
    public ModMindEntry() { System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized"); }
}
`
  }
  return files
}

function legacyForgeFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  if (project.minecraftVersion === '1.12.2') return forge1122Files(project, includeStarter)
  const compatibility = loaderBuildCompatibility('forge', project.minecraftVersion)
  const packageInfo = slugPackage(project)
  const pre18 = compareMinecraftVersions(project.minecraftVersion, '1.8') < 0
  const annotationPackage = pre18 ? 'cpw.mods.fml.common.Mod' : 'net.minecraftforge.fml.common.Mod'
  const annotation = pre18
    ? `@Mod(modid = ModMindEntry.MOD_ID, name = ${javaString(project.name)}, version = "0.1.0")`
    : `@Mod(modid = ModMindEntry.MOD_ID, name = ${javaString(project.name)}, version = "0.1.0")`
  const descriptor = JSON.stringify([{
    modid: project.namespace,
    name: project.name,
    description: 'Created with ModMind',
    version: '${version}',
    mcversion: project.minecraftVersion,
    authorList: ['ModMind']
  }], null, 2)
  const retiredMojangDownloadOverride = project.minecraftVersion === '1.7.10' ? `
afterEvaluate {
    tasks.downloadClient.url = new net.minecraftforge.gradle.delayed.DelayedString(project, 'https://launcher.mojang.com/v1/objects/e80d9b3bf5085002218d4be59e668bac718abbc6/client.jar')
    tasks.downloadServer.url = new net.minecraftforge.gradle.delayed.DelayedString(project, 'https://launcher.mojang.com/v1/objects/952438ac4e01b4d115c5fc38f891710c4941df29/server.jar')
}
` : ''
  const files: Record<string, string> = {
    'settings.gradle': `rootProject.name = '${project.namespace}'\n`,
    'gradle.properties': `${commonProperties(project, 8).join('\n')}\n`,
    'build.gradle': `buildscript {
    repositories {
        mavenCentral()
        maven { name = 'forge'; url = 'https://maven.minecraftforge.net/' }
        maven { name = 'sonatype'; url = 'https://oss.sonatype.org/content/repositories/snapshots/' }
    }
    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:${compatibility.pluginVersion}' }
}

apply plugin: '${pre18 ? 'forge' : 'net.minecraftforge.gradle.forge'}'

version = project.mod_version
group = project.maven_group
archivesBaseName = project.archives_base_name
sourceCompatibility = targetCompatibility = '1.8'

minecraft {
    version = project.loader_version
    runDir = 'run'
    mappings = '${legacyForgeMappings(project.minecraftVersion)}'
}
${retiredMojangDownloadOverride}

tasks.withType(JavaCompile) { options.encoding = 'UTF-8' }

processResources {
    inputs.property 'version', project.version
    inputs.property 'mcversion', project.minecraft_version
    from(sourceSets.main.resources.srcDirs) {
        include 'mcmod.info'
        expand version: project.version, mcversion: project.minecraft_version
    }
    from(sourceSets.main.resources.srcDirs) { exclude 'mcmod.info' }
}
`,
    'src/main/resources/mcmod.info': descriptor,
    'src/main/resources/pack.mcmeta': JSON.stringify({ pack: { description: `${project.name} resources`, pack_format: 1 } }, null, 2)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import ${annotationPackage};

${annotation}
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};

    public ModMindEntry() {
        System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized");
    }
}
`
  }
  return files
}

function intermediateForgeFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const compatibility = loaderBuildCompatibility('forge', project.minecraftVersion)
  const javaVersion = project.javaVersion ?? compatibility.javaVersion
  const packageInfo = slugPackage(project)
  const descriptor = descriptorPath('forge', project.minecraftVersion)
  const mapping = compareMinecraftVersions(project.minecraftVersion, '1.14.4') >= 0
    ? `mappings channel: 'official', version: project.minecraft_version`
    : `mappings channel: 'snapshot', version: '20190213-1.13.2'`
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement { repositories { gradlePluginPortal(); maven { url = 'https://maven.minecraftforge.net/' } } }\nrootProject.name = '${project.namespace}'\n`,
    'gradle.properties': `${commonProperties(project, javaVersion).join('\n')}\n`,
    'build.gradle': `buildscript {
    repositories { maven { url = 'https://maven.minecraftforge.net/' }; mavenCentral(); gradlePluginPortal() }
    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:${compatibility.pluginVersion}' }
}

apply plugin: 'java'
apply plugin: 'net.minecraftforge.gradle'

version = project.mod_version
group = project.maven_group
archivesBaseName = project.archives_base_name
sourceCompatibility = targetCompatibility = '${javaVersion}'

minecraft {
    ${mapping}
    runs {
        client { workingDirectory project.file('run') }
        server { workingDirectory project.file('run-server'); args '--nogui' }
    }
}

repositories { mavenCentral() }
dependencies { minecraft "net.minecraftforge:forge:\${project.loader_version}" }
tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }

processResources {
    inputs.property 'version', project.version
    filesMatching('META-INF/mods.toml') { expand version: project.version }
}
`,
    [descriptor]: forgeModToml(project)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.minecraftforge.fml.common.Mod;

@Mod(ModMindEntry.MOD_ID)
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};
    public ModMindEntry() { System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized"); }
}
`
  }
  return files
}

function forgeFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  if (compareMinecraftVersions(project.minecraftVersion, '1.13') < 0) return legacyForgeFiles(project, includeStarter)
  if (compareMinecraftVersions(project.minecraftVersion, '1.18') < 0) return intermediateForgeFiles(project, includeStarter)
  const compatibility = loaderBuildCompatibility('forge', project.minecraftVersion)
  const javaVersion = project.javaVersion ?? compatibility.javaVersion
  const packageInfo = slugPackage(project)
  const forgeGradle7 = compatibility.pluginVersion.startsWith('7.')
  const runs = forgeGradle7
    ? `        configureEach {
            workingDir = layout.projectDirectory.dir('run')
            systemProperty 'forge.enabledGameTestNamespaces', '${project.namespace}'
        }
        register('client')
        register('server') { args '--nogui' }
        register('gameTestServer')`
    : `        client { workingDirectory project.file('run') }
        server {
            workingDirectory project.file('run-server')
            args '--nogui'
        }
        gameTestServer {
            workingDirectory project.file('run-gametest')
            property 'forge.enabledGameTestNamespaces', '${project.namespace}'
        }`
  const repositories = forgeGradle7
    ? `repositories {
    minecraft.mavenizer(it)
    maven fg.forgeMaven
    maven fg.minecraftLibsMaven
    mavenCentral()
}`
    : 'repositories { mavenCentral() }'
  const dependency = forgeGradle7
    ? `    implementation minecraft.dependency("net.minecraftforge:forge:\${project.loader_version}")`
    : `    minecraft "net.minecraftforge:forge:\${project.loader_version}"`
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = 'https://maven.minecraftforge.net/' }
    }
}

rootProject.name = '${project.namespace}'
`,
    'gradle.properties': `${commonProperties(project, javaVersion).join('\n')}\n`,
    'build.gradle': `plugins {
    id 'java'
    id 'net.minecraftforge.gradle' version '${compatibility.pluginVersion}'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

${javaConfiguration(javaVersion)}
minecraft {
    mappings channel: 'official', version: project.minecraft_version
    runs {
${runs}
    }
}

${repositories}

dependencies {
${dependency}
}

processResources {
    filteringCharset = 'UTF-8'
    inputs.property 'version', project.version
    filesMatching('META-INF/mods.toml') { expand version: project.version }
}
`,
    [descriptorPath('forge', project.minecraftVersion)]: forgeModToml(project)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.minecraftforge.fml.common.Mod;

@Mod(ModMindEntry.MOD_ID)
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};

    public ModMindEntry() {
        System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized");
    }
}
`
  }
  return files
}

function neoForgeModToml(project: ProjectInfo): string {
  const modern = compareMinecraftVersions(project.minecraftVersion, '1.20.5') >= 0
  const header = modern ? 'license="MIT"' : 'modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"'
  const required = modern ? 'type="required"' : 'mandatory=true'
  return `${header}

[[mods]]
modId="${project.namespace}"
version="\${version}"
displayName=${tomlString(project.name)}
description='''Created with ModMind'''

[[dependencies.${project.namespace}]]
modId="neoforge"
${required}
versionRange="[${project.loaderVersion},)"
ordering="NONE"
side="BOTH"

[[dependencies.${project.namespace}]]
modId="minecraft"
${required}
versionRange="[${project.minecraftVersion}]"
ordering="NONE"
side="BOTH"
`
}

function neoGradleFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  const compatibility = loaderBuildCompatibility('neoforge', project.minecraftVersion)
  const packageInfo = slugPackage(project)
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement { repositories { gradlePluginPortal(); maven { url = 'https://maven.neoforged.net/releases' } } }\nrootProject.name = '${project.namespace}'\n`,
    'gradle.properties': `${commonProperties(project, 17).join('\n')}\nneo_version=${propertyValue(project.loaderVersion ?? '')}\n`,
    'build.gradle': `plugins {
    id 'java-library'
    id 'net.neoforged.gradle.userdev' version '${compatibility.pluginVersion}'
}

version = project.mod_version
group = project.maven_group
base { archivesName = project.archives_base_name }
${javaConfiguration(17)}

runs {
    configureEach { modSource project.sourceSets.main }
    client { systemProperty 'forge.enabledGameTestNamespaces', project.mod_id }
    server { systemProperty 'forge.enabledGameTestNamespaces', project.mod_id; programArgument '--nogui' }
    gameTestServer { systemProperty 'forge.enabledGameTestNamespaces', project.mod_id }
}

dependencies { implementation "net.neoforged:neoforge:\${project.neo_version}" }

processResources {
    inputs.property 'version', project.version
    filesMatching('META-INF/mods.toml') { expand version: project.version }
}
`,
    [descriptorPath('neoforge', project.minecraftVersion)]: neoForgeModToml(project)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.neoforged.fml.common.Mod;

@Mod(ModMindEntry.MOD_ID)
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};
    public ModMindEntry() { System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized"); }
}
`
  }
  return files
}

function neoForgeFiles(project: ProjectInfo, includeStarter: boolean): Record<string, string> {
  if (compareMinecraftVersions(project.minecraftVersion, '1.20.4') < 0) return neoGradleFiles(project, includeStarter)
  const compatibility = loaderBuildCompatibility('neoforge', project.minecraftVersion)
  const javaVersion = project.javaVersion ?? compatibility.javaVersion
  const packageInfo = slugPackage(project)
  const descriptor = descriptorPath('neoforge', project.minecraftVersion)
  const files: Record<string, string> = {
    'settings.gradle': `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
    }
}

rootProject.name = '${project.namespace}'
`,
    'gradle.properties': `${commonProperties(project, javaVersion).join('\n')}\nneo_version=${propertyValue(project.loaderVersion ?? '')}\n`,
    'build.gradle': `plugins {
    id 'java-library'
    id 'maven-publish'
    id 'net.neoforged.moddev' version '${compatibility.pluginVersion}'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

${javaConfiguration(javaVersion)}
neoForge {
    version = project.neo_version
    runs {
        client { client() }
        server {
            server()
            programArgument '--nogui'
        }
        gameTestServer {
            type = 'gameTestServer'
            systemProperty 'neoforge.enabledGameTestNamespaces', '${project.namespace}'
        }
    }
    mods {
        "${project.namespace}" { sourceSet(sourceSets.main) }
    }
}

processResources {
    filteringCharset = 'UTF-8'
    inputs.property 'version', project.version
    filesMatching('${descriptor.replace('src/main/resources/', '')}') { expand version: project.version }
}

tasks.configureEach {
    if (name in ['runClient', 'runServer', 'runGameTestServer']) {
        dependsOn 'processResources', 'classes'
    }
}
`,
    [descriptor]: neoForgeModToml(project)
  }
  if (includeStarter) {
    files[`src/main/java/${packageInfo.path}/ModMindEntry.java`] = `package ${packageInfo.name};

import net.neoforged.fml.common.Mod;

@Mod(ModMindEntry.MOD_ID)
public final class ModMindEntry {
    public static final String MOD_ID = ${javaString(project.namespace)};

    public ModMindEntry() {
        System.out.println("[ModMind] " + ${javaString(project.name)} + " initialized");
    }
}
`
  }
  return files
}

function mitLicense(project: ProjectInfo): string {
  return `MIT License

Copyright (c) ${new Date(project.createdAt || Date.now()).getUTCFullYear()} ${project.name}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}

export function projectTemplateFiles(project: ProjectInfo, includeStarter = true): Record<string, string> {
  if (project.kind === 'server-plugin') return pluginTemplateFiles(project, includeStarter)
  // Keep template generation safe even when called with legacy or externally loaded metadata.
  project = { ...project, name: normalizeProjectName(project.name) }
  assertProjectCreationSupported(project.loader, project.minecraftVersion)
  if (project.loader === 'bedrock') return bedrockTemplateFiles(project, includeStarter)
  if (project.loader === 'netease-pc' || project.loader === 'netease-mobile') return neteaseTemplateFiles(project, includeStarter)
  if (!isJavaLoader(project.loader)) throw new Error(`Unsupported project platform: ${project.loader}`)
  const compatibility = loaderBuildCompatibility(project.loader, project.minecraftVersion)
  const files = project.loader === 'fabric'
    ? fabricFiles(project, includeStarter)
    : project.loader === 'quilt' ? quiltFiles(project, includeStarter)
      : project.loader === 'forge' ? forgeFiles(project, includeStarter) : neoForgeFiles(project, includeStarter)
  return {
    'modmind.project.json': JSON.stringify({ ...project, projectVersion: CURRENT_PROJECT_VERSION }, null, 2),
    'modmind.template.json': JSON.stringify({
      source: officialTemplateSources[project.loader],
      loader: project.loader,
      minecraftVersion: project.minecraftVersion,
      pluginVersion: compatibility.pluginVersion,
      gradleVersion: compatibility.gradleVersion,
      projectVersion: CURRENT_PROJECT_VERSION,
      generatedAt: project.createdAt
    }, null, 2),
    ...files,
    'gradle/wrapper/gradle-wrapper.properties': gradleWrapperProperties(project),
    '.gitignore': '.gradle/\nbuild/\nrun/\nrun-*/\nlogs/\n.modmind/\n',
    '.gitattributes': 'gradlew text eol=lf\n*.bat text eol=crlf\n*.jar binary\n',
    'LICENSE': mitLicense(project),
    'README.md': `# ${project.name}\n\nMinecraft ${project.minecraftVersion} / ${project.loader}\n\nBuild with \`./gradlew build\` (Windows: \`.\\gradlew.bat build\`).\n\nThis project was created with ModMind from the official ${project.loader} template structure.\n`,
    ...(includeStarter ? { 'docs/idea.md': '# Mod idea\n\nDescribe the feature in ModMind to keep the generated specification here.\n' } : {})
  }
}
