# 第三方组件与许可（mc-preview）

本包**不包含**承包方（ModMind 1.5.0 交接包）的任何代码，因此**不含 AGPL 文本**。
界面复用**宿主提供的 React**（不另带 React 副本）；包内只有下面两个 MIT 组件。

（为什么补这份：此前包里放的是**承包方那份 AGPL-3.0 全文**（与本包内容无关），
而真正的 MIT 署名又被 esbuild 的 `legalComments:'none'` 剥掉了 —— 属于"放了不该放的、缺了该有的"。
现已改为：`legalComments:'eof'` 保留上游法律注释 + 本文件附许可原文。）

---

## deepslate

- 包内路径：`renderer.js`（与 `preview/vendor/deepslate.umd.cjs` 同源，版本 0.27.2）
- 上游：https://github.com/misode/deepslate
- 许可：MIT，Copyright (c) 2021 Misode

```
MIT License
Copyright (c) 2021 Misode

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
```

---

## gl-matrix

- 包内路径：`renderer.js`（与 `preview/vendor/gl-matrix.js` 同源，版本 3.4.4）
- 上游：https://github.com/toji/gl-matrix
- 许可：MIT，Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV

```
Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 数据与游戏资源（不在本包内）

`items.json` / `icons/` / 图集等**不进这个包**（体积原因），由「游戏数据采集」功能包按需从**用户本地实例**产出，
或随独立网页应用（`app/data/`）分发。贴图与模型来自用户本机安装的 Minecraft 与 Mod；
Minecraft 内容版权属 Mojang / Microsoft，本包不授予游戏授权，也不含可启动的客户端。
公开分发前须自行核对相应资源的使用与再分发条款。
