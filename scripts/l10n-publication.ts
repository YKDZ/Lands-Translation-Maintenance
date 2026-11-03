import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TranslationPublicationOptions {
  readonly publicationDirectory: string;
  readonly maintenanceDirectory: string;
  readonly sourceCommit: string;
  readonly sourceVersion: string;
  readonly token: string;
  readonly targetRepository?: string;
  readonly targetGitUrl?: string;
  readonly apiBaseUrl?: string;
  readonly bootstrapCommit?: string;
}

export interface TranslationPublicationResult {
  readonly tag: string;
  readonly commit: string;
  readonly releaseUrl: string;
  readonly createdCommit: boolean;
  readonly createdRelease: boolean;
}

interface PublicationRecord {
  readonly sourceCommit: string;
  readonly sourceVersion: string;
  readonly tag: string;
  readonly commit: string;
}

interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state: string;
  readonly digest?: string | null;
}

interface Release {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
  readonly upload_url: string;
  readonly html_url: string;
  readonly assets: readonly ReleaseAsset[];
}

const maintenanceRepository = "YKDZ/Lands-Translation-Maintenance";
const publicationRepository = "YKDZ/Lands-Simplified-Chinese-Translation";
const originalPublicationCommit = "b8f6985a4ad2af1b76b05f0f79b718a2234623ad";

function git(
  directory: string,
  args: readonly string[],
  token: string,
): Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.name=Lands Translation Publisher",
      "-c",
      "user.email=lands-translation-publisher@users.noreply.github.com",
      ...args,
    ],
    {
      cwd: directory,
      // ZIP 的 DOS 时间戳使用本地时区；固定时区让同一发布提交跨环境重试仍得到相同归档。
      env: {
        ...process.env,
        GH_TOKEN: token,
        GIT_TERMINAL_PROMPT: "0",
        TZ: "UTC",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      "发布 Git 操作失败（" +
        (args[0] ?? "git") +
        "）：" +
        (result.error?.message ?? result.stderr.toString("utf8").trim()),
    );
  }
  return result.stdout;
}

function gitText(
  directory: string,
  args: readonly string[],
  token: string,
): string {
  return git(directory, args, token).toString("utf8").trim();
}

function readPublicationRecord(
  directory: string,
  token: string,
): PublicationRecord {
  const message = gitText(
    directory,
    ["show", "-s", "--format=%B", "HEAD"],
    token,
  );
  const trailer = (name: string): string => {
    const values = message
      .split("\n")
      .filter((line) => line.startsWith(name + ": "));
    if (values.length !== 1 || values[0] === undefined) {
      throw new Error(
        "发布仓库出现未经发布流程记录的改动，已停止：缺少唯一的 " + name,
      );
    }
    return values[0].slice(name.length + 2);
  };
  const sourceCommit = trailer("Maintenance-Commit");
  const sourceVersion = trailer("Source-Version");
  const tag = trailer("Publication-Tag");
  if (
    trailer("Maintenance-Repository") !== maintenanceRepository ||
    !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
    !tag.startsWith("lands-" + sourceVersion + "-r") ||
    !/^lands-[a-zA-Z0-9.+_-]+-r[1-9]\d*$/u.test(tag)
  ) {
    throw new Error("发布仓库来源记录不符合当前发布约定，已停止");
  }
  const commit = gitText(directory, ["rev-parse", "HEAD"], token);
  const taggedCommit = gitText(
    directory,
    ["rev-parse", "refs/tags/" + tag + "^{commit}"],
    token,
  );
  if (taggedCommit !== commit) {
    throw new Error("发布仓库已偏离最后一次发布标签，已停止");
  }
  return { sourceCommit, sourceVersion, tag, commit };
}

function requireSourceProgress(
  options: TranslationPublicationOptions,
  previous: PublicationRecord,
): void {
  const result = spawnSync(
    "git",
    [
      "merge-base",
      "--is-ancestor",
      previous.sourceCommit,
      options.sourceCommit,
    ],
    { cwd: options.maintenanceDirectory, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      "所选维护提交早于已发布来源或不在同一历史上，已停止以免旧任务覆盖新发布",
    );
  }
}

async function replacePublicationFiles(
  source: string,
  target: string,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  if (entries.some((entry) => entry.name === ".git")) {
    throw new Error("发布产物不能包含 Git 元数据");
  }
  // 发布目录完整拥有用户文件，显式清理退出范围的文件，保留目标仓库自身历史。
  for (const name of await readdir(target)) {
    if (name !== ".git") {
      await rm(join(target, name), { recursive: true, force: true });
    }
  }
  for (const entry of entries) {
    await cp(join(source, entry.name), join(target, entry.name), {
      recursive: true,
    });
  }
}

function nextTag(directory: string, version: string, token: string): string {
  const prefix = "lands-" + version + "-r";
  let revision = 0;
  for (const tag of gitText(directory, ["tag", "--list"], token).split("\n")) {
    if (
      tag.startsWith(prefix) &&
      /^[1-9]\d*$/u.test(tag.slice(prefix.length))
    ) {
      revision = Math.max(revision, Number(tag.slice(prefix.length)));
    }
  }
  return prefix + String(revision + 1);
}

async function ensureRelease(
  options: TranslationPublicationOptions,
  directory: string,
  record: PublicationRecord,
): Promise<{ releaseUrl: string; createdRelease: boolean }> {
  const repository = options.targetRepository ?? publicationRepository;
  const apiBase = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/$/u,
    "",
  );
  const repositoryPath = "/repos/" + repository;
  const headers = {
    Authorization: "Bearer " + options.token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const request = async (
    path: string,
    method = "GET",
    body?: string | Uint8Array,
    accept?: string,
  ): Promise<Response> => {
    const response = await fetch(
      path.startsWith("http") ? path : apiBase + path,
      {
        method,
        headers: {
          ...headers,
          ...(accept === undefined ? {} : { Accept: accept }),
          ...(body === undefined
            ? {}
            : {
                "Content-Type":
                  typeof body === "string"
                    ? "application/json"
                    : "application/zip",
              }),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : new Uint8Array(body) }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    return response;
  };
  const expectSuccess = async (
    response: Response,
    purpose: string,
  ): Promise<void> => {
    if (!response.ok) {
      throw new Error(
        purpose +
          "失败（HTTP " +
          String(response.status) +
          "）：" +
          (await response.text()),
      );
    }
  };
  let response = await request(
    repositoryPath + "/releases/tags/" + encodeURIComponent(record.tag),
  );
  let release: Release | undefined;
  if (response.status === 404) {
    // 按标签读取只返回已公开版本；有写权限的列表才包含上次失败留下的草稿。
    for (let page = 1; ; page += 1) {
      response = await request(
        repositoryPath + "/releases?per_page=100&page=" + String(page),
      );
      await expectSuccess(response, "查找尚未完成的发布草稿");
      const releases = (await response.json()) as Release[];
      release = releases.find((candidate) => candidate.tag_name === record.tag);
      if (release !== undefined || releases.length < 100) {
        break;
      }
    }
  } else {
    await expectSuccess(response, "读取翻译发布");
    release = (await response.json()) as Release;
  }
  const createdRelease = release === undefined;
  if (release === undefined) {
    response = await request(
      repositoryPath + "/releases",
      "POST",
      JSON.stringify({
        tag_name: record.tag,
        target_commitish: record.commit,
        name:
          "Lands " +
          record.sourceVersion +
          " 简体中文翻译 · 第 " +
          record.tag.slice(record.tag.lastIndexOf("-r") + 2) +
          " 次发布",
        body:
          "适用于 Lands " +
          record.sourceVersion +
          " 的简体中文翻译。\n\n下载下方 ZIP，并参照其中的 README 安装；归档保留原有目录关系。",
        draft: true,
        prerelease: false,
      }),
    );
    await expectSuccess(response, "创建发布草稿");
    release = (await response.json()) as Release;
  }
  if (release.tag_name !== record.tag) {
    throw new Error("Release 与发布标签不一致，已停止");
  }
  const revision = record.tag.slice(record.tag.lastIndexOf("-r") + 2);
  const archiveName =
    "lands-" + record.sourceVersion + "-zh-CN-r" + revision + ".zip";
  // 从确定的发布提交生成归档，重试不会夹带当前维护目录的新内容。
  const archive = git(
    directory,
    ["archive", "--format=zip", record.commit],
    options.token,
  );
  const digest = "sha256:" + createHash("sha256").update(archive).digest("hex");
  const matches = release.assets.filter((asset) => asset.name === archiveName);
  if (matches.length > 1) {
    throw new Error("Release 中存在重名归档，已停止");
  }
  let asset = matches[0];
  if (asset !== undefined && asset.state === "starter" && release.draft) {
    response = await request(
      repositoryPath + "/releases/assets/" + String(asset.id),
      "DELETE",
    );
    await expectSuccess(response, "清理失败上传留下的空附件");
    asset = undefined;
  }
  if (asset === undefined) {
    if (!release.draft) {
      throw new Error("已公开的 Release 缺少归档，已停止；不会修改已公开发布");
    }
    const uploadUrl = new URL(release.upload_url.replace(/\{.*$/u, ""));
    uploadUrl.searchParams.set("name", archiveName);
    response = await request(uploadUrl.href, "POST", archive);
    await expectSuccess(response, "上传翻译归档");
    asset = (await response.json()) as ReleaseAsset;
  }
  if (
    asset.name !== archiveName ||
    asset.state !== "uploaded" ||
    asset.size !== archive.length
  ) {
    throw new Error("翻译归档尚未完整上传或内容不匹配，已停止");
  }
  if (asset.digest != null) {
    if (asset.digest !== digest) {
      throw new Error("Release 归档与发布提交内容不一致，已停止且未覆盖附件");
    }
  } else {
    response = await request(
      repositoryPath + "/releases/assets/" + String(asset.id),
      "GET",
      undefined,
      "application/octet-stream",
    );
    await expectSuccess(response, "复核翻译归档");
    if (!archive.equals(Buffer.from(await response.arrayBuffer()))) {
      throw new Error("Release 归档与发布提交内容不一致，已停止且未覆盖附件");
    }
  }
  if (release.draft) {
    response = await request(
      repositoryPath + "/releases/" + String(release.id),
      "PATCH",
      JSON.stringify({ draft: false, make_latest: "true" }),
    );
    await expectSuccess(response, "公开翻译发布");
    release = (await response.json()) as Release;
    if (release.draft) {
      throw new Error("Release 仍为草稿，发布尚未完成");
    }
  }
  return { releaseUrl: release.html_url, createdRelease };
}

/**
 * 将已验收的翻译产物发布到独立仓库并完成归档；调用方负责固定来源提交及正式验收。
 * Git 与 Release API 不构成事务。失败时已推送的提交、标签与草稿保留，重试按这些事实续补。
 * 远端和 API 地址参数只改变连接目标，隔离验收与正式工作流共用本实现。
 */
export async function publishTranslation(
  options: TranslationPublicationOptions,
): Promise<TranslationPublicationResult> {
  if (
    !/^[a-f0-9]{40}$/u.test(options.sourceCommit) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/u.test(options.sourceVersion)
  ) {
    throw new Error("发布必须提供确定的维护提交和有效 Lands 版本");
  }
  const sourceCommit = gitText(
    options.maintenanceDirectory,
    ["rev-parse", options.sourceCommit + "^{commit}"],
    options.token,
  );
  if (sourceCommit !== options.sourceCommit) {
    throw new Error("维护提交不匹配，已停止");
  }
  const work = await mkdtemp(join(tmpdir(), "lands-publication-"));
  const directory = join(work, "publication");
  try {
    git(
      work,
      [
        "clone",
        "--quiet",
        "--single-branch",
        "--branch",
        "main",
        options.targetGitUrl ??
          "https://github.com/" + publicationRepository + ".git",
        directory,
      ],
      options.token,
    );
    const head = gitText(directory, ["rev-parse", "HEAD"], options.token);
    const previous =
      head === (options.bootstrapCommit ?? originalPublicationCommit)
        ? undefined
        : readPublicationRecord(directory, options.token);
    if (previous !== undefined) {
      requireSourceProgress(options, previous);
    }
    await replacePublicationFiles(options.publicationDirectory, directory);
    git(directory, ["add", "--all"], options.token);
    const tree = gitText(directory, ["write-tree"], options.token);
    const previousTree = gitText(
      directory,
      ["rev-parse", "HEAD^{tree}"],
      options.token,
    );
    if (
      previous !== undefined &&
      previous.sourceCommit === sourceCommit &&
      (tree !== previousTree ||
        previous.sourceVersion !== options.sourceVersion)
    ) {
      throw new Error("同一维护提交产生了不同发布产物，已停止");
    }
    // 即使新产物无变化，也必须先补齐上次 Git 推送后未完成的 Release。
    const completedPrevious =
      previous === undefined
        ? undefined
        : await ensureRelease(options, directory, previous);
    if (previous !== undefined && tree === previousTree) {
      if (completedPrevious === undefined) {
        throw new Error("上次发布结果不可用");
      }
      return {
        tag: previous.tag,
        commit: previous.commit,
        ...completedPrevious,
        createdCommit: false,
      };
    }
    const tag = nextTag(directory, options.sourceVersion, options.token);
    git(
      directory,
      [
        "commit",
        "--allow-empty",
        "-m",
        "发布 Lands " + options.sourceVersion + " 简体中文翻译",
        "-m",
        [
          "Maintenance-Repository: " + maintenanceRepository,
          "Maintenance-Commit: " + sourceCommit,
          "Source-Version: " + options.sourceVersion,
          "Publication-Tag: " + tag,
        ].join("\n"),
      ],
      options.token,
    );
    const commit = gitText(directory, ["rev-parse", "HEAD"], options.token);
    git(directory, ["tag", tag, commit], options.token);
    git(
      directory,
      [
        "push",
        "--atomic",
        "origin",
        "HEAD:refs/heads/main",
        "refs/tags/" + tag + ":refs/tags/" + tag,
      ],
      options.token,
    );
    const release = await ensureRelease(options, directory, {
      tag,
      commit,
      sourceCommit,
      sourceVersion: options.sourceVersion,
    });
    return { tag, commit, ...release, createdCommit: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
