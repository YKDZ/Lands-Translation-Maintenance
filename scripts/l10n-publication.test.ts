import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  publishTranslation,
  type TranslationPublicationOptions,
} from "./l10n-publication.ts";

interface StoredAsset {
  id: number;
  name: string;
  state: string;
  size: number;
  digest: string;
  bytes: Buffer;
}

interface StoredRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  upload_url: string;
  html_url: string;
  assets: StoredAsset[];
}

function git(directory: string, args: readonly string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=发布测试",
      "-c",
      "user.email=publication@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createFixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-publication-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, "publication.git");
  const seed = join(directory, "seed");
  const maintenance = join(directory, "maintenance");
  const publication = join(directory, "prepared");
  git(directory, ["init", "--bare", "--initial-branch=main", remote]);
  await mkdir(seed);
  git(seed, ["init", "--initial-branch=main"]);
  await writeFile(join(seed, "README.md"), "旧版说明\n");
  await writeFile(join(seed, "obsolete.yml"), "旧版译文\n");
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "-m", "既有发布仓库历史"]);
  const bootstrapCommit = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "origin", "HEAD:main"]);

  await mkdir(maintenance);
  git(maintenance, ["init", "--initial-branch=main"]);
  await writeFile(join(maintenance, "source.txt"), "已验收来源一\n");
  git(maintenance, ["add", "--all"]);
  git(maintenance, ["commit", "-m", "首次维护提交"]);
  const sourceCommit = git(maintenance, ["rev-parse", "HEAD"]);
  await mkdir(join(publication, "Locale"), { recursive: true });
  await writeFile(join(publication, "README.md"), "# Lands 9.1.1\n");
  await writeFile(join(publication, "LICENSE"), "沿用许可证\n");
  await writeFile(
    join(publication, "Locale/zh-CN.yml"),
    "# 保留注释\r\nmessage: '中文'\r\n",
  );
  await writeFile(join(publication, "roles.yml"), "name: 职位\n");

  const state = {
    releases: [] as StoredRelease[],
    createCount: 0,
    uploadCount: 0,
    failUploads: 0,
    failPublications: 0,
    apiCalls: 0,
  };
  let apiBaseUrl = "";
  const server = createServer((request, response) => {
    void (async () => {
      state.apiCalls += 1;
      assert.equal(
        request.headers.authorization,
        "Bearer test-publication-token",
      );
      const url = new URL(request.url ?? "/", apiBaseUrl);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
      }
      const bytes = Buffer.concat(chunks);
      const send = (status: number, value: unknown): void => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (
        url.pathname === "/repos/test/translations/releases" &&
        request.method === "GET"
      ) {
        const page = Number(url.searchParams.get("page") ?? "1");
        send(200, state.releases.slice((page - 1) * 100, page * 100));
        return;
      }
      if (
        url.pathname.startsWith("/repos/test/translations/releases/tags/") &&
        request.method === "GET"
      ) {
        const tag = decodeURIComponent(
          url.pathname.slice("/repos/test/translations/releases/tags/".length),
        );
        // 与 GitHub 一致：按标签读取不返回草稿，重试必须走有权限的列表查询。
        const release = state.releases.find(
          (item) => item.tag_name === tag && !item.draft,
        );
        send(
          release === undefined ? 404 : 200,
          release ?? { message: "Not Found" },
        );
        return;
      }
      if (
        url.pathname === "/repos/test/translations/releases" &&
        request.method === "POST"
      ) {
        const body = JSON.parse(bytes.toString("utf8")) as {
          tag_name: string;
          target_commitish: string;
          draft: boolean;
        };
        assert.equal(body.draft, true);
        assert.equal(
          git(remote, ["rev-parse", "refs/tags/" + body.tag_name]),
          body.target_commitish,
        );
        if (
          state.releases.some((release) => release.tag_name === body.tag_name)
        ) {
          send(422, { message: "already_exists" });
          return;
        }
        state.createCount += 1;
        const id = state.createCount;
        const release: StoredRelease = {
          ...body,
          id,
          upload_url: apiBaseUrl + "/uploads/" + String(id) + "{?name,label}",
          html_url: "https://example.test/releases/" + body.tag_name,
          assets: [],
        };
        state.releases.push(release);
        send(201, release);
        return;
      }
      if (url.pathname.startsWith("/uploads/") && request.method === "POST") {
        state.uploadCount += 1;
        const release = state.releases.find(
          (item) => item.id === Number(url.pathname.slice("/uploads/".length)),
        );
        assert.ok(release);
        assert.equal(release.draft, true);
        if (state.failUploads > 0) {
          state.failUploads -= 1;
          send(502, { message: "模拟上传中断" });
          return;
        }
        const asset: StoredAsset = {
          id: state.uploadCount,
          name: url.searchParams.get("name") ?? "",
          state: "uploaded",
          size: bytes.length,
          digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
          bytes,
        };
        release.assets.push(asset);
        send(201, asset);
        return;
      }
      if (
        url.pathname.startsWith("/repos/test/translations/releases/") &&
        request.method === "PATCH"
      ) {
        const id = Number(
          url.pathname.slice("/repos/test/translations/releases/".length),
        );
        const release = state.releases.find((item) => item.id === id);
        assert.ok(release);
        assert.equal(release.assets.length, 1);
        if (state.failPublications > 0) {
          state.failPublications -= 1;
          send(502, { message: "模拟公开发布中断" });
          return;
        }
        release.draft = false;
        send(200, release);
        return;
      }
      send(404, {
        message:
          "未实现的测试 API：" + String(request.method) + " " + url.pathname,
      });
    })().catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.stack : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  apiBaseUrl = "http://127.0.0.1:" + String(address.port);
  const options: TranslationPublicationOptions = {
    publicationDirectory: publication,
    maintenanceDirectory: maintenance,
    sourceCommit,
    sourceVersion: "9.1.1",
    token: "test-publication-token",
    targetRepository: "test/translations",
    targetGitUrl: remote,
    apiBaseUrl,
    bootstrapCommit,
  };
  return {
    directory,
    remote,
    seed,
    maintenance,
    publication,
    bootstrapCommit,
    sourceCommit,
    state,
    options,
  };
}

void test("正式发布保留历史、同步完整目录、归档原始字节，重复不新增且修订号递增", async (context) => {
  const originalTimezone = process.env.TZ;
  context.after(() => {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });
  process.env.TZ = "UTC";
  const fixture = await createFixture(context);
  const first = await publishTranslation(fixture.options);
  assert.equal(first.tag, "lands-9.1.1-r1");
  assert.equal(first.createdCommit, true);
  assert.equal(first.createdRelease, true);
  assert.equal(
    git(fixture.remote, ["rev-parse", "main^"]),
    fixture.bootstrapCommit,
  );
  assert.deepEqual(
    git(fixture.remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n"),
    ["LICENSE", "Locale/zh-CN.yml", "README.md", "roles.yml"],
  );
  const firstRelease = fixture.state.releases[0];
  assert.ok(firstRelease);
  assert.equal(firstRelease.draft, false);
  const asset = firstRelease.assets[0];
  assert.ok(asset);
  assert.equal(asset.name, "lands-9.1.1-zh-CN-r1.zip");
  const archiveFile = join(fixture.directory, "archive.zip");
  await writeFile(archiveFile, asset.bytes);
  const paths = spawnSync("unzip", ["-Z1", archiveFile], { encoding: "utf8" });
  assert.equal(paths.status, 0, paths.stderr);
  assert.deepEqual(paths.stdout.trim().split("\n"), [
    "LICENSE",
    "Locale/",
    "Locale/zh-CN.yml",
    "README.md",
    "roles.yml",
  ]);
  const yaml = spawnSync("unzip", ["-p", archiveFile, "Locale/zh-CN.yml"]);
  assert.equal(yaml.status, 0, yaml.stderr.toString("utf8"));
  assert.equal(
    yaml.stdout.toString("utf8"),
    "# 保留注释\r\nmessage: '中文'\r\n",
  );

  for (const timezone of ["Asia/Shanghai", "America/Los_Angeles"]) {
    process.env.TZ = timezone;
    const repeated = await publishTranslation(fixture.options);
    assert.deepEqual(repeated, {
      ...first,
      createdCommit: false,
      createdRelease: false,
    });
  }
  assert.equal(fixture.state.createCount, 1);
  assert.equal(fixture.state.uploadCount, 1);
  await writeFile(join(fixture.maintenance, "source.txt"), "已验收来源二\n");
  git(fixture.maintenance, ["commit", "-am", "第二次维护提交"]);
  await writeFile(
    join(fixture.publication, "Locale/zh-CN.yml"),
    "message: '修订中文'\n",
  );
  await rm(join(fixture.publication, "roles.yml"));
  const second = await publishTranslation({
    ...fixture.options,
    sourceCommit: git(fixture.maintenance, ["rev-parse", "HEAD"]),
  });
  assert.equal(second.tag, "lands-9.1.1-r2");
  assert.equal(git(fixture.remote, ["rev-parse", "main^"]), first.commit);
  assert.doesNotMatch(
    git(fixture.remote, ["ls-tree", "-r", "--name-only", "main"]),
    /roles.yml/u,
  );
  assert.equal(fixture.state.releases.length, 2);
  assert.deepEqual(firstRelease.assets[0]?.bytes, asset.bytes);
});

void test("上传和公开发布失败均保留已推送事实，重试补齐同一草稿且不重复附件", async (context) => {
  const fixture = await createFixture(context);
  fixture.state.failUploads = 1;
  await assert.rejects(
    publishTranslation(fixture.options),
    /上传翻译归档失败/u,
  );
  const retainedCommit = git(fixture.remote, ["rev-parse", "main"]);
  assert.notEqual(retainedCommit, fixture.bootstrapCommit);
  assert.equal(
    git(fixture.remote, ["rev-parse", "refs/tags/lands-9.1.1-r1"]),
    retainedCommit,
  );
  assert.equal(fixture.state.releases[0]?.draft, true);
  fixture.state.failPublications = 1;
  await assert.rejects(
    publishTranslation(fixture.options),
    /公开翻译发布失败/u,
  );
  assert.equal(fixture.state.createCount, 1);
  assert.equal(fixture.state.releases[0]?.assets.length, 1);
  const result = await publishTranslation(fixture.options);
  assert.equal(result.commit, retainedCommit);
  assert.equal(result.tag, "lands-9.1.1-r1");
  assert.equal(result.createdCommit, false);
  assert.equal(result.createdRelease, false);
  assert.equal(fixture.state.createCount, 1);
  assert.equal(fixture.state.uploadCount, 2);
  assert.equal(fixture.state.releases[0]?.draft, false);
});

void test("拒绝来源倒退、同一来源产物变化、目标漂移及已公开附件变化", async (context) => {
  const fixture = await createFixture(context);
  await writeFile(join(fixture.maintenance, "source.txt"), "新维护来源\n");
  git(fixture.maintenance, ["commit", "-am", "新维护提交"]);
  const options = {
    ...fixture.options,
    sourceCommit: git(fixture.maintenance, ["rev-parse", "HEAD"]),
  };
  const published = await publishTranslation(options);
  const apiCalls = fixture.state.apiCalls;
  await assert.rejects(publishTranslation(fixture.options), /早于已发布来源/u);
  assert.equal(fixture.state.apiCalls, apiCalls);
  await writeFile(
    join(fixture.publication, "roles.yml"),
    "name: 来源未提交的新值\n",
  );
  await assert.rejects(
    publishTranslation(options),
    /同一维护提交产生了不同发布产物/u,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "main"]), published.commit);
  await writeFile(join(fixture.publication, "roles.yml"), "name: 职位\n");
  const asset = fixture.state.releases[0]?.assets[0];
  assert.ok(asset);
  asset.digest = "sha256:" + "0".repeat(64);
  await assert.rejects(
    publishTranslation(options),
    /归档与发布提交内容不一致/u,
  );
  assert.equal(fixture.state.uploadCount, 1);

  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  await writeFile(join(fixture.seed, "manual.yml"), "绕过正式流程的修改\n");
  git(fixture.seed, ["add", "--all"]);
  git(fixture.seed, ["commit", "-m", "手动修改发布端"]);
  git(fixture.seed, ["push", "origin", "HEAD:main"]);
  const drifted = git(fixture.remote, ["rev-parse", "main"]);
  await assert.rejects(publishTranslation(options), /未经发布流程记录的改动/u);
  assert.equal(git(fixture.remote, ["rev-parse", "main"]), drifted);
});

void test("首次目标不匹配或原子推送失败时不创建 Release，失败重试仍从 r1 开始", async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(
    publishTranslation({ ...fixture.options, bootstrapCommit: "0".repeat(40) }),
    /未经发布流程记录/u,
  );
  assert.equal(fixture.state.apiCalls, 0);
  const hook = join(fixture.remote, "hooks/pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  await assert.rejects(
    publishTranslation(fixture.options),
    /发布 Git 操作失败/u,
  );
  assert.equal(
    git(fixture.remote, ["rev-parse", "main"]),
    fixture.bootstrapCommit,
  );
  assert.equal(git(fixture.remote, ["tag", "--list"]), "");
  assert.equal(fixture.state.createCount, 0);
  await rm(hook);
  const result = await publishTranslation(fixture.options);
  assert.equal(result.tag, "lands-9.1.1-r1");
  assert.equal(fixture.state.createCount, 1);
});

void test("新的维护版本先补齐上次归档，再发布自己的文件，并重新计算版本内修订号", async (context) => {
  const fixture = await createFixture(context);
  fixture.state.failUploads = 1;
  await assert.rejects(
    publishTranslation(fixture.options),
    /上传翻译归档失败/u,
  );
  const previousCommit = git(fixture.remote, ["rev-parse", "main"]);
  await writeFile(
    join(fixture.maintenance, "source.txt"),
    "Lands 9.1.2 来源\n",
  );
  git(fixture.maintenance, ["commit", "-am", "维护新版 Lands"]);
  await writeFile(join(fixture.publication, "README.md"), "# Lands 9.1.2\n");
  await writeFile(
    join(fixture.publication, "Locale/zh-CN.yml"),
    "message: 新版本内容\n",
  );
  const result = await publishTranslation({
    ...fixture.options,
    sourceVersion: "9.1.2",
    sourceCommit: git(fixture.maintenance, ["rev-parse", "HEAD"]),
  });
  assert.equal(result.tag, "lands-9.1.2-r1");
  assert.equal(git(fixture.remote, ["rev-parse", "main^"]), previousCommit);
  assert.equal(fixture.state.releases.length, 2);
  const expected = [
    "# 保留注释\r\nmessage: '中文'\r\n",
    "message: 新版本内容\n",
  ];
  for (const [index, release] of fixture.state.releases.entries()) {
    assert.equal(release.draft, false);
    const asset = release.assets[0];
    assert.ok(asset);
    const archiveFile = join(
      fixture.directory,
      "archive-" + String(index) + ".zip",
    );
    await writeFile(archiveFile, asset.bytes);
    const yaml = spawnSync("unzip", ["-p", archiveFile, "Locale/zh-CN.yml"], {
      encoding: "utf8",
    });
    assert.equal(yaml.status, 0, yaml.stderr);
    assert.equal(yaml.stdout, expected[index]);
  }
});
