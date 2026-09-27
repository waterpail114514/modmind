# ModMind 宣传片 / 第二版

成片：`output/modmind-promo-1080p.mp4`。1920 × 1080，30 fps，无声，2215 帧，73.833 秒。

```powershell
node prototypes/promo-studio/server.mjs
```

- 预览：http://127.0.0.1:4178
- 同步逐帧对照：http://127.0.0.1:4178/compare.html
- 四张用户截图对照：`analysis/compare-1.png` 至 `compare-4.png`（左原片，右本版）。

## 后续改片

- `config.js`：品牌、颜色、文案。
- `timeline.js`：41 段时间轴，使用原片帧号。
- `renderer.js`：逐帧渲染，笔画蒙版、Logo 粒子、界面与镜头。
- `projection.js`：WebGL 单应投影。
- `assets/camera-tracks.json`：原片特征点匹配获得的四角坐标。
- `assets/logo-original.png`：用户提供的完整 Logo。
- `assets/wordmark.png`：同一 Logo 的字标裁切，供粒子镜头使用。

```powershell
node prototypes/promo-studio/render.mjs
node prototypes/promo-studio/compare.mjs
```

依赖使用主项目现有 Playwright / Chromium / ffmpeg-static。分析脚本使用 Python、OpenCV、NumPy。无编辑器，保留源文件供后期改片。

## 验证范围与差异

四张参考图自动匹配至 37、453、557、1657 帧。欢迎界面等部分镜头采用 SIFT 特征点和 RANSAC 单应矩阵逐帧追踪；低置信度和退化矩阵已过滤。缺失帧及设备段使用人工关键帧，目前没有实现全片每一帧角度、曲线、景深、粒子一致。第二版仍是待校准工作版，不能宣称完美复刻。

内容顺序为整合包自动构建 → 模组创作 → All in One；各主要卖点不再反复用标题介绍。演示界面是宣传用途的重绘，不是真实产品运行录像。仓库有整合包隔离启动测试记录，但没有竞品独占性证据，因此未使用“市面唯一”。

参考：https://www.bilibili.com/video/BV126aPzWEpp/ 。本地参考和抽帧仅用于对照，不进入成片。

汉字笔画数据：hanzi-writer-data 2.0.1（来源 Make Me a Hanzi，Arphic Public License；项目工具部分 MIT）。数据来自 npm/jsDelivr。渲染用数据中的笔画中线将系统无衬线字形分配为笔画蒙版，保留现代字体外观。见 `assets/STROKES-NOTICE.md`。
