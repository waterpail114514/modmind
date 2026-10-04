export function isGradleMavenDependencyFailure(logText: string): boolean {
  return /Could not (?:download [^\r\n]*\.jar|get resource ['"]https?:\/\/[^'"]+['"])/i.test(logText)
}

export function isForgeJavaProvisioningFailure(logText: string): boolean {
  return /(?:failed to provision jdk|java_provisioner|disco(?:locator| cache)|missing executable:[^\r\n]*(?:mavenizer|forgegradle))/i.test(logText)
}

export function isGradleJavaToolchainFailure(logText: string): boolean {
  return /(?:cannot find a java installation[^\r\n]*(?:languageversion|java version)|no locally installed toolchains match|failed to calculate the value of task ['"]?:?[^\r\n]*javaCompiler)/i.test(logText)
}

export function isGradleDistributionFailure(logText: string): boolean {
  if (isGradleJavaToolchainFailure(logText)) return false
  if (/Downloading\s+https?:\/\/[^\s]*gradle-[^\s]+\.zip/i.test(logText) && /org\.gradle\.wrapper\.Install\./.test(logText)) return true
  return /(?:Could not (?:GET|HEAD) ['"]?https?:\/\/[^\s'"]*(?:gradle-[^\s'"]*\.zip|services\.gradle\.org)|Could not (?:download|install) [^\r\n]*(?:gradle-[^\r\n]*\.zip|Gradle distribution))/i.test(logText)
}

export function isGradleBuildStarted(logText: string): boolean {
  return isGradleJavaToolchainFailure(logText) || /(?:^> Task :|BUILD (?:SUCCESSFUL|FAILED)|To honour the JVM settings for this build|Starting a Gradle Daemon|Daemon will be stopped at the end of the build|FAILURE: Build failed with an exception\.)/im.test(logText)
}

export function isGradleNetworkFailure(logText: string): boolean {
  if (isGradleMavenDependencyFailure(logText) || isForgeJavaProvisioningFailure(logText) || isGradleJavaToolchainFailure(logText)) return false
  return isGradleDistributionFailure(logText) && /(?:java\.net\.|Connection timed out|connection reset|timeout|unknown host|could not (?:get|head|download|install))/i.test(logText)
}

export function isGradleDistributionLockFailure(logText: string): boolean {
  return /Timeout of \d+ reached waiting for exclusive access to file:[^\r\n]*wrapper[\\/]dists[\\/][^\r\n]*gradle-[^\r\n]*-bin\.zip/i.test(logText)
}

export function isGradleWrapperBootstrapFailure(logText: string): boolean {
  return isGradleNetworkFailure(logText) || isGradleDistributionLockFailure(logText)
}
