# Ether Studio Remote — Android TWA 壳

把 `https://ether-studio.top/`（远程控制网页端）包装成安卓 App 的 Trusted Web Activity
壳。App 内运行的就是网站本身：网页更新即时生效，壳本身几乎没有日常维护成本。

**这个目录完全独立于 Electron 桌面应用。** 它不参与 `npm run build`，也不会被打进
安装包（`package.json` 的 `build.files` 已显式排除 `!android-twa/**`）。

## 一次性准备

1. 生成签名密钥（密钥即 App 身份，**永久保存，丢了就无法再更新 App**）：

   ```bash
   bash scripts/create-keystore.sh
   ```

   生成 `etherstudio-release.keystore` 和 `keystore.properties`（两者均已 git-ignore）。

2. 打印签名指纹并发给网页端同学部署 `assetlinks.json`（见
   `docs/remote-web-requirements.md` 需求 2）：

   ```bash
   keytool -list -v -keystore etherstudio-release.keystore -alias etherstudio | grep SHA256:
   ```

3. 把指纹填进 `app/src/main/res/values/strings.xml` 的
   `SHA256_FINGERPRINT_REPLACE_ME`（冒号分隔的大写十六进制原样粘贴即可）。

## 本地出包

需要 JDK 17 和 Android SDK（或直接用 CI）。首次构建 Gradle 会自动下载依赖。

```bash
cd android-twa
./gradlew assembleRelease          # APK，用于官网直接分发
./gradlew bundleRelease            # AAB，用于 Google Play
```

产物在 `app/build/outputs/apk/release/` 与 `app/build/outputs/bundle/release/`。

发版改版本号时不要动 `app/build.gradle`，用参数覆盖：

```bash
./gradlew assembleRelease -PversionName=1.0.1 -PversionCode=2
```

`versionCode` 必须每次发版递增。

## CI 出包

`.github/workflows/twa-build.yml`（手动触发）可产出同样的 APK/AAB，需要先配置
4 个仓库 Secret：

| Secret | 内容 |
| --- | --- |
| `TWA_KEYSTORE_BASE64` | keystore 文件的 base64（`base64 -w0 etherstudio-release.keystore`） |
| `TWA_KEYSTORE_PASSWORD` | keystore 口令 |
| `TWA_KEY_ALIAS` | `etherstudio` |
| `TWA_KEY_PASSWORD` | key 口令 |

## 图标与闪屏

全部由仓库根目录的 `logo.svg` 导出 `logo.png` 后，通过 `sharp` 生成（自适应图标前景按安全区 66% 缩放）。换 logo 后
在仓库根目录执行 `npm run assets:icons`，即可同步桌面、安装器、macOS 和 Android 图标。

## 对站点的前置要求

见 `../docs/remote-web-requirements.md`。核心两条：站点提供 PWA manifest、部署
`.well-known/assetlinks.json`。manifest 未就绪时 App 仍可构建运行，只是会有地址栏；
assetlinks 指纹不匹配同样会显示地址栏。
