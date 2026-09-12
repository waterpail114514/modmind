export function isGradleMavenDependencyFailure(logText: string): boolean {
  return /Could not (?:download [^\r\n]*\.jar|get resource ['"]https?:\/\/[^'"]+['"])/i.test(logText)
}

export function isForgeJavaProvisioningFailure(logText: string): boolean {
  return /(?:failed to provision jdk|java_provisioner|disco(?:locator| cache)|missing executable:[^\r\n]*(?:mavenizer|forgegradle))/i.test(logText)
}

export function isGradleDistributionFailure(logText: string): boolean {
  if (/Downloading\s+https?:\/\/[^\s]*gradle-[^\s]+\.zip/i.test(logText) && /org\.gradle\.wrapper\.(?:Install|GradleWrapperMain)/.test(logText)) return true
  return /(?:Could not (?:GET|HEAD) ['"]?https?:\/\/[^\s'"]*(?:gradle-[^\s'"]*\.zip|services\.gradle\.org)|Could not (?:download|install) [^\r\n]*(?:gradle-[^\r\n]*\.zip|Gradle distribution)|distributionUrl=.*gradle-[^\s]+\.zip)/i.test(logText)
}

export function isGradleNetworkFailure(logText: string): boolean {
  if (isGradleMavenDependencyFailure(logText) || isForgeJavaProvisioningFailure(logText)) return false
  return isGradleDistributionFailure(logText) && /(?:java\.net\.|Connection timed out|connection reset|timeout|unknown host|could not (?:get|head|download|install))/i.test(logText)
}

export function isGradleDistributionLockFailure(logText: string): boolean {
  return /Timeout of \d+ reached waiting for exclusive access to file:[^\r\n]*wrapper[\\/]dists[\\/][^\r\n]*gradle-[^\r\n]*-bin\.zip/i.test(logText)
}

export function isGradleWrapperBootstrapFailure(logText: string): boolean {
  return isGradleNetworkFailure(logText) || isGradleDistributionLockFailure(logText)
}
