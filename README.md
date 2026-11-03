# Lands 简体中文翻译维护

这里维护 Lands 简体中文译文、来源快照、术语、例外及质量检查。
安装翻译请前往 [翻译发布仓库](https://github.com/YKDZ/Lands-Simplified-Chinese-Translation)，或下载其中的 Release 附件。

## 开发环境

使用仓库提供的开发容器，或按 `package.json` 安装 Node.js、pnpm，并准备 Temurin Java 25。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm check:full
```

正式检查使用已提交的来源快照，不需要 Lands 插件 JAR；更新来源时才需要提供 JAR。

## 维护翻译

译文和维护资料位于 `translations/zhcn/`，检查器和 Lands 适配位于 `packages/l10n/`。

1. 通过 `pnpm l10n:update --jar <Lands.jar>` 同步来源并执行 QA。
2. 编辑译文，使用 `pnpm l10n:review` 完整验收并查看待提交差异。
3. 人工审阅后，运行 `pnpm l10n:submit --message "更新说明"` 提交并推送维护分支。

维护提交可以保存尚未通过质量验收的工作；提交成功不表示已经发布。译文、说明和维护工具的修改 PR 均提交到本仓库，普通翻译问题继续在发布仓库提 Issues。

## 准备与发布

发布 README 的正文源是 `publication/README.template.md`，其中版本和文件表从正式来源及维护清单派生。`LICENSE` 与受管 YAML 保持原始内容，导出时保留安装目录关系。

可先准备一个不覆盖已有内容的本地预览目录：

```bash
pnpm l10n:preview /tmp/lands-publication-preview
```

预览不代表通过验收，也不会推送文件或创建 Release。

正式发布只有 GitHub Actions 的“发布翻译”手动工作流一个入口：

```bash
gh workflow run publish.yml --repo YKDZ/Lands-Translation-Maintenance --ref main
```

工作流固定本次 `main` 提交，先运行 `check:full`，通过后才获取发布凭据并更新发布仓库。发布标签采用 `lands-9.1.1-r1` 这样的“插件版本＋翻译修订号”；每次发布保存无外层目录的 ZIP 附件。相同内容重复运行不创建新版本，失败重试补齐未完成的发布。

首次发布前须配置 `publication` 环境，并将允许发布的分支限制为 `main`；设置变量 `PUBLICATION_APP_ID` 与密钥 `PUBLICATION_APP_PRIVATE_KEY`。专用 GitHub App 只安装到发布仓库，授予 Contents 读写权限。发布仓库的分支、标签规则须仅允许该 App 创建发布结果，并禁止删除或重写已有历史。

`l10n:publish` 是工作流在验收之后调用的内部步骤，不作为本地发布入口。普通提交、合并和推送都不会自动发布。
