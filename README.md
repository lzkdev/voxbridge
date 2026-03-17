# Voxbridge

Real-time bidirectional speech translation & live subtitles for macOS.

[English](#english) | [简体中文](#简体中文)

---

## English

### Features

- **Speech Translation (Upstream)** — Speak in your language, get translated speech output in real-time
  `Mic → Translation → Translated Speech → Virtual Audio Device`
- **Live Subtitles (Downstream)** — Translate meeting/video audio into scrolling subtitles
  `Audio Bus → Translation → Scrolling Subtitles`
- 22 languages with bidirectional translation
- Multiple TTS voices with regional accents
- Works with Zoom, Google Meet, WeChat, YouTube, etc.
- Powered by DashScope models: `qwen3-livetranslate-flash-realtime` (speech output) / `gummy-realtime-v1` (subtitles only)
- i18n: Simplified Chinese & English UI

### Prerequisites

- **Node.js** (v18+) and **npm**
- **Rust toolchain** (`rustc >= 1.88` recommended)
- A **virtual audio device** for audio routing:
  - [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free, recommended)
  - Voicemod Virtual Cable
  - Loopback by Rogue Amoeba
- A [DashScope](https://dashscope.aliyuncs.com/) API Key

### API Pricing

| Model | Billing | Input (Audio) | Input (Image) | Output (Text) | Output (Audio) |
|-------|---------|---------------|---------------|----------------|----------------|
| `gummy-realtime-v1` | 0.00015 CNY/sec | — | — | — | — |
| `qwen3-livetranslate-flash-realtime` | Per million tokens | 64 CNY | 8 CNY | 64 CNY | 240 CNY |

> Pricing from [DashScope](https://help.aliyun.com/zh/model-studio/). Voxbridge uses `gummy` for subtitle-only mode (cheaper) and `qwen3` when voice output is enabled.

### Quick Start

```bash
git clone https://github.com/lzkdev/voxbridge.git
cd voxbridge
npm install
npm run tauri:dev
```

### Usage

#### 1. Setup Wizard

On first launch, the setup wizard guides you through:
1. Enter your DashScope API Key (or skip to set up later)
2. Select audio devices (microphone, virtual output, meeting audio source)
3. Click "Start Using"

#### 2. Speech Translation (Upstream)

1. Set source and target languages in the panel
2. Toggle **Speech Translation** ON
3. In your meeting app, set microphone to the virtual audio device

#### 3. Live Subtitles (Downstream)

1. Set source and target languages
2. Toggle **Subtitle Translation** ON
3. A floating subtitle window appears — drag to reposition, resize as needed
4. Optionally enable voice output

#### 4. Zoom Integration Example

| Setting | Value |
|---------|-------|
| Zoom Microphone | BlackHole 2ch |
| Zoom Speaker | Multi-Output Device (speakers + BlackHole) |
| Voxbridge Upstream Input | MacBook Microphone |
| Voxbridge Upstream Output | BlackHole 2ch |
| Voxbridge Downstream Input | BlackHole 2ch |

> **Tip**: Create a Multi-Output Device in macOS Audio MIDI Setup to hear meeting audio while routing it to BlackHole.

### Build

```bash
npm run tauri:build
```

Output: `src-tauri/target/release/bundle/dmg/Voxbridge_0.1.0_aarch64.dmg`

### Install

Download the DMG from [Releases](https://github.com/lzkdev/voxbridge/releases). Since the app is not code-signed, macOS will block it. Run:

```bash
xattr -cr /Applications/Voxbridge.app
```

Then open the app normally.

### Platform

- macOS only (microphone permission required on first launch)
- Apple Silicon and Intel supported

### License

[MIT](LICENSE)

---

## 简体中文

### 功能

- **语音翻译（上行）** — 说你的语言，实时输出翻译语音
  `麦克风 → 翻译 → 翻译语音 → 虚拟音频设备`
- **实时字幕（下行）** — 将会议/视频音频翻译为滚动字幕
  `音频总线 → 翻译 → 滚动字幕`
- 支持 22 种语言双向翻译
- 多种 TTS 语音及地方口音
- 适用于 Zoom、Google Meet、微信、YouTube 等
- 基于 DashScope 模型：`qwen3-livetranslate-flash-realtime`（语音输出）/ `gummy-realtime-v1`（纯字幕）
- 界面语言：简体中文、英文

### 系统要求

- **Node.js**（v18+）及 **npm**
- **Rust 工具链**（建议 `rustc >= 1.88`）
- **虚拟音频设备**（用于音频路由）：
  - [BlackHole](https://github.com/ExistentialAudio/BlackHole)（免费，推荐）
  - Voicemod Virtual Cable
  - Loopback by Rogue Amoeba
- [DashScope](https://dashscope.aliyuncs.com/) API Key

### API 计费

| 模型 | 计费方式 | 输入（音频） | 输入（图片） | 输出（文本） | 输出（音频） |
|------|----------|-------------|-------------|-------------|-------------|
| `gummy-realtime-v1` | 0.00015 元/秒 | — | — | — | — |
| `qwen3-livetranslate-flash-realtime` | 按百万 Token | 64 元 | 8 元 | 64 元 | 240 元 |

> 价格来源：[DashScope](https://help.aliyun.com/zh/model-studio/)。纯字幕模式使用 `gummy`（更便宜），开启语音输出时使用 `qwen3`。

### 快速开始

```bash
git clone https://github.com/lzkdev/voxbridge.git
cd voxbridge
npm install
npm run tauri:dev
```

### 使用教程

#### 1. 设置向导

首次启动时，向导会引导你完成：
1. 输入 DashScope API Key（或跳过稍后设置）
2. 选择音频设备（麦克风、虚拟输出设备、会议音频来源）
3. 点击「开始使用」

#### 2. 语音翻译（上行）

1. 在面板中设置源语言和目标语言
2. 开启 **语音翻译** 开关
3. 在会议应用中将麦克风设为虚拟音频设备

#### 3. 实时字幕（下行）

1. 设置源语言和目标语言
2. 开启 **字幕翻译** 开关
3. 浮动字幕窗口出现 — 可拖动、可缩放
4. 可选开启语音输出

#### 4. Zoom 集成示例

| 设置项 | 值 |
|--------|-----|
| Zoom 麦克风 | BlackHole 2ch |
| Zoom 扬声器 | 多输出设备（系统扬声器 + BlackHole） |
| Voxbridge 上行输入 | MacBook 麦克风 |
| Voxbridge 上行输出 | BlackHole 2ch |
| Voxbridge 下行输入 | BlackHole 2ch |

> **提示**：在 macOS「音频 MIDI 设置」中创建多输出设备，即可同时听到会议音频又能路由到 BlackHole 进行字幕翻译。

### 构建

```bash
npm run tauri:build
```

输出：`src-tauri/target/release/bundle/dmg/Voxbridge_0.1.0_aarch64.dmg`

### 安装

从 [Releases](https://github.com/lzkdev/voxbridge/releases) 下载 DMG。由于应用未签名，macOS 会阻止打开，需执行：

```bash
xattr -cr /Applications/Voxbridge.app
```

然后正常打开即可。

### 平台

- 仅支持 macOS（首次启动需授权麦克风权限）
- 支持 Apple Silicon 及 Intel

### 许可

[MIT](LICENSE)
