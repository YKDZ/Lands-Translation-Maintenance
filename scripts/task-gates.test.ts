import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { inspectTaskGate } from "./task-gates.ts";

const entryCommand = "node --conditions=source scripts/task-gates.ts";
const turboCommand = [
  resolve(import.meta.dirname, "../node_modules/.bin/turbo"),
] as const;

type FixtureOverrides = {
  readonly rootScripts?: Readonly<Record<string, string>>;
  readonly sampleScripts?: Readonly<Record<string, string>>;
  readonly tasks?: Readonly<Record<string, unknown>>;
};

async function createFixture(
  context: TestContext,
  overrides: FixtureOverrides = {},
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "lands-task-gate-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "packages/sample"), { recursive: true });

  const rootScripts = {
    check: `${entryCommand} check`,
    "check:heavy": `${entryCommand} check:heavy`,
    "check:full": `${entryCommand} check:full`,
    fix: `${entryCommand} fix`,
    ...overrides.rootScripts,
  };
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify(
      {
        name: "task-gate-fixture",
        private: true,
        packageManager: "pnpm@12.9.1",
        scripts: rootScripts,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(cwd, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n',
  );
  await writeFile(
    join(cwd, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\nimporters:\n  .: {}\n  packages/sample: {}\n",
  );
  await writeFile(
    join(cwd, "turbo.json"),
    JSON.stringify({ tasks: overrides.tasks }, null, 2),
  );
  await writeFile(
    join(cwd, "packages/sample/package.json"),
    JSON.stringify({
      name: "sample",
      private: true,
      scripts: {
        verify: "node -e \"console.log('verified')\"",
        heavy: "node -e \"console.log('heavy')\"",
        ...overrides.sampleScripts,
      },
    }),
  );

  return cwd;
}

const validTasks = {
  "//#check": { tags: ["quality:entry"] },
  "//#check:heavy": { tags: ["quality:entry"] },
  "//#check:full": { tags: ["quality:entry"] },
  "//#fix": { tags: ["work:repair"] },
  "sample#verify": { tags: ["quality:light"] },
  "sample#heavy": { tags: ["quality:heavy"] },
  "//#intermediary": { dependsOn: ["sample#verify"] },
  "//#aggregate": {
    dependsOn: ["//#intermediary"],
    tags: ["quality:light"],
  },
};

void test("有效的临时任务配置通过真实 Turbo 检查", async (context) => {
  const cwd = await createFixture(context, { tasks: validTasks });
  const inspection = inspectTaskGate("check", cwd, entryCommand, turboCommand);

  assert.deepEqual(inspection.diagnostics, []);
  assert.deepEqual(
    inspection.plans[0]?.tasks.map((task) => task.fullName).sort(),
    ["//#aggregate", "sample#verify"],
  );
});

void test("职责错误、错误接线和无效依赖闭包被拒绝", async (context) => {
  const cases: readonly {
    readonly name: string;
    readonly overrides: FixtureOverrides;
    readonly expected: string;
  }[] = [
    {
      name: "缺少职责",
      overrides: { tasks: { ...validTasks, "sample#verify": {} } },
      expected: "缺少唯一职责标签",
    },
    {
      name: "未知职责",
      overrides: {
        tasks: {
          ...validTasks,
          "sample#verify": { tags: ["quality:unknown"] },
        },
      },
      expected: "使用未知职责标签 quality:unknown",
    },
    {
      name: "冲突职责",
      overrides: {
        tasks: {
          ...validTasks,
          "sample#verify": {
            tags: ["quality:light", "work:development"],
          },
        },
      },
      expected: "有多个职责标签",
    },
    {
      name: "公共命令接线错误",
      overrides: {
        rootScripts: { check: "node scripts/task-gates.ts check" },
        tasks: validTasks,
      },
      expected: "公共入口接线错误",
    },
    {
      name: "轻检查依赖重验收",
      overrides: {
        tasks: {
          ...validTasks,
          "sample#verify": {
            tags: ["quality:light"],
            dependsOn: ["sample#heavy"],
          },
        },
      },
      expected: "轻检查不能间接启动重验收",
    },
    {
      name: "职责聚合节点没有可执行工作",
      overrides: {
        tasks: { ...validTasks, "//#aggregate": { tags: ["quality:light"] } },
      },
      expected: "悬空职责标签 quality:light",
    },
    {
      name: "正式测试不能设为按需工作",
      overrides: {
        sampleScripts: { "test:verification": 'node -e ""' },
        tasks: {
          ...validTasks,
          "sample#test:verification": { tags: ["work:on-demand"] },
        },
      },
      expected: "保留验收任务，不能归入非验收职责 work:on-demand",
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async (subcontext) => {
      const cwd = await createFixture(subcontext, scenario.overrides);
      const inspection = inspectTaskGate(
        "check",
        cwd,
        entryCommand,
        turboCommand,
      );

      assert.ok(
        inspection.diagnostics.some((diagnostic) =>
          diagnostic.includes(scenario.expected),
        ),
        inspection.diagnostics.join("\n"),
      );
    });
  }
});

void test("正式 check 入口拒绝额外 CLI 参数", () => {
  const result = spawnSync("pnpm", ["run", "check", "--", "unexpected"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /用法：.*<check\|check:heavy\|check:full\|fix>/);
});
