# 窗外森林渲染修复报告：树木"悬空"与玻璃方框残影

- 日期：2026-09-30
- 影响范围：只影响透过天窗看到的窗外画面。室内画面前后逐像素对比，玻璃以外区域的平均差 < 0.08 / 255
- 涉及文件：`src/scene.js`、`src/rain-system.js`（源码在 `source` 分支；`main` 分支是 GitHub Pages 发布的构建产物）

## 概要

| # | 现象 | 根因 | 修复 |
|---|------|------|------|
| 1 | 透过天窗往下看，树不像长在地上 | 两盏平行光（深夜冷光、清晨太阳）的阴影相机只覆盖木屋周围约 17 m，树在 8–36 m 外。树影靠近树干的一段落在阴影相机范围外被裁掉，影子要离树根几米才出现，顶边是一条直线 | 窗外层（layer 1）改用覆盖整片森林的"孪生"平行光，室内仍用原来的紧凑阴影 |
| 2 | 玻璃上有方框、竖线、台阶状暗线 | SSAO 的法线/深度通道会透过天窗看到森林。它用的覆盖材质忽略了树叶贴图的镂空，每棵树都成了实心竖板，板子轮廓被算成暗线叠到玻璃上 | 窗外物体不参与 SSAO |

修复 1 的第一版会让木屋本身不再往窗外地面投影，最终版已补上，见 3.5 节。

## 1. 现象

用户在两个时段反馈了"透过窗户往下看外面，树不是长在地上"：

![反馈截图 1](images/2026-09-30/01-report-screenshot-1.jpg)

![反馈截图 2：修复 1 之后仍然"怪怪的"](images/2026-09-30/02-report-screenshot-2.jpg)

第二张截图是修复 1 上线后拍的。玻璃上成片的方框、竖线和台阶状折线仍在，这就是问题 2。

## 2. 渲染结构与排查方法

### 2.1 相关的渲染结构

- 主相机只看 layer 0，渲染室内。天窗玻璃是自定义着色器，它把窗外画面当作背景贴图 `refractionTarget` 来采样。
- 窗外画面由 `RainSystem.renderCaptures()` 里的 `backgroundCamera` 单独渲染。它只看 layer 1，内容是天空、树、地面、雾、雨，使用单独的 `exteriorFog`。
- 灯光和阴影都按相机的 layer 过滤（three.js r180）：
  - `WebGLRenderer.projectObject` 只收集 `light.layers.test(camera.layers)` 通过的灯光，阴影列表也一样。
  - `WebGLShadowMap.renderObject` 用当前渲染相机的 layers 过滤投影物体。
  - `renderer.shadowMap.autoUpdate = false`，每次 `render()` 结束后 `needsUpdate` 会被清掉。
- 最终合成顺序是 RenderPass → SSAOPass → SunlightPass → UnrealBloomPass → OutputPass。

### 2.2 复现手段

- 调试构建：在源码副本里暴露 `window.__dbg`（相机、场景、合成器等），并支持 URL 参数 `cam=px,py,pz,tx,ty,tz`、`fov=`、`extonly`。正式源码不带这些钩子。
- 截图：用 headless Chrome 走 DevTools 协议（`Page.captureScreenshot`）。桌面应用内置浏览器面板隐藏时，截图不会刷新，结果不可信，所以没用它。
- 看中间结果：
  - 在帧末把 `refractionTarget` 直接画到屏幕上，看窗外层本身；
  - 设 `SSAOPass.output = 1`，看 SSAO 缓冲；
  - 把 `reflectionMap`、`heightMap`、`clearedMap` 换成 1×1 黑色贴图，逐项关掉玻璃着色器的输入。
- 固定机位：
  - `cam=1.5,6.6,1.2,-3.5,2.4,-6.5&fov=50`：从屋内高处透过天窗看向后下方；
  - `cam=0.4,5.0,-1.5,-1.1,-0.6,-12.1&fov=45`：对准一棵近处的树根。

## 3. 问题 1：树影与树根脱开

### 3.1 先排除树的摆放

- 所有树组的 `y = -0.6`，地面平面在 `y = -0.7`，树干底端比地面高 10 cm。
- 把每棵树的根部坐标投影到屏幕上，和渲染结果对照。例如 14 号树位于 (-8.5, -0.6, -19)，投影到 (686, 270)，渲染图里它的树干正好在这里结束。
- 结论：摆放是对的。10 cm 在正常视距下约 0.3°，看不出来。

### 3.2 根因

| 光源 | 阴影相机范围 | 中心 | 贴图 |
|------|------|------|------|
| 冷光（深夜主光，强度 2.1） | left/right ±8，top 9，bottom −8 | 原点，光源在 (−2, 12, −9) | 2048² |
| 太阳（清晨） | ±9 | (0.3, 0.5, −0.5) | 2048² |

阴影相机范围之外的点一律当作受光。树冠在光空间里能投进这个范围，但树干附近的地面在范围外。结果地面上只剩范围内的那一段影子：它和树根之间隔着一段亮地，靠树一侧是一条直线。深夜冷光最强，所以最明显。

### 3.3 验证根因

临时把两个阴影相机都放大到 ±45 m，所有影子都从树根开始了：

![阴影范围实验](images/2026-09-30/04-shadow-frustum-experiment.jpg)

### 3.4 为什么不直接放大原有阴影

窗框金属条宽 9 cm。现在 2048² 贴图覆盖约 18 m，每个像素约 0.9 cm，窗框投在床上的光斑边缘很清楚。如果覆盖整片森林（约 70 m），每个像素约 3.4 cm，室内光斑会明显变糊。所以室内和窗外分开处理。

### 3.5 修复

`scene.js` 新增 `buildExteriorShadows()`：

- 原来的冷光和太阳执行 `layers.disable(1)`，只照室内；
- 各建一盏只在 layer 1 的孪生平行光，只照窗外。孪生光方向与原光相同，目标点在 (0, 0, −8)，距离 70 m；
- 阴影相机取 `left −36 / right 32 / top 36 / bottom −28 / near 20 / far 100`。这是把树木分布范围（x ∈ [−24.5, 24.5]，z ∈ [−36, 13]，高度到 20 m）按两种光的方向投到光空间后算出的包围盒；
- 贴图桌面 2048²，手机 1024²，每个像素约 3.3 cm。`bias −0.0005`、`normalBias 0.12`，按更大的像素尺寸放宽；
- 每帧把颜色和强度从原光同步过来。原光 `shadow.needsUpdate` 置位时，孪生光也一起置位。

`rain-system.js` 的 `renderCaptures()` 负责刷新阴影：

- 原逻辑在 `shadowMap.needsUpdate` 时先用主相机渲一遍，目的是用室内物体刷新阴影贴图；
- 孪生光只在 layer 1 上，主相机看不到它，它的阴影贴图不会被刷新；
- 第一版的做法是在窗外那次渲染前恢复刷新标记。但那次渲染只看 layer 1，木屋（layer 0）不会画进孪生光的阴影贴图，窗外地面上木屋自己的影子就没了；
- 最终版改成用一台同时看 layer 0 和 layer 1 的 `shadowCamera` 做这次刷新渲染。所有阴影贴图（室内光和孪生光）都用全部投影物体一起刷新，木屋的影子回来了。这次渲染的输出会被随后的窗外渲染完整覆盖，不影响画面。

![木屋影子退化与修复](images/2026-09-30/05-cabin-shadow-regression.jpg)

修复前后：

![树影修复前后](images/2026-09-30/03-tree-shadow-before-after.jpg)

## 4. 问题 2：玻璃上的方框与台阶状暗线

### 4.1 一次错误判断

第一轮排查时，我没做验证就把这些线条归为"室内陈设在玻璃上的反光"。用户第二次反馈后逐项排除，才发现这个判断是错的。这里记录下来，作为"下结论前先复现"的反例。

### 4.2 逐项排除

同一机位（清晨中雨），画面做了对比度增强：

| 条件 | 线条 |
|------|------|
| A 正常 | 有 |
| B `reflectionMap` 换成黑色贴图（关掉反射） | 有 |
| C `heightMap` 和 `clearedMap` 换成黑色贴图（关掉水珠、水痕、擦雾） | 有 |
| D 只看 `refractionTarget`（窗外背景图） | 无 |
| E 禁用 SSAOPass | 无 |

![逐项排除](images/2026-09-30/06-ghost-line-elimination.jpg)

窗外背景图里没有线条，禁用 SSAO 后线条消失，说明线条是合成阶段由 SSAO 加上去的。

### 4.3 根因

- SSAO 的法线/深度通道经过 `renderOpaque()`，玻璃和透明物体会被隐藏，所以 SSAO 能透过天窗看到窗外物体。
- `SSAOPass` 用 `scene.overrideMaterial = MeshNormalMaterial` 渲染，不认贴图和 `alphaTest`。每棵树由 3 张交叉的平面组成，宽 0.47 倍树高、高 1 倍树高，在 SSAO 眼里都是实心长方形。
- SSAO 把这些长方形的轮廓和交叉线算成遮蔽暗线，再乘到最终画面上，玻璃像素也包括在内。

SSAO 缓冲图可以直接看到"一排实心竖板"：

![SSAO 缓冲修复前后](images/2026-09-30/08-ssao-buffer-before-after.jpg)

### 4.4 修复

- `scene.js` 初始化时，把所有启用了 layer 1 的网格加入 `ambientOcclusionExcluded`，SSAO 渲染期间把它们隐藏。
- 窗外只通过玻璃自己的背景图显示，本来就不需要室内的环境光遮蔽。
- 隐藏后，玻璃区域的深度为背景值 1.0，three.js 的 `SSAOShader` 对背景直接输出 1.0（源码注释："don't influence background"），不再压暗。
- SunlightPass 也复用这份深度（桌面复用 SSAO 深度，手机走 `renderOpaque`）。它的光线步进被限制在房间包围盒和屋顶平面内，窗外深度不影响结果。下面的室内对比也验证了这一点。

![玻璃残影修复前后](images/2026-09-30/07-glass-ghost-lines-before-after.jpg)

## 5. 验证

- 室内回归：默认"环顾小屋"机位，修复前后逐像素对比（0–255 灰度差的平均值）：

  | 场景 | 玻璃以外 | 玻璃区域 |
  |------|---------|---------|
  | 清晨小雨 | 0.079 | 0.31 |
  | 深夜中雨 | 0.059 | 1.0 |

  玻璃区域的差异来自去掉的暗线、新接上的树影，以及雨丝动画的随机性。窗框光斑、体积光、室内环境光遮蔽都不变。

  ![室内不变](images/2026-09-30/09-interior-unchanged.jpg)

- 覆盖场景：深夜雨量 58；清晨雨量 5、20、58、90。
- `npm run check` 通过。正式构建在 headless Chrome 中加载，没有控制台错误或着色器错误。

## 6. 性能与资源

- 新增 2 张阴影贴图：桌面 2048²，手机 1024²。按 RGBA8 颜色加 24 位深度估算，桌面每张约 32 MB 显存（估算值，没有实测）。
- 刷新频率与原光一致：冷光的孪生光只在启动时画一次；太阳的孪生光在晴朗清晨随太阳每 0.65 s 刷新一次。刷新时投影物体主要是 62 棵树的叶片平面。
- SSAO 的法线通道少画了窗外物体，略有减负。

## 7. 遗留与建议

- 树根比地面高 10 cm（`y = -0.6` 对 `-0.7`）。影子接上之后看不出来，这次没改。要彻底消除，可以把树组下沉到 `-0.7`。
- 树仍然是 3 张交叉的平面，地面是纯色平面。近距离俯视仍能看出"纸片感"，可以考虑给树根加接触阴影，给地面加草或落叶细节。
- 窗外画面只包含 layer 1。凡是 layer 0 物体参与的全屏后处理，今后新增时都要注意会不会"透过玻璃"作用到窗外。

## 附录：代码改动

完整 diff 见 `source` 分支上本报告所在的提交，下面是摘录。

```diff
--- a/src/scene.js
+++ b/src/scene.js
@@ const atmosphereUniforms = [];
+const exteriorShadowLights = [];
@@ function lighting() { … }
+// The room's directional shadow maps hug the cabin so the skylight frame stays sharp, which clipped every tree
+// shadow a few metres short of its trunk and left the trees floating. The forest behind the glass (layer 1) is
+// lit by wide-frustum twins of those lights instead, so each shadow starts at the base of its own tree.
+function buildExteriorShadows() {
+  const forest = new THREE.Object3D();
+  forest.position.set(0, 0, -8);
+  scene.add(forest);
+  for (const light of [coolLight, morningWorld.sun]) {
+    light.layers.disable(1);
+    const twin = new THREE.DirectionalLight(light.color, light.intensity);
+    twin.layers.set(1);
+    twin.target = forest;
+    twin.position.subVectors(light.position, light.target.position).setLength(70).add(forest.position);
+    twin.castShadow = true;
+    twin.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
+    Object.assign(twin.shadow.camera, { left: -36, right: 32, top: 36, bottom: -28, near: 20, far: 100 });
+    twin.shadow.bias = -0.0005;
+    twin.shadow.normalBias = 0.12;
+    scene.add(twin);
+    exteriorShadowLights.push({ light, twin });
+  }
+}
@@ function animate() {
+  exteriorShadowLights.forEach(({ light, twin }) => {
+    twin.color.copy(light.color);
+    twin.intensity = light.intensity;
+    if (light.shadow.needsUpdate) twin.shadow.needsUpdate = true;
+  });
   rainSystem.renderCaptures(camera);
@@ function init() {
   morningWorld = new MorningWorld({ scene, trees, mobile, roofHeight, reducedMotion });
+  buildExteriorShadows();
   scene.traverse(object => {
@@
-    if (object.isMesh && object.material?.transparent) ambientOcclusionExcluded.push(object);
+    // The forest (layer 1) is only ever seen through the glass's own capture. SSAO's override material ignores the
+    // needles' alpha cutout, so left in it the trees become solid cards whose outlines get darkened onto the glass.
+    if (object.isMesh && (object.material?.transparent || object.layers.isEnabled(1))) ambientOcclusionExcluded.push(object);

--- a/src/rain-system.js
+++ b/src/rain-system.js
@@ constructor
     this.backgroundCamera.layers.set(1);
+    this.shadowCamera = new THREE.PerspectiveCamera();
@@ renderCaptures(camera) {
-    if (this.renderer.shadowMap.needsUpdate) this.renderer.render(this.scene, camera);
+    if (this.renderer.shadowMap.needsUpdate) {
+      // Refresh every shadow map from a camera that sees both layers: the room's lights keep their casters, and the
+      // forest's own lights (layer 1 only) still get the cabin as a caster instead of just the trees.
+      this.shadowCamera.copy(camera);
+      this.shadowCamera.layers.enable(1);
+      this.renderer.render(this.scene, this.shadowCamera);
+    }
```
