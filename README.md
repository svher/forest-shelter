# 林间 Shelter · 雨夜木屋（源码）

一个可实时交互的 Three.js 场景：森林木屋、倾斜天窗上的雨水、深夜与清晨两种天色、程序合成的环境音。

- 在线体验：<https://svher.github.io/forest-shelter/>
- 分支：`source`（本分支）放源码；`main` 放构建产物 `index.html`，由 GitHub Pages 发布
- 使用说明：[`docs/使用说明.md`](docs/使用说明.md)
- 技术报告：[窗外森林渲染修复（2026-09-30）](docs/2026-09-30-exterior-forest-fix.md)

## 目录

```
src/
  scene.js            场景、灯光、相机、交互与主循环
  rain-system.js      天窗玻璃、窗外画面捕获、雨丝与飞溅
  rain-shaders.js     玻璃 / 雨丝 / 飞溅着色器
  water-simulation.js 玻璃上的水珠模拟
  morning-world.js    清晨天空、晨雾、山脊、鸟
  sunlight-pass.js    体积光：室内后处理与窗外树林光雾
  daylight.js         深夜 ↔ 清晨过渡
  audio.js            Web Audio 环境音
  index.template.html / style.css
docs/                 使用说明与技术报告
build.mjs             用 esbuild 打包成单个 HTML
```

## 构建

```sh
npm ci
npm run check   # 语法检查
npm run build   # 生成 dist/forest-shelter.html（单文件、无外部依赖）
```

发布时把 `dist/forest-shelter.html` 复制为 `main` 分支的 `index.html`。
