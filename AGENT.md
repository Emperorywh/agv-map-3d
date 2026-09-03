# AGV Map 3D — 开发规则

## 单元测试规则（强制）

**本项目在开发过程中禁止编写任何单元测试代码，测试由使用者本人自测。**

所有 AI 编码代理与开发者必须遵守以下规则：

1. **禁止编写单元测试**：不得创建任何测试文件（`*.test.ts`、`*.test.tsx`、`*.spec.ts`、`*.spec.tsx`），不得创建 `__tests__`、`fixtures`、`test-utils` 之类的测试目录或辅助文件。
2. **禁止引入测试框架与依赖**：不得在 `package.json` 中添加或恢复任何测试相关依赖（如 `vitest`、`jest`、`@testing-library/*`、`jsdom`、`@react-three/test-renderer` 等），不得添加 `test:unit` 之类的测试脚本。
3. **禁止创建测试配置**：不得新建 `vitest.config.*`、`jest.config.*`、`vitest.setup.*` 等测试配置文件。
4. **验证方式**：完成开发后，仅通过以下命令验证代码质量，无需运行任何测试：
   - `pnpm lint` — 代码规范检查
   - `pnpm typecheck` — TypeScript 类型检查
   - `pnpm build` — 生产构建验证

任何要求补充单元测试的变更都必须先征得使用者明确同意，否则一律不写测试，直接交付实现代码。
