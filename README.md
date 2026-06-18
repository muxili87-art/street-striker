# Street Striker

一个可在 Mac、Windows、手机浏览器运行的 2D 街头足球小游戏。

## 运行

```bash
cd /Users/muxi/Documents/Mx_study/games/street-striker
npm install
npm run dev
```

浏览器打开终端里显示的本地地址。

## 控制

- 桌面：`WASD` / 方向键移动，`Space` 射门，`J` 传球，`Shift` 冲刺，`P` 暂停。
- 手机：左侧虚拟摇杆移动，右侧按钮冲刺、传球、射门。

## 设计来源

- 采用 Phaser 3 + Vite + TypeScript，保证桌面和移动浏览器统一运行。
- 参考开源足球项目的轻量 AI 思路：队友跑位、对手追球/防守、守门员守门。
- 不依赖外部图片资源，全部视觉资产由代码生成，方便后续换皮和扩展。
