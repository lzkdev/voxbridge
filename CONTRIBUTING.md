# Contributing to Voxbridge

Thank you for your interest in contributing! This guide will help you get started.

## Development Environment

### Prerequisites

- Node.js v18+
- Rust toolchain (rustc >= 1.88)
- A virtual audio device (BlackHole recommended for testing)

### Setup

```bash
git clone https://github.com/lzkdev/voxbridge.git
cd voxbridge
npm install
npm run tauri:dev
```

### Project Structure

```
src/                    # Frontend (TypeScript + Vite)
├── panel/              # Main control panel window
├── settings/           # Settings window
├── setup/              # First-run setup wizard
├── subtitle/           # Floating subtitle overlay
└── shared/             # Shared modules
    ├── i18n/           # Internationalization (zh-TW, en)
    ├── ipc.ts          # Tauri IPC bindings
    ├── config-types.ts # TypeScript type definitions
    ├── events.ts       # Cross-window event system
    ├── clipboard.ts    # Clipboard shortcuts
    └── languages.ts    # Language/voice definitions

src-tauri/              # Backend (Rust)
├── src/lib.rs          # Main application logic
├── src/main.rs         # Entry point
└── tauri.conf.json     # Tauri configuration
```

## Code Style

- **Frontend**: TypeScript with strict mode. No framework — vanilla DOM manipulation.
- **Backend**: Rust with standard formatting (`cargo fmt`).
- No external UI frameworks or CSS preprocessors.
- Keep `lib.rs` as the single backend source file.

## i18n Guidelines

All user-facing strings must go through the `t()` function from `src/shared/i18n/index.ts`.

### Adding a new string

1. Add the key to both `src/shared/i18n/zh-TW.json` and `src/shared/i18n/en.json`
2. Use `t("module.keyName")` in your TypeScript code
3. Key format: `module.descriptiveName` (e.g., `panel.idle`, `settings.fontSize`)

### Adding a new locale

1. Create `src/shared/i18n/{locale}.json` with all keys translated
2. Import and register it in `src/shared/i18n/index.ts`

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with clear, focused commits
3. Ensure `npm run build` passes without errors
4. Test your changes with `npm run tauri:dev`
5. Submit a PR with a clear description of what and why

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for new ideas
- Include your macOS version, audio device setup, and relevant logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
